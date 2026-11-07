import asyncio
import json
import uuid
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from app.container import Container
from app.core.config import Settings
from app.core.errors import ConflictError
from app.domain.models import ChatEvent, ErrorEvent
from app.main import create_app
from app.services.chat import CHAT_FAILED_CODE, SESSION_BUSY_CODE, SESSION_BUSY_MESSAGE

# The app does not start without its MCP servers.
pytestmark = pytest.mark.usefixtures("mcp_servers")

REJECTED_GROQ_KEY = "not-a-real-key"


def _events(body: str) -> list[tuple[str, dict[str, object]]]:
    events = []
    for block in body.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in fields:
            events.append((fields["event"], json.loads(fields["data"])))
    return events


QUESTION = "What is the capital of France? Answer in one word."
USAGE_SQL = "SELECT model_id, input_tokens, output_tokens FROM turn_usage"
type RunSql = Callable[[str], list[tuple[object, ...]]]


def test_chat_streams_answer_records_usage_and_titles_session(
    migrated_database_url: str, ollama_base_url: str, groq_api_key: str, run_sql: RunSql
) -> None:
    settings = Settings(
        database_url=migrated_database_url,
        ollama_base_url=ollama_base_url,
        groq_api_key=groq_api_key,
        log_json=False,
    )
    with TestClient(create_app(settings)) as client:
        session_id = client.post("/sessions", json={}).json()["id"]
        response = client.post(
            f"/sessions/{session_id}/messages",
            json={"text": QUESTION},
        )
        title = client.get(f"/sessions/{session_id}").json()["title"]

    assert response.status_code == 200
    events = _events(response.text)
    answer = "".join(str(data["text"]) for name, data in events if name == "token")
    assert "paris" in answer.lower()
    done_name, done = events[-1]
    assert done_name == "done"
    assert isinstance(done["output_tokens"], int)
    assert done["output_tokens"] > 0
    assert run_sql(USAGE_SQL) == [("qwen3.8-27b", done["input_tokens"], done["output_tokens"])]
    assert title == QUESTION


def test_chat_emits_error_event_when_the_model_call_fails(
    migrated_database_url: str, run_sql: RunSql
) -> None:
    settings = Settings(
        database_url=migrated_database_url, groq_api_key=REJECTED_GROQ_KEY, log_json=False
    )
    with TestClient(create_app(settings)) as client:
        session_id = client.post("/sessions", json={}).json()["id"]
        response = client.post(f"/sessions/{session_id}/messages", json={"text": "Hello"})

    assert response.status_code == 200
    assert [name for name, _ in _events(response.text)] == ["error"]
    assert run_sql(USAGE_SQL) == []


def test_chat_rejects_an_unknown_model_before_streaming(migrated_database_url: str) -> None:
    with TestClient(create_app(Settings(database_url=migrated_database_url))) as client:
        session_id = client.post("/sessions", json={}).json()["id"]
        response = client.post(
            f"/sessions/{session_id}/messages", json={"text": "Hi", "model_id": "nope"}
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unknown_model"


def test_chat_uses_the_default_and_the_selected_model(
    migrated_database_url: str,
    ollama_base_url: str,
    google_api_key: str,
    groq_api_key: str,
    run_sql: RunSql,
) -> None:
    settings = Settings(
        database_url=migrated_database_url,
        ollama_base_url=ollama_base_url,
        google_api_key=google_api_key,
        groq_api_key=groq_api_key,
        log_json=False,
    )
    with TestClient(create_app(settings)) as client:
        session_id = client.post("/sessions", json={}).json()["id"]
        default = client.post(f"/sessions/{session_id}/messages", json={"text": QUESTION})
        chosen = client.post(
            f"/sessions/{session_id}/messages",
            json={"text": QUESTION, "model_id": "qwen3.8-27b"},
        )

    assert [name for name, _ in _events(default.text)][-1] == "done"
    assert [name for name, _ in _events(chosen.text)][-1] == "done"
    assert [row[0] for row in run_sql("SELECT model_id FROM turn_usage ORDER BY created_at")] == [
        "gemini-3.5-flash-lite",
        "qwen3.8-27b",
    ]


def test_chat_rejects_unknown_session_and_empty_message(migrated_database_url: str) -> None:
    with TestClient(create_app(Settings(database_url=migrated_database_url))) as client:
        unknown = client.post(f"/sessions/{uuid.uuid4()}/messages", json={"text": "Hi"})
        session_id = client.post("/sessions", json={}).json()["id"]
        empty = client.post(f"/sessions/{session_id}/messages", json={"text": "  "})

    assert unknown.status_code == 404
    assert empty.status_code == 422


CHECKPOINTS_SQL = "SELECT count(*) FROM checkpoints WHERE thread_id = '{session_id}'"


def test_a_failed_turn_leaves_an_error_reply_in_history_and_delete_removes_the_thread(
    migrated_database_url: str, run_sql: RunSql
) -> None:
    settings = Settings(
        database_url=migrated_database_url, groq_api_key=REJECTED_GROQ_KEY, log_json=False
    )
    with TestClient(create_app(settings)) as client:
        session_id = client.post("/sessions", json={}).json()["id"]
        client.post(f"/sessions/{session_id}/messages", json={"text": "Hello"})
        history = client.get(f"/sessions/{session_id}/messages").json()
        assert [(t["role"], t.get("text")) for t in history] == [
            ("user", "Hello"),
            ("assistant", ""),
        ]
        assert history[1]["error"]
        assert run_sql(CHECKPOINTS_SQL.format(session_id=session_id)) != [(0,)]

        assert client.delete(f"/sessions/{session_id}").status_code == 204

    assert run_sql(CHECKPOINTS_SQL.format(session_id=session_id)) == [(0,)]


def test_a_follow_up_resolves_against_the_earlier_turn(
    migrated_database_url: str, ollama_base_url: str, groq_api_key: str
) -> None:
    settings = Settings(
        database_url=migrated_database_url,
        ollama_base_url=ollama_base_url,
        groq_api_key=groq_api_key,
        log_json=False,
    )
    with TestClient(create_app(settings)) as client:
        session_id = client.post("/sessions", json={}).json()["id"]
        client.post(f"/sessions/{session_id}/messages", json={"text": QUESTION})
        follow_up = client.post(
            f"/sessions/{session_id}/messages",
            json={"text": "Which country is that the capital of? Answer in one word."},
        )
        history = client.get(f"/sessions/{session_id}/messages").json()

    answer = "".join(str(d["text"]) for name, d in _events(follow_up.text) if name == "token")
    assert "france" in answer.lower()
    assert [t["role"] for t in history] == ["user", "assistant", "user", "assistant"]


def test_a_second_send_to_a_busy_session_is_rejected_and_delete_waits(
    migrated_database_url: str,
) -> None:
    settings = Settings(
        database_url=migrated_database_url, groq_api_key=REJECTED_GROQ_KEY, log_json=False
    )
    with TestClient(create_app(settings)) as client:
        session_id = client.post("/sessions", json={}).json()["id"]
        container: Container = client.app.state.container  # type: ignore[attr-defined]
        chat = container.chat
        model_id = chat.resolve_model_id(None)

        async def race() -> tuple[list[ChatEvent], bool]:
            session = await container.sessions.get(uuid.UUID(session_id))
            first = chat.stream(session, "Hello", model_id)
            # One loop step runs the first stream up to its first database await, holding the lock.
            pending = asyncio.ensure_future(anext(first))
            await asyncio.sleep(0)
            second = [event async for event in chat.stream(session, "Hello", model_id)]
            try:
                await chat.delete_history(session)
                delete_refused = False
            except ConflictError:
                delete_refused = True
            await pending
            async for _ in first:  # finish the turn, which releases the lock
                pass
            return second, delete_refused

        second, delete_refused = client.portal.call(race)  # type: ignore[union-attr]
        after = client.post(f"/sessions/{session_id}/messages", json={"text": "Hello"})

    assert second == [ErrorEvent(code=SESSION_BUSY_CODE, message=SESSION_BUSY_MESSAGE)]
    assert delete_refused
    # The lock was released: the next send runs (and fails on the rejected key, not as busy).
    assert [data["code"] for _, data in _events(after.text)] == [CHAT_FAILED_CODE]

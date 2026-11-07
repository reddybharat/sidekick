import hashlib
import json
import uuid
from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient

from app.container import Container
from app.core.config import Settings
from app.main import create_app
from app.services.documents import INTERRUPTED_MESSAGE

SAMPLE_PDF = Path(__file__).parents[1] / "fixtures" / "sample.pdf"
PDF_TYPE = "application/pdf"
TINY_UPLOAD_LIMIT = 100
INSERT_DOCUMENT_SQL = (
    "INSERT INTO documents (id, owner_id, filename, sha256, embedding_model, status) "
    "VALUES ('{id}', 'local', '{filename}', '{sha256}', 'any-model', '{status}')"
)
type RunSql = Callable[[str], list[tuple[object, ...]]]


def _events(body: str) -> list[tuple[str, dict[str, object]]]:
    events = []
    for block in body.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in fields:
            events.append((fields["event"], json.loads(fields["data"])))
    return events


def test_upload_ingests_pdf_and_rejects_duplicates(
    migrated_database_url: str, ollama_base_url: str, run_sql: RunSql
) -> None:
    settings = Settings(
        database_url=migrated_database_url, ollama_base_url=ollama_base_url, log_json=False
    )
    data = SAMPLE_PDF.read_bytes()
    with TestClient(create_app(settings)) as client:
        created = client.post("/documents", files={"file": ("sample.pdf", data, PDF_TYPE)})
        # TestClient returns after background tasks finish, so ingestion is done here.
        listed = client.get("/documents").json()
        duplicate = client.post("/documents", files={"file": ("copy.pdf", data, PDF_TYPE)})

    assert created.status_code == 202
    assert created.json()["status"] == "pending"
    assert [(d["filename"], d["status"], d["page_count"]) for d in listed] == [
        ("sample.pdf", "ready", 4)
    ]
    assert duplicate.status_code == 409
    pages = run_sql("SELECT DISTINCT page FROM chunks ORDER BY page")
    assert pages == [(1,), (2,), (3,), (4,)]


def test_upload_rejects_non_pdf_and_oversized_files(migrated_database_url: str) -> None:
    settings = Settings(database_url=migrated_database_url, max_upload_bytes=TINY_UPLOAD_LIMIT)
    with TestClient(create_app(settings)) as client:
        not_pdf = client.post(
            "/documents",
            files={"file": ("notes.pdf", b"plain text", PDF_TYPE)},
        )
        too_big = client.post(
            "/documents",
            files={"file": ("big.pdf", SAMPLE_PDF.read_bytes(), PDF_TYPE)},
        )

    assert (not_pdf.status_code, not_pdf.json()["error"]["code"]) == (422, "invalid_document")
    assert too_big.status_code == 413


def test_unreadable_pdf_is_marked_failed(migrated_database_url: str) -> None:
    with TestClient(create_app(Settings(database_url=migrated_database_url))) as client:
        client.post(
            "/documents",
            files={"file": ("broken.pdf", b"%PDF-1.4 garbage", PDF_TYPE)},
        )
        [document] = client.get("/documents").json()

    assert document["status"] == "failed"
    assert document["error"]


def test_chat_answers_from_document_with_page_citation(
    migrated_database_url: str, ollama_base_url: str, google_api_key: str
) -> None:
    # Gemini answers: the local 4B model does not reliably read a skill before searching.
    settings = Settings(
        database_url=migrated_database_url,
        ollama_base_url=ollama_base_url,
        google_api_key=google_api_key,
        log_json=False,
    )
    with TestClient(create_app(settings)) as client:
        client.post(
            "/documents",
            files={"file": ("sample.pdf", SAMPLE_PDF.read_bytes(), PDF_TYPE)},
        )
        session_id = client.post("/sessions", json={}).json()["id"]
        response = client.post(
            f"/sessions/{session_id}/messages",
            json={"text": "What is the total budget for phase two of Project Halcyon?"},
        )

    events = _events(response.text)
    tool_starts = [data["name"] for name, data in events if name == "tool_start"]
    answer = "".join(str(data["text"]) for name, data in events if name == "token")
    assert "retrieve_from_documents" in tool_starts
    assert "4.2" in answer
    assert "p. 3" in answer or "page 3" in answer.lower()
    assert events[-1][0] == "done"


def test_search_finds_the_right_page_without_context_from_other_pages(
    migrated_database_url: str, ollama_base_url: str
) -> None:
    settings = Settings(
        database_url=migrated_database_url, ollama_base_url=ollama_base_url, log_json=False
    )
    with TestClient(create_app(settings)) as client:
        client.post(
            "/documents",
            files={"file": ("sample.pdf", SAMPLE_PDF.read_bytes(), PDF_TYPE)},
        )
        container: Container = client.app.state.container  # type: ignore[attr-defined]
        hits = client.portal.call(  # type: ignore[union-attr]
            container.documents.search,
            "local",
            "When was the cooperative founded?",
            1,
        )
        other_owner_hits = client.portal.call(  # type: ignore[union-attr]
            container.documents.search, "someone-else", "When was the cooperative founded?", 1
        )

    [hit] = hits
    assert other_owner_hits == []
    assert hit.page == 1
    assert "2011" in hit.content
    # Every sample page is a single chunk, so neighbours are on other pages and must be dropped.
    assert hit.context_before == hit.context_after == ""


def test_delete_removes_document_and_its_chunks(
    migrated_database_url: str, ollama_base_url: str, run_sql: RunSql
) -> None:
    settings = Settings(
        database_url=migrated_database_url, ollama_base_url=ollama_base_url, log_json=False
    )
    with TestClient(create_app(settings)) as client:
        document_id = client.post(
            "/documents", files={"file": ("sample.pdf", SAMPLE_PDF.read_bytes(), PDF_TYPE)}
        ).json()["id"]
        chunks_before = run_sql("SELECT count(*) FROM chunks")
        deleted = client.delete(f"/documents/{document_id}")
        again = client.delete(f"/documents/{document_id}")
        remaining = client.get("/documents").json()

    assert chunks_before != [(0,)]
    assert deleted.status_code == 204
    assert again.status_code == 404
    assert remaining == []
    assert run_sql("SELECT count(*) FROM chunks") == [(0,)]
    assert run_sql("SELECT count(*) FROM document_files") == [(0,)]


def test_upload_keeps_the_original_and_serves_it_to_its_owner_only(
    migrated_database_url: str,
) -> None:
    data = SAMPLE_PDF.read_bytes()
    with TestClient(create_app(Settings(database_url=migrated_database_url))) as client:
        document_id = client.post(
            "/documents", files={"file": ("sample.pdf", data, PDF_TYPE)}
        ).json()["id"]
        [listed] = client.get("/documents").json()
        original = client.get(f"/documents/{document_id}/file")
        unknown = client.get(f"/documents/{uuid.uuid4()}/file")
    other_owner = Settings(database_url=migrated_database_url, default_owner_id="someone-else")
    with TestClient(create_app(other_owner)) as client:
        foreign = client.get(f"/documents/{document_id}/file")

    assert listed["has_file"] is True
    assert original.status_code == 200
    assert original.headers["content-type"] == PDF_TYPE
    assert original.headers["content-disposition"] == "inline; filename*=UTF-8''sample.pdf"
    assert original.content == data
    assert unknown.status_code == 404
    assert foreign.status_code == 404


def test_a_document_uploaded_before_originals_were_kept_cannot_be_opened(
    migrated_database_url: str, run_sql: RunSql
) -> None:
    document_id = uuid.uuid4()
    run_sql(
        INSERT_DOCUMENT_SQL.format(
            id=document_id, filename="old.pdf", sha256="0" * 64, status="failed"
        )
    )
    with TestClient(create_app(Settings(database_url=migrated_database_url))) as client:
        [listed] = client.get("/documents").json()
        original = client.get(f"/documents/{document_id}/file")

    assert listed["has_file"] is False
    assert original.status_code == 404


def test_startup_fails_interrupted_ingestion_and_the_pdf_can_be_uploaded_again(
    migrated_database_url: str, run_sql: RunSql
) -> None:
    data = SAMPLE_PDF.read_bytes()
    interrupted_id = uuid.uuid4()
    run_sql(
        INSERT_DOCUMENT_SQL.format(
            id=interrupted_id,
            filename="sample.pdf",
            sha256=hashlib.sha256(data).hexdigest(),
            status="pending",
        )
    )
    with TestClient(create_app(Settings(database_url=migrated_database_url))) as client:
        [interrupted] = client.get("/documents").json()
        again = client.post("/documents", files={"file": ("sample.pdf", data, PDF_TYPE)})
        listed = client.get("/documents").json()

    assert (interrupted["status"], interrupted["error"]) == ("failed", INTERRUPTED_MESSAGE)
    assert again.status_code == 202
    assert again.json()["id"] != str(interrupted_id)
    assert [d["id"] for d in listed] == [again.json()["id"]]


def test_library_is_cross_origin_readable_from_the_dev_frontend(
    migrated_database_url: str,
) -> None:
    origin = "http://localhost:5173"
    with TestClient(create_app(Settings(database_url=migrated_database_url))) as client:
        response = client.get("/documents", headers={"Origin": origin})

    assert response.headers["access-control-allow-origin"] == origin

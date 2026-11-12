"""Answer-quality evals: the real agent answers questions about `tests/fixtures/sample.pdf` on the
default catalog model, scored without a judge model. Deselected by default because they spend model
quota; run with `uv run pytest -m eval -s`. With Langfuse keys set, each question's session also
gets its scores in Langfuse."""

import re
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agent.tools import RETRIEVE_FROM_DOCUMENTS
from app.container import Container
from app.core.config import Settings
from app.domain.models import TokenEvent, ToolStartEvent
from app.main import create_app

pytestmark = [pytest.mark.eval, pytest.mark.usefixtures("mcp_servers")]

SAMPLE_PDF = Path(__file__).parents[1] / "fixtures" / "sample.pdf"
SAMPLE_NAME = "sample.pdf"
PDF_TYPE = "application/pdf"
# Same pattern as frontend/src/lib/citations.ts: "(file.pdf, p. 3)", "(file.pdf, pp. 2-3)".
CITATION = re.compile(
    r"\(\s*`?([^()`\[\]]+?\.pdf)`?\s*,\s*pp?\.\s*(\d+(?:\s*[-\u2013,]\s*\d+)*)\s*\)", re.IGNORECASE
)


@dataclass(frozen=True)
class Case:
    question: str
    page: int
    fact: str  # lowercase, without thousands separators


# Few cases on purpose: a document question costs about 3 model calls of the free-tier quota.
CASES = [
    Case("When was the Ostrava Water Cooperative founded?", 1, "2011"),
    Case("How much water does the Kessel Bay plant produce per day?", 2, "1840"),
    Case("What is the total budget for phase two of Project Halcyon?", 3, "4.2"),
    Case("How much of the phase two budget goes to the solar array?", 3, "0.9"),
    Case("Who is the lead engineer of Project Halcyon?", 4, "vantongeren"),
]


def _cited_pages(answer: str) -> set[int]:
    return {
        int(page)
        for file, pages in CITATION.findall(answer)
        if file.strip().lower() == SAMPLE_NAME
        for page in re.findall(r"\d+", pages)
    }


def _scores(case: Case, tools: list[str], answer: str) -> dict[str, bool]:
    cited = _cited_pages(answer)
    return {
        "searched": RETRIEVE_FROM_DOCUMENTS in tools,
        "fact_in_answer": case.fact in answer.lower().replace(",", ""),
        "cited_expected_page": case.page in cited,
        "cited_only_expected_page": cited == {case.page},
    }


def test_document_answers(
    migrated_database_url: str, ollama_base_url: str, google_api_key: str, langfuse_tracing: bool
) -> None:
    settings = Settings(
        database_url=migrated_database_url,
        ollama_base_url=ollama_base_url,
        google_api_key=google_api_key,
        log_json=False,
    )
    with TestClient(create_app(settings)) as client:
        client.post("/documents", files={"file": (SAMPLE_NAME, SAMPLE_PDF.read_bytes(), PDF_TYPE)})
        container: Container = client.app.state.container  # type: ignore[attr-defined]
        model_id = container.chat.resolve_model_id(None)

        async def ask(session_id: str, question: str) -> tuple[list[str], str]:
            session = await container.sessions.get(uuid.UUID(session_id))
            tools: list[str] = []
            answer: list[str] = []
            async for event in container.chat.stream(session, question, model_id):
                if isinstance(event, ToolStartEvent):
                    tools.append(event.name)
                elif isinstance(event, TokenEvent):
                    answer.append(event.text)
            return tools, "".join(answer)

        results: list[tuple[Case, dict[str, bool]]] = []
        for case in CASES:
            # A session per question, so no answer leans on an earlier one.
            session_id = client.post("/sessions", json={}).json()["id"]
            tools, answer = client.portal.call(ask, session_id, case.question)  # type: ignore[union-attr]
            scores = _scores(case, tools, answer)
            results.append((case, scores))
            if langfuse_tracing and container.langfuse is not None:
                for name, ok in scores.items():
                    container.langfuse.create_score(
                        session_id=session_id, name=name, value=float(ok), data_type="BOOLEAN"
                    )

    print(f"\nEvals on {model_id}")
    for name in results[0][1]:
        passed = sum(scores[name] for _, scores in results)
        print(f"  {name:<26} {passed}/{len(results)}")
    failures = [
        (case.question, name) for case, scores in results for name, ok in scores.items() if not ok
    ]
    assert failures == []

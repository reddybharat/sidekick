import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.tools import BaseTool
from langgraph.checkpoint.memory import InMemorySaver

from app.agent.agent_builder import build_agent
from app.agent.skill_loader import SKILLS_PLACEHOLDER, load_skills
from app.agent.tools import make_retrieve_from_documents
from app.domain.models import ChunkHit

HISTORY_MAX_TURNS = 5


async def _no_hits(owner_id: str, query: str, limit: int) -> list[ChunkHit]:
    return []


def _build(tools: list[BaseTool]) -> None:
    # The model and saver are inert constructor arguments: the checks run before either is used.
    build_agent(
        GenericFakeChatModel(messages=iter([])),
        SKILLS_PLACEHOLDER,
        load_skills(),
        tools,
        InMemorySaver(),
        HISTORY_MAX_TURNS,
    )


def test_duplicate_tool_names_are_rejected() -> None:
    retrieve = make_retrieve_from_documents(_no_hits)

    with pytest.raises(ValueError, match="duplicate tool names: \\['retrieve_from_documents'\\]"):
        _build([retrieve, retrieve])


def test_skills_naming_missing_tools_are_rejected() -> None:
    with pytest.raises(ValueError, match="unknown tools: \\['get_weather', 'web_search'\\]"):
        _build([make_retrieve_from_documents(_no_hits)])

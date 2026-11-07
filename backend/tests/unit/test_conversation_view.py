from typing import Any

from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolCall, ToolMessage

from app.agent.middleware.conversation_view import ConversationView
from app.agent.state import ERROR_CODE_KEY, AgentContext

SEARCH_CALL = ToolCall(name="retrieve_from_documents", args={"query": "q"}, id="1")


def _answered(question: str, answer: str) -> list[AnyMessage]:
    """A finished turn as the checkpoint holds it: tool traffic included."""
    return [
        HumanMessage(question),
        AIMessage("", tool_calls=[SEARCH_CALL]),
        ToolMessage("[a.pdf, page 1] long passage", tool_call_id="1", name=SEARCH_CALL["name"]),
        AIMessage(answer),
    ]


def _failed(question: str) -> list[AnyMessage]:
    return [
        HumanMessage(question),
        AIMessage("It failed.", additional_kwargs={ERROR_CODE_KEY: "chat_failed"}),
    ]


async def _view(messages: list[AnyMessage], max_turns: int) -> list[str]:
    seen: list[ModelRequest[AgentContext]] = []

    async def handler(request: ModelRequest[AgentContext]) -> ModelResponse[Any]:
        seen.append(request)
        return ModelResponse(result=[AIMessage("ok")])

    request: ModelRequest[AgentContext] = ModelRequest(
        # The model is never called: the handler stands in for it.
        model=GenericFakeChatModel(messages=iter([])),
        messages=messages,
        state={"messages": messages},
    )
    await ConversationView(max_turns).awrap_model_call(request, handler)
    return [str(m.content) for m in seen[0].messages]


async def test_earlier_turns_shrink_to_question_and_answer_and_the_current_turn_stays_whole() -> (
    None
):
    current: list[AnyMessage] = [HumanMessage("q2"), AIMessage("", tool_calls=[SEARCH_CALL])]
    view = await _view([*_answered("q1", "a1"), *current], max_turns=5)

    assert view == ["q1", "a1", "q2", ""]


async def test_failed_turns_and_error_replies_are_hidden_from_the_model() -> None:
    messages = [*_failed("q1"), *_answered("q2", "a2"), HumanMessage("q3")]

    assert await _view(messages, max_turns=5) == ["q2", "a2", "q3"]


async def test_an_earlier_turn_without_an_answer_is_dropped() -> None:
    interrupted: list[AnyMessage] = [HumanMessage("q1"), AIMessage("", tool_calls=[SEARCH_CALL])]

    assert await _view([*interrupted, HumanMessage("q2")], max_turns=5) == ["q2"]


async def test_only_the_last_max_turns_earlier_turns_are_kept() -> None:
    messages = [*_answered("q1", "a1"), *_answered("q2", "a2"), HumanMessage("q3")]

    assert await _view(messages, max_turns=1) == ["q2", "a2", "q3"]
    assert await _view(messages, max_turns=0) == ["q3"]

"""ConversationView: the model sees recent earlier questions and answers, never old tool traffic."""

from collections.abc import Awaitable, Callable
from typing import Any

import structlog
from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, AnyMessage

from app.agent.state import ERROR_CODE_KEY, AgentContext, split_turns

log = structlog.get_logger()


def _compact(turn: list[AnyMessage]) -> list[AnyMessage] | None:
    """The question and the final answer text, or None when the turn has no usable answer."""
    answer = turn[-1]
    if (
        not isinstance(answer, AIMessage)
        or answer.tool_calls
        or answer.additional_kwargs.get(ERROR_CODE_KEY)
        or not answer.text
    ):
        return None
    return [turn[0], AIMessage(answer.text)]


class ConversationView(AgentMiddleware[AgentState[Any], AgentContext, Any]):
    """Replaces `request.messages` for the model call only; the checkpoint keeps everything."""

    def __init__(self, max_turns: int) -> None:
        super().__init__()
        self._max_turns = max_turns

    async def awrap_model_call(
        self,
        request: ModelRequest[AgentContext],
        handler: Callable[[ModelRequest[AgentContext]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        *earlier, current = split_turns(request.messages)
        compact = [t for t in map(_compact, earlier) if t]
        # shortcut: older turns are simply forgotten; add summarization if long threads matter.
        recent = compact[max(len(compact) - self._max_turns, 0) :]
        messages = [m for turn in recent for m in turn] + current
        log.debug(
            "history_view",
            prior_turns=len(recent),
            messages_in=len(request.messages),
            messages_out=len(messages),
        )
        return await handler(request.override(messages=messages))

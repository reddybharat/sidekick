import asyncio
import time
import weakref
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any, cast

import structlog
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    AnyMessage,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver

from app.agent.agent_builder import Agent
from app.agent.state import ERROR_CODE_KEY, AgentContext, split_turns
from app.agent.tools import READ_SKILL_FILE
from app.core.errors import ConflictError, UnknownModelError
from app.domain.models import (
    ChatEvent,
    DoneEvent,
    ErrorEvent,
    HistoryTurn,
    Session,
    TokenEvent,
    ToolEndEvent,
    ToolStartEvent,
    ToolStep,
    TurnUsage,
)
from app.domain.ports import UnitOfWork
from app.services.sessions import SessionService

log = structlog.get_logger()

MS_PER_S = 1000
TOOL_LIMIT_PREFIX = "Tool call limit exceeded"
SKILL_FILE_SUFFIX = "/SKILL.md"
# The model node of the agent graph; a failed turn's reply is saved as if the model wrote it.
MODEL_NODE = "model"
CHAT_FAILED_CODE = "chat_failed"
CHAT_FAILED_MESSAGE = "The model failed to answer. Try again."
SESSION_BUSY_CODE = "session_busy"
SESSION_BUSY_MESSAGE = (
    "This chat is answering in another tab. Wait for it to finish, then send again."
)
SESSION_ANSWERING_MESSAGE = "This chat is still answering. Try again when it finishes."


class ChatService:
    """Answers a turn on the session's checkpointed thread; `ConversationView` limits what the
    model sees of earlier turns."""

    def __init__(
        self,
        uow: Callable[[], UnitOfWork],
        agents: Mapping[str, Agent],
        sessions: SessionService,
        checkpointer: BaseCheckpointSaver[Any],
    ) -> None:
        self._uow = uow
        self._agents = agents
        self._checkpointer = checkpointer
        self._default_model_id = next(iter(agents))
        self._sessions = sessions
        # One turn at a time per session: concurrent turns would interleave on one checkpoint
        # thread. An entry lives only while a stream holds its lock.
        # shortcut: per-process lock, enough for one owner and one API process; several workers →
        # Postgres advisory lock.
        self._busy: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()

    def resolve_model_id(self, model_id: str | None) -> str:
        """The requested model, or the default (the catalog's first); unknown ids are rejected."""
        if model_id is None:
            return self._default_model_id
        if model_id not in self._agents:
            raise UnknownModelError(f"Unknown model {model_id!r}")
        return model_id

    async def history(self, session: Session) -> list[HistoryTurn]:
        """The session's turns as the chat shows them, from the checkpoint."""
        state = await self._agents[self._default_model_id].aget_state(_thread_config(session))
        return [
            entry
            for turn in split_turns(state.values.get("messages", []))
            for entry in _history_entries(turn)
        ]

    async def delete_history(self, session: Session) -> None:
        """Refused while a turn is streaming, which would keep writing to the deleted thread."""
        lock = self._busy.get(str(session.id))
        if lock is not None and lock.locked():
            raise ConflictError(SESSION_ANSWERING_MESSAGE)
        await self._checkpointer.adelete_thread(str(session.id))

    async def stream(self, session: Session, text: str, model_id: str) -> AsyncIterator[ChatEvent]:
        sid = str(session.id)
        lock = self._busy.setdefault(sid, asyncio.Lock())
        if lock.locked():
            log.warning(
                "turn_rejected",
                session_id=sid,
                owner_id=session.owner_id,
                reason=SESSION_BUSY_CODE,
            )
            yield ErrorEvent(code=SESSION_BUSY_CODE, message=SESSION_BUSY_MESSAGE)
            return
        # An uncontended acquire does not yield, so the check above and this acquire are atomic.
        async with lock:
            started = time.perf_counter()
            turn_log = log.bind(session_id=sid, owner_id=session.owner_id)
            agent = self._agents[model_id]
            config = _thread_config(session)
            tool_started: dict[str, float] = {}
            input_tokens = output_tokens = 0
            try:
                prior_turns = sum(t.role == "user" for t in await self.history(session))
                turn_log.info(
                    "turn_started",
                    model_id=model_id,
                    message_chars=len(text),
                    prior_turns=prior_turns,
                )
                # "messages" streams model tokens; "updates" yields each finished node's messages,
                # which is where complete tool calls and tool results appear.
                async for mode, payload in agent.astream(
                    {"messages": [HumanMessage(text)]},
                    config,
                    stream_mode=["messages", "updates"],
                    context=AgentContext(owner_id=session.owner_id),
                ):
                    if mode == "updates":
                        for event in _tool_events(cast(dict[str, Any], payload)):
                            _log_tool_event(turn_log, event, tool_started)
                            yield event
                        continue
                    chunk, _ = cast(tuple[BaseMessage, dict[str, Any]], payload)
                    if not isinstance(chunk, AIMessageChunk):
                        continue
                    if chunk.usage_metadata:
                        input_tokens += chunk.usage_metadata["input_tokens"]
                        output_tokens += chunk.usage_metadata["output_tokens"]
                    # `.text` holds answer text only; thinking arrives as reasoning content.
                    if chunk.text:
                        yield TokenEvent(text=chunk.text)
            except Exception:
                turn_log.exception("turn_failed")
                await self._save_error_reply(agent, config, turn_log)
                yield ErrorEvent(code=CHAT_FAILED_CODE, message=CHAT_FAILED_MESSAGE)
                return

            usage = TurnUsage(
                session_id=session.id,
                model_id=model_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                latency_ms=round((time.perf_counter() - started) * MS_PER_S),
            )
            async with self._uow() as uow:
                await uow.usage.add(usage)
                await uow.commit()
            await self._sessions.title_from_message(session, text)
            turn_log.info(
                "turn_done",
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                latency_ms=usage.latency_ms,
            )
            yield DoneEvent(
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                latency_ms=usage.latency_ms,
            )

    @staticmethod
    async def _save_error_reply(
        agent: Agent, config: RunnableConfig, turn_log: structlog.typing.FilteringBoundLogger
    ) -> None:
        """Gives the failed turn a reply in history. If this fails too, the turn just has none."""
        reply = AIMessage(CHAT_FAILED_MESSAGE, additional_kwargs={ERROR_CODE_KEY: CHAT_FAILED_CODE})
        try:
            await agent.aupdate_state(config, {"messages": [reply]}, as_node=MODEL_NODE)
        except Exception:
            turn_log.exception("history_error_save_failed")


def _thread_config(session: Session) -> RunnableConfig:
    return {"configurable": {"thread_id": str(session.id)}}


def _history_entries(turn: list[AnyMessage]) -> list[HistoryTurn]:
    """A user entry, plus an assistant entry when the agent produced anything."""
    question, *rest = turn
    entries = [HistoryTurn(id=str(question.id), role="user", text=question.text)]
    answer_id: str | None = None
    text, error = "", None
    tools: dict[str, ToolStep] = {}
    skills: list[str] = []
    for message in rest:
        if isinstance(message, AIMessage):
            answer_id = answer_id or str(message.id)
            if message.additional_kwargs.get(ERROR_CODE_KEY):
                error = message.text
            else:
                text += message.text
            for call in message.tool_calls:
                call_id = call["id"] or ""
                tools[call_id] = ToolStep(id=call_id, name=call["name"], ok=False)
                skill = str(call["args"].get("path", "")).strip().removesuffix(SKILL_FILE_SUFFIX)
                if call["name"] == READ_SKILL_FILE and skill and skill not in skills:
                    skills.append(skill)
        elif isinstance(message, ToolMessage) and message.tool_call_id in tools:
            tools[message.tool_call_id].ok = message.status != "error"
    if answer_id:
        entries.append(
            HistoryTurn(
                id=answer_id,
                role="assistant",
                text=text,
                tools=list(tools.values()),
                skills=skills,
                error=error,
            )
        )
    return entries


def _log_tool_event(
    turn_log: structlog.typing.FilteringBoundLogger, event: ChatEvent, started: dict[str, float]
) -> None:
    if isinstance(event, ToolStartEvent):
        started[event.id] = time.perf_counter()
        turn_log.info("tool_start", tool=event.name, tool_call_id=event.id)
    elif isinstance(event, ToolEndEvent):
        begun = started.pop(event.id, None)
        duration_ms = None if begun is None else round((time.perf_counter() - begun) * MS_PER_S)
        emit = turn_log.info if event.ok else turn_log.warning
        emit(
            "tool_end", tool=event.name, tool_call_id=event.id, ok=event.ok, duration_ms=duration_ms
        )


def _tool_events(updates: dict[str, Any]) -> list[ChatEvent]:
    events: list[ChatEvent] = []
    for update in updates.values():
        # Middleware nodes may report `None` instead of a state update.
        if not isinstance(update, dict):
            continue
        for message in update.get("messages", []):
            if isinstance(message, AIMessage):
                events += [
                    ToolStartEvent(id=call["id"] or "", name=call["name"], args=call["args"])
                    for call in message.tool_calls
                ]
            elif isinstance(message, ToolMessage):
                if str(message.content).startswith(TOOL_LIMIT_PREFIX):
                    log.warning("tool_limit_reached", tool=message.name)
                events.append(
                    ToolEndEvent(
                        id=message.tool_call_id,
                        name=message.name or "",
                        ok=message.status != "error",
                    )
                )
    return events

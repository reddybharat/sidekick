import asyncio
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Self

import httpx
from langchain_core.callbacks import BaseCallbackHandler
from langfuse import Langfuse
from langfuse.langchain import CallbackHandler
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool
from sqlalchemy.ext.asyncio import AsyncEngine

from app.agent.agent_builder import build_agent
from app.agent.skill_loader import load_skills
from app.agent.tools import make_retrieve_from_documents
from app.core.config import Settings
from app.domain.ports import ChatModelProvider, Embedder
from app.infra.db.engine import build_engine, build_session_factory
from app.infra.db.unit_of_work import SqlUnitOfWork
from app.infra.embeddings.ollama import OllamaEmbedder
from app.infra.llm import gemini, groq
from app.infra.llm.model_factory import ModelFactory
from app.infra.mcp.client import load_mcp_tools
from app.infra.rag.chunkers import split_words
from app.infra.rag.pdf_loader import load_pdf_pages
from app.services.chat import ChatService
from app.services.documents import DocumentService
from app.services.sessions import SessionService

# The saver needs autocommit, no prepared statements (pooler-safe) and dict rows.
CHECKPOINT_CONNECTION_KWARGS = {"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row}
PROMPTS_DIR = Path(__file__).parent / "agent" / "prompts"


def _prompt(name: str) -> str:
    return (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")


@dataclass
class Container:
    """Composition root: the only place concrete adapters are constructed."""

    settings: Settings
    engine: AsyncEngine
    checkpoint_pool: AsyncConnectionPool[AsyncConnection[DictRow]]
    ollama_http: httpx.AsyncClient
    model_factory: ModelFactory
    embedder: Embedder
    sessions: SessionService
    documents: DocumentService
    chat: ChatService
    langfuse: Langfuse | None

    @classmethod
    async def build(cls, settings: Settings) -> Self:
        # First, so an unavailable MCP server fails startup before any pool is opened.
        mcp_tools = await load_mcp_tools(
            settings.mcp_servers, settings.mcp_api_key, settings.mcp_timeout_s
        )
        engine = build_engine(settings.database_url)
        checkpoint_pool: AsyncConnectionPool[AsyncConnection[DictRow]] = AsyncConnectionPool(
            settings.checkpoint_database_url, kwargs=CHECKPOINT_CONNECTION_KWARGS, open=False
        )
        await checkpoint_pool.open()
        # Idempotent; the checkpoint tables belong to the saver, not to Alembic.
        checkpointer = AsyncPostgresSaver(checkpoint_pool)
        await checkpointer.setup()
        uow = partial(SqlUnitOfWork, build_session_factory(engine))
        providers: dict[str, ChatModelProvider] = {}
        if settings.google_api_key:
            providers[gemini.PROVIDER_NAME] = gemini.GeminiChatProvider(
                settings.google_api_key, settings.llm_timeout_s
            )
        if settings.groq_api_key:
            providers[groq.PROVIDER_NAME] = groq.GroqChatProvider(
                settings.groq_api_key, settings.llm_timeout_s
            )
        model_factory = ModelFactory.from_yaml(settings.models_config_path, providers)
        sessions = SessionService(uow, settings.default_owner_id)
        embedder = OllamaEmbedder(
            settings.ollama_base_url,
            settings.embedding_model,
            settings.embedding_dim,
            settings.llm_timeout_s,
        )
        documents = DocumentService(
            uow,
            settings.default_owner_id,
            embedder,
            load_pdf_pages,
            split_words,
            settings.max_upload_bytes,
        )
        system_prompt = _prompt("system")
        catalog = load_skills()
        tools = [make_retrieve_from_documents(documents.search), *mcp_tools]
        agents = {
            spec.id: build_agent(
                model_factory.model(spec.id),
                system_prompt,
                catalog,
                tools,
                checkpointer,
                settings.history_max_turns,
            )
            for spec in model_factory.specs
        }
        langfuse = None
        callbacks: list[BaseCallbackHandler] = []
        if settings.langfuse_public_key and settings.langfuse_secret_key:
            langfuse = Langfuse(
                public_key=settings.langfuse_public_key,
                secret_key=settings.langfuse_secret_key,
                base_url=settings.langfuse_base_url,
            )
            # One handler for every turn: it keeps its state per LangChain run id.
            callbacks.append(CallbackHandler(public_key=settings.langfuse_public_key))
        return cls(
            settings=settings,
            engine=engine,
            checkpoint_pool=checkpoint_pool,
            ollama_http=httpx.AsyncClient(
                base_url=settings.ollama_base_url, timeout=settings.readiness_timeout_s
            ),
            model_factory=model_factory,
            embedder=embedder,
            sessions=sessions,
            documents=documents,
            chat=ChatService(uow, agents, sessions, checkpointer, callbacks),
            langfuse=langfuse,
        )

    async def aclose(self) -> None:
        if self.langfuse is not None:
            # Flushes the traces still queued; a blocking network call.
            await asyncio.to_thread(self.langfuse.shutdown)
        await self.ollama_http.aclose()
        await self.checkpoint_pool.close()
        await self.engine.dispose()

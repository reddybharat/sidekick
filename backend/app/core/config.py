from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    ollama_base_url: str = "http://localhost:11434"
    google_api_key: str | None = None
    groq_api_key: str | None = None
    log_level: str = "INFO"
    log_json: bool = True
    default_owner_id: str = "local"
    readiness_timeout_s: float = 2.0
    models_config_path: Path = BACKEND_DIR / "config" / "models.yaml"
    llm_timeout_s: float = 120.0
    embedding_model: str = "qwen3-embedding:0.6b"
    embedding_dim: int = 1024
    max_upload_bytes: int = 20 * 1024 * 1024
    cors_origins: list[str] = ["http://localhost:5173"]
    history_max_turns: int = 5
    # Server name -> streamable-HTTP URL; env MCP_SERVERS as JSON. Every server must be up at start.
    mcp_servers: dict[str, str] = {}
    mcp_api_key: str | None = None
    mcp_timeout_s: float = 30.0

    @property
    def checkpoint_database_url(self) -> str:
        """The same database for the psycopg-based checkpointer (the app itself uses asyncpg)."""
        return self.database_url.replace("+asyncpg", "", 1)

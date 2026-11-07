import pytest

from app.core.config import Settings
from app.infra.mcp.client import load_mcp_tools

UNREACHABLE_MCP_URL = "http://127.0.0.1:1/search/mcp"
UNREACHABLE_DATABASE_URL = "postgresql+asyncpg://nobody:nobody@127.0.0.1:1/nothing"
FAST_TIMEOUT_S = 2.0


async def test_an_unreachable_server_fails_loading() -> None:
    with pytest.raises(RuntimeError, match="'search' unavailable"):
        await load_mcp_tools({"search": UNREACHABLE_MCP_URL}, None, FAST_TIMEOUT_S)


async def test_configured_servers_provide_the_skill_tools(mcp_servers: dict[str, str]) -> None:
    settings = Settings(database_url=UNREACHABLE_DATABASE_URL)
    tools = {
        t.name: t
        for t in await load_mcp_tools(mcp_servers, settings.mcp_api_key, settings.mcp_timeout_s)
    }

    assert {"web_search", "get_weather"} <= set(tools)
    # Calls the real search providers (Tavily or DuckDuckGo), not an LLM.
    result = await tools["web_search"].ainvoke({"query": "Python programming language"})
    assert "(via " in str(result)

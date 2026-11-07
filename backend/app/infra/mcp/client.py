"""MCP client: load the tools of every configured MCP server (streamable HTTP) at startup."""

import asyncio

import structlog
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import Connection, StreamableHttpConnection

API_KEY_HEADER = "X-API-Key"

log = structlog.get_logger()


async def load_mcp_tools(
    servers: dict[str, str], api_key: str | None, timeout_s: float
) -> list[BaseTool]:
    """All servers' tools. Raises when a server is unreachable or lists no tools."""
    # shortcut: tools fixed at startup, restart after the MCP server changes; reload per request
    # if servers become dynamic.
    headers = {API_KEY_HEADER: api_key} if api_key else {}
    connections: dict[str, Connection] = {
        name: StreamableHttpConnection(
            transport="streamable_http", url=url, headers=headers, timeout=timeout_s
        )
        for name, url in servers.items()
    }
    client = MultiServerMCPClient(connections)
    tools: list[BaseTool] = []
    for name, url in servers.items():
        try:
            loaded = await asyncio.wait_for(client.get_tools(server_name=name), timeout_s)
        except Exception as e:
            log.error("mcp_server_unavailable", server=name, url=url, error=type(e).__name__)
            raise RuntimeError(f"MCP server {name!r} unavailable at {url}") from e
        if not loaded:
            log.error("mcp_server_unavailable", server=name, url=url, error="no_tools")
            raise RuntimeError(f"MCP server {name!r} at {url} lists no tools")
        log.info("mcp_tools_loaded", server=name, tools=[t.name for t in loaded])
        tools += loaded
    return tools

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.services.chat import _history_entries


def test_history_keeps_each_tool_call_with_its_args() -> None:
    call = {"name": "web_search", "args": {"query": "latest Python"}, "type": "tool_call"}
    turn = [
        HumanMessage("q", id="h1"),
        AIMessage("", id="a1", tool_calls=[{**call, "id": "c1"}, {**call, "id": "c2"}]),
        ToolMessage("results", tool_call_id="c1", name="web_search"),
        ToolMessage("boom", tool_call_id="c2", name="web_search", status="error"),
        AIMessage("answer", id="a2"),
    ]

    _, answer = _history_entries(turn)  # type: ignore[arg-type]

    assert [(t.id, t.ok, t.args) for t in answer.tools] == [
        ("c1", True, {"query": "latest Python"}),
        ("c2", False, {"query": "latest Python"}),
    ]

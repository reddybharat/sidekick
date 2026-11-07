from dataclasses import dataclass

from langchain_core.messages import AnyMessage, HumanMessage

# Set on the saved reply of a failed turn, so history can show it and the model never sees it.
ERROR_CODE_KEY = "error_code"


@dataclass(frozen=True)
class AgentContext:
    owner_id: str


def split_turns(messages: list[AnyMessage]) -> list[list[AnyMessage]]:
    """Group messages into turns; each turn starts at a HumanMessage."""
    turns: list[list[AnyMessage]] = []
    for message in messages:
        if isinstance(message, HumanMessage) or not turns:
            turns.append([])
        turns[-1].append(message)
    return turns

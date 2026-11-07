from pathlib import Path

import pytest

from app.agent.skill_loader import SKILLS_PLACEHOLDER, load_skills
from app.core.config import BACKEND_DIR

RETRIEVING = "retrieving-from-documents"
SHIPPED_TOOLS = {
    "checking-the-weather": ("get_weather",),
    RETRIEVING: ("retrieve_from_documents",),
    "searching-the-web": ("web_search",),
}
SKILL_MD = "---\nname: {name}\ndescription: d\nallowed-tools: {tools}\n---\nbody\n"
BASE = f"Base.\n{SKILLS_PLACEHOLDER}\nRules."


def _write(root: Path, name: str = "s", tools: str = "t") -> Path:
    (root / "s").mkdir()
    (root / "s" / "SKILL.md").write_text(SKILL_MD.format(name=name, tools=tools))
    return root


def test_shipped_skills_are_indexed_in_the_base_prompt() -> None:
    catalog = load_skills()

    assert {s.name: s.allowed_tools for s in catalog.skills.values()} == SHIPPED_TOOLS
    prompt = catalog.system_prompt(BASE)
    assert prompt.startswith("Base.\n- checking-the-weather (`checking-the-weather/SKILL.md`):")
    assert f"- {RETRIEVING} (`{RETRIEVING}/SKILL.md`):" in prompt
    assert prompt.endswith("Tools: web_search\nRules.")
    assert "## How to answer" not in prompt  # skill bodies stay out until read


def test_shipped_system_prompt_has_the_placeholder() -> None:
    base = (BACKEND_DIR / "app" / "agent" / "prompts" / "system.md").read_text(encoding="utf-8")

    prompt = load_skills().system_prompt(base)

    assert SKILLS_PLACEHOLDER not in prompt
    assert f"- {RETRIEVING} (`{RETRIEVING}/SKILL.md`):" in prompt


def test_valid_minimal_skill_loads(tmp_path: Path) -> None:
    catalog = load_skills(_write(tmp_path))

    assert [s.path for s in catalog.skills.values()] == ["s/SKILL.md"]
    assert catalog.system_prompt(BASE) == "Base.\n- s (`s/SKILL.md`): d Tools: t\nRules."


def test_prompt_without_placeholder_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="placeholder"):
        load_skills(_write(tmp_path)).system_prompt("No index here.")


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        ({"name": "other"}, "must equal folder name"),
        ({"tools": "''"}, "allowed-tools"),
    ],
)
def test_invalid_files_are_rejected(tmp_path: Path, kwargs: dict[str, str], error: str) -> None:
    with pytest.raises(ValueError, match=error):
        load_skills(_write(tmp_path, **kwargs))


def test_missing_frontmatter_is_rejected(tmp_path: Path) -> None:
    _write(tmp_path)
    (tmp_path / "s" / "SKILL.md").write_text("no frontmatter")

    with pytest.raises(ValueError, match="frontmatter"):
        load_skills(tmp_path)


def test_empty_skills_dir_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match=r"no \*/SKILL.md"):
        load_skills(tmp_path)

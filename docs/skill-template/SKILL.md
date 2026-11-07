---
name: {{verb-ing-object, e.g. comparing-documents}}
description: {{What it does, e.g. "Searches the public web for pages on any topic"}}. {{What it covers, in the user's words}}. Returns {{what comes back, and how to cite it}}.
allowed-tools: {{tool_one}} {{tool_two}}
---
<!--
How to use this template
- Copy this file to backend/app/agent/skills/<name>/SKILL.md, fill every {{...}}, and delete all comments.
- name: gerund + object, kebab-case, at most 64 characters. Must equal the folder name.
- description: one line in the index the model always sees (in place of {skills} in prompts/system.md),
  so the model picks the skill from it. State only what the skill does, covers and returns: no routing
  ("Read when...", "before any question"), and no overlap with another skill. A rule that decides between
  skills (e.g. prefer documents over the web) goes in system.md. About 300 characters at most.
  YAML: avoid a colon followed by a space inside it, or the file fails to load.
- allowed-tools: space-separated tool names. Reading this file unlocks them for the rest of the turn.
  Each must exist in the tool list passed to build_agent (container.py): a local tool or one loaded
  from an MCP_SERVERS server. Otherwise startup fails.
- The whole file, frontmatter included, is returned by read_skill_file and resent on every model call
  in the turn. State each rule once; add an example only when it shows something the rules don't.
- Rules that apply to every turn, whichever skill is read, belong in agent/prompts/system.md, not here.

After adding a skill: add it with its tools to SHIPPED_TOOLS in tests/unit/test_skill_loader.py, run
`uv run pytest tests/unit -q` in backend/, then ask one question that should use it and check the
read_skill_file and tool steps.
-->
# {{Skill title, e.g. Comparing documents}}

## Overview

{{The goal in one or two sentences.}} Done means {{what the user has at the end, including the empty case}}.

## Tools

- {{What it fetches}}: `{{tool_one}}({{arg}})`. Returns {{what comes back}}.
- {{What it fetches}}: `{{tool_two}}({{arg}})`. Returns {{what comes back}}.

## Rules

<!-- Hard constraints and facts the model can't work out alone. One rule per bullet, stated once. -->
- {{Constraint, e.g. "Answer only from the returned passages."}}
- {{When to ask the user for something and when not to}}
- {{Limits, e.g. "At most 4 calls to retrieve_from_documents."}}

## Workflow

<!-- Number the steps only if their order matters. Each step is one action. Put error handling specific to this skill here. -->
1. {{Get the input; what to ask if it's missing}}
2. Call `{{tool_one}}` with {{arguments}}.
3. Act on the result:
   - {{condition}}: {{what to answer}}
   - {{condition, e.g. nothing found}}: {{what to answer}}

## Answer formats

<!-- Default formats. Write "Use exactly this format" only when the format carries data the next step needs. -->
- **{{Case}}:** "{{Sentence with {FIELD} placeholders}}"
- **Nothing found:** "{{Sentence}}"

## Examples

<!-- At least two, including one edge case. Answers must follow the formats above word for word. -->

**{{Main case}}**
User: "{{Realistic message}}"
Call: `{{tool_one}}({{arg}}="{{value}}")` returns {{what comes back}}.
Answer: "{{Answer}}"

**{{Edge case: nothing found, ambiguous, or too many results}}**
User: "{{Message}}"
Call: `{{tool_one}}({{arg}}="{{value}}")` returns {{what comes back}}.
Answer: "{{Answer}}"

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary audience: reviewers, interviewers and engineers evaluating the project as a portfolio piece. They open the app on a laptop or desktop, upload or pick a PDF, ask a few questions, and judge whether the agentic RAG design is real, sound and well made. The developer is the secondary user, running it locally against their own PDFs while building and learning.

## Product Purpose

A local chat-with-your-PDFs app. One agent answers each question from the owner's document library and cites the pages it used. Success means a first-time evaluator can upload a PDF, get a grounded answer with page citations within minutes, and understand how the agent reached it.

## Positioning

Four claims, all true of this codebase:

- **Trustworthy citations:** answers come only from retrieved passages and cite `(filename, p. N)`. Chunks never cross a page boundary.
- **Local and private:** PDFs, chunks and embeddings stay on the machine (Postgres + pgvector, Ollama embeddings). Only the question, the session's recent turns and the retrieved passages reach the chat model.
- **Free tier and model choice:** it runs on free Gemini or Groq models, chosen per message in the chat input.
- **Transparent agent:** progressive disclosure. The agent reads a skill before it can use that skill's tools, so which skills and tools produced an answer can be shown.

## Operating Context

- Two views: **Library** (drag-and-drop or pick PDFs; each document shows a status: pending, ready or failed) and **Chat** (sessions in a sidebar; new, rename, delete).
- Sessions keep their history. The backend saves every turn, the UI reloads a session's turns when it is opened, and the last few turns (`history_max_turns`, 5 by default) reach the model as context. Document facts are always searched again.
- Answers stream over SSE as `token`, `tool_start` / `tool_end` (tool name, args, ok), `done` (input/output tokens, latency) and `error` (code, message) events. Every session searches all of the owner's `ready` documents.
- Runs natively on Windows: FastAPI backend at `localhost:8000`, Vite dev server at `localhost:5173`.
- Free-tier quotas are small and per model per day, so rate-limit and quota errors are normal states, not rare ones.

## Capabilities and Constraints

- Stack: React 19 + Vite + Tailwind v4 + shadcn/ui (radix), lucide icons, `next-themes` for light and dark, `sonner` toasts, `react-markdown` for answers.
- Desktop-first. Mobile is secondary but must not break.
- shadcn/ui stays the component base. Per `CLAUDE.md`: neutral palette with one accent, light and dark through CSS variables, lucide icons only where they carry meaning, no gradients or glow.
- Single owner (`DEFAULT_OWNER_ID`). Auth is planned, not built.
- Terminology: "session" (not conversation or chat), "Library", "document", "skill", "tool".

## Brand Commitments

- Visual direction chosen by the developer on 2026-11-07: "Stone Indigo" colours (warm grey neutrals, one indigo accent) with "Brick" styling (2px corners, Albert Sans, formal, flat). It must look new, not like the default shadcn shell: no hamburger-driven collapsible sidebar and no chat bubbles.
- Every UI change is shown to the developer in light and dark mode before it is built.

## Evidence on Hand

- A working app and a sample PDF at `backend/tests/fixtures/sample.pdf`.
- Design and implementation docs: `docs/ARCHITECTURE.md` and `docs/FLOW.md`.
- No users, testimonials, benchmarks or metrics exist. Do not invent any.

## Product Principles

1. **Show the evidence.** A citation is the product. Make sources visible, specific and easy to check.
2. **Make the agent legible.** Where it helps understanding, show what the agent did (skills read, tools called) without turning the chat into a debug log.
3. **Honest states.** Pending ingestion, quota limits, model errors and "not in your documents" are first-class states with clear wording.
4. **Demo in minutes.** A first-time evaluator gets from empty library to cited answer without reading docs.
5. **Restraint over decoration.** It is a tool. Precision and clarity show craft better than ornament.

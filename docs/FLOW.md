# Flow

Single source of truth for what is implemented **now**: how a question and an upload move through the backend, which files run, the constants in use, and how to run and test each part.

- The design and its reasons are in [ARCHITECTURE.md](ARCHITECTURE.md). Setup is in [README.md](../README.md).
- Update this file in the same change as the code (see [CLAUDE.md](../CLAUDE.md), "Definition of done"). Cite code as file plus symbol, never by line number.

Paths are relative to `backend/` unless they start with `frontend/`.

---

## 1. Run it

### 1.1 Environment

`app/core/config.py: Settings` (pydantic-settings) reads env vars or `backend/.env` (copy `backend/.env.example`).

| Setting | Default | Used for |
|---|---|---|
| `DATABASE_URL` | required | app DB (`postgresql+asyncpg://…`) |
| `TEST_DATABASE_URL` | unset → DB tests skip | disposable test DB, read by `tests/conftest.py` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | embeddings |
| `GOOGLE_API_KEY` | empty | enables the Gemini models in the catalog; without it they are skipped |
| `GROQ_API_KEY` | empty | enables the Groq models in the catalog; without it they are skipped |
| `LOG_LEVEL` / `LOG_JSON` | `INFO` / `true` | logging (`.env.example` sets `LOG_JSON=false`) |
| `DEFAULT_OWNER_ID` | `local` | owner of every session and document until auth exists |
| `HISTORY_MAX_TURNS` | `5` | earlier question/answer pairs the model sees (`ConversationView`) |
| `READINESS_TIMEOUT_S` | `2.0` | per-check timeout in `/ready` |
| `MODELS_CONFIG_PATH` | `config/models.yaml` | chat model catalog |
| `LLM_TIMEOUT_S` | `120.0` | HTTP timeout for chat (Gemini and Groq) and embedding calls |
| `EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | embedder; stored on each document |
| `EMBEDDING_DIM` | `1024` | vector size; **must equal** the `vector(1024)` column from migration `0003` |
| `MAX_UPLOAD_BYTES` | `20971520` (20 MiB) | upload size limit |
| `CORS_ORIGINS` | `["http://localhost:5173"]` | browser origins allowed to call the API (JSON list) |

The frontend reads `VITE_API_URL` (default `http://localhost:8000`) from `frontend/.env`.

### 1.2 Tests

| Command (in `backend/`) | Needs | Covers |
|---|---|---|
| `uv run pytest tests/unit -q` | nothing | skill loader, progressive disclosure, conversation view, chunker, model factory |
| `uv run pytest -rs` | Postgres (`TEST_DATABASE_URL`) + Ollama; skips with a reason otherwise | everything: health/ready, models, sessions, documents + chat, logging, migrations |

### 1.3 Check by hand

With the API running (`uv run uvicorn app.main:create_app --factory --reload`), in a second PowerShell in `backend/`:

```powershell
curl.exe -F "file=@tests/fixtures/sample.pdf;type=application/pdf" http://localhost:8000/documents
curl.exe http://localhost:8000/documents      # status: pending -> ready
$s = (Invoke-RestMethod -Method Post http://localhost:8000/sessions -ContentType application/json -Body '{}').id
curl.exe -N -X POST http://localhost:8000/sessions/$s/messages -H "Content-Type: application/json" -d '{\"text\":\"What is the phase two budget?\"}'
```

Expect `tool_start`/`tool_end` for `read_skill_file`, then for `retrieve_from_documents`, then `token`… and `done`, with a citation like `(sample.pdf, p. 3)`. Uploading the same file again returns 409; `curl.exe -X DELETE http://localhost:8000/documents/<id>` removes it. Interactive API docs: http://localhost:8000/docs.

Inspect the database with `psql -U app -d agentic_rag`:

```sql
SELECT id, filename, status, page_count, error FROM documents;
SELECT page, ordinal, left(content, 80) FROM chunks ORDER BY document_id, ordinal;
SELECT model_id, input_tokens, output_tokens, latency_ms FROM turn_usage ORDER BY created_at DESC;
```

---

## 2. Startup: who builds what

`uvicorn app.main:create_app --factory` calls `main.py: create_app`:

1. `Settings()` reads the environment.
2. `core/logging.py: configure_logging` sets up structlog. The request middleware binds `request_id` to every log line of a request and echoes it in `X-Request-ID`.
3. The lifespan runs `container.py: Container.build` once. It is the only place concrete classes are created:

```text
engine (SQLAlchemy async, asyncpg, pool_pre_ping)
 └─ uow = SqlUnitOfWork factory              one DB transaction per `async with uow()`
psycopg AsyncConnectionPool → AsyncPostgresSaver(pool).setup()   # history; creates its own tables
ModelFactory.from_yaml(config/models.yaml, {"gemini": GeminiChatProvider,   # only with GOOGLE_API_KEY
                                            "groq": GroqChatProvider})       # only with GROQ_API_KEY
SessionService(uow, owner)
OllamaEmbedder(qwen3-embedding:0.6b, dim 1024)
DocumentService(uow, owner, embedder, load_pdf_pages, split_words, MAX_UPLOAD_BYTES)
build_agent(model_factory.model(id),   # one agent per catalog model
            prompts/system.md,                  base system prompt
            load_skills(),                      agent/skills/
            [make_retrieve_from_documents(documents.search)],
            the saver, HISTORY_MAX_TURNS)
ChatService(uow, {model id: agent}, sessions, the saver)
```

`Container.build` is async: it opens the pool and runs the saver's idempotent `setup()` (the checkpoint tables belong to the saver, not Alembic). `Container.aclose` closes the pool.

Windows: psycopg's async mode cannot run on the default Proactor event loop, so `main.py` switches to the selector policy (tests and scripts). `uvicorn --reload` already uses the selector loop; plain `uvicorn` without `--reload` ignores the policy and would hang on startup.

Startup fails fast on a malformed skill file, or an unknown tool in `allowed-tools`. Routes get services through `api/deps.py` (`request.app.state.container`).

---

## 3. One chat turn, end to end

`POST /sessions/{id}/messages {"text": "...", "model_id": "..."}` (`text` 1–8000 characters after trimming, otherwise 422; `model_id` optional, default = the catalog's first model, an id not in the catalog gives 422 `unknown_model` before the stream starts).

1. The `get_session` dependency loads the session with the owner filter. An unknown session gives 404 **before** the stream starts.
2. `services/chat.py: ChatService.stream` counts the earlier turns (`prior_turns`, logged in `turn_started`), then calls `agent.astream({"messages": [HumanMessage(text)]}, {"configurable": {"thread_id": session_id}}, stream_mode=["messages", "updates"], context=AgentContext(owner_id))`. The checkpointer appends the new message to the session's saved messages.
3. The agent loops: model call → tool calls → model call … until an answer or 8 tool calls.
4. Stream mapping:
   - `messages` mode → `AIMessageChunk`s → one `token` event per non-empty `.text` (thinking never appears in `.text`). `usage_metadata` is summed over all model calls.
   - `updates` mode → an `AIMessage` with `tool_calls` gives a `tool_start` per call; a `ToolMessage` gives `tool_end` (`ok = status != "error"`).
5. An exception during the stream → logged with traceback → the error text is saved as the turn's reply (an `AIMessage` with `additional_kwargs["error_code"]`, written with `aupdate_state(as_node="model")`; if that fails, `history_error_save_failed` is logged) → one `error` event (`chat_failed`); no usage is saved. A client disconnect saves nothing.
6. On success: insert `turn_usage` → `SessionService.title_from_message` (only while the title is `New chat`: the first message with whitespace collapsed, cut to `SESSION_TITLE_CHARS = 60` with a trailing `…`; no model call) → `done`.

### 3.1 History

- `GET /sessions/{id}/messages` → `ChatService.history`: reads the session's checkpoint (`aget_state`) and returns `[{id, role, text, tools: [{id, name, ok}], skills, error?}]`, oldest first. One user entry per `HumanMessage`; one assistant entry per turn with the concatenated answer text, every tool call (`ok` false when the call has no result), the skills read (from `read_skill_file` paths) and, for a failed turn, `error` instead of text. The session is resolved first (404 for another owner's). No passages are returned.
- `DELETE /sessions/{id}`: owner check → `ChatService.delete_history` (`adelete_thread`) → delete the session row. History goes first so a failure leaves the session in place and the delete can be retried; nothing is orphaned.
- The frontend loads these turns once per page load when a session is first opened (`App.tsx`); after that its tab state is current.

### SSE events

| event | data |
|---|---|
| `tool_start` | `{id, name, args}` |
| `tool_end` | `{id, name, ok}` |
| `token` | `{text}` |
| `done` | `{input_tokens, output_tokens, latency_ms}` |
| `error` | `{code, message}` |

Order: `tool_start`/`tool_end` and `token` interleaved, then exactly one `done` or `error`. `frontend/src/lib/api.ts: streamMessage` POSTs and parses the stream with `fetch` + `TextDecoderStream` (`EventSource` cannot POST); its API types are hand-written mirrors of the backend schemas.

---

## 4. Chat models

`config/models.yaml` → `ModelSpec {id, provider, model_name, supports_tools, options}`. The first entry is the default; the chat input lists every entry. An entry exists only when its provider's key (`GOOGLE_API_KEY`, `GROQ_API_KEY`) is set (otherwise it is skipped with a `model_skipped` log):

| id | provider | model | options |
|---|---|---|---|
| `gemini-3.5-flash-lite` (default) | gemini | `gemini-3.5-flash-lite` | none |
| `gemini-3.6-flash` | gemini | `gemini-3.6-flash` | none |
| `qwen3.8-27b` | groq | `qwen/qwen3.8-27b` | none |

- `ModelFactory.model(id)` returns the built model, `.specs` the available entries, `.default` the first. `Container.build` builds one agent per model. `ChatService.resolve_model_id` maps a request's `model_id` (or none) to an agent; `turn_usage.model_id` records the one used. `GET /models` returns the specs without options; the frontend keeps the choice in `App.tsx` and shows it in `Chat.tsx: ModelPicker` under the input (default = first entry).
- `infra/llm/model_factory.py: ModelFactory` fails startup on duplicate ids or when no catalog model has a registered provider; models of an unregistered provider are skipped. It builds each model once.
- `infra/llm/groq.py: GroqChatProvider` and `infra/llm/gemini.py: GeminiChatProvider` **reject unknown option keys** at startup.
- Gemini free tier (measured 2026-10-31 with the project's key): `gemini-3.6-flash` and `gemini-3.5-flash` allow **20 requests per day per model**, and a document question takes 3 model calls (read skill, search, answer), so about 6 questions a day; `gemini-3.5-flash-lite` has more headroom, hence the default. `gemini-2.5-*` is closed to new keys; `gemini-3.7-flash`, `3.8-flash` and `flash-latest` answered in 80–117 s. A 429 surfaces as the generic `chat_failed` error event. Retrieved passages and the question go to Google for these models; embeddings and the library stay local.
- Groq models are hosted: the question and retrieved passages go to Groq, like Gemini. With only `GROQ_API_KEY` set, the first Groq entry is the default. There is no local chat model; Ollama serves embeddings only.

---

## 5. Embeddings

`infra/embeddings/ollama.py: OllamaEmbedder` wraps `OllamaEmbeddings`.

| Aspect | Value |
|---|---|
| Model / dimension | `qwen3-embedding:0.6b`, 1024 (`dimensions=`) |
| Chunk side | text as-is, no prefix |
| Query side | `Instruct: Given a question, retrieve document passages that answer it\nQuery: <question>` |
| Batching | `DocumentService` embeds `EMBED_BATCH_SIZE = 32` chunks per call |
| Distance | cosine (`vector_cosine_ops` HNSW index) |

Every document row stores `embedding_model`; `/ready` returns 503 (`checks.embeddings = false`) if any `ready` document used another model. To change the model: set `EMBEDDING_MODEL` (and `EMBEDDING_DIM` plus a migration recreating `chunks.embedding` and its index if the size changes), then re-ingest.

---

## 6. Ingestion

```text
POST /documents (multipart "file", one file per request)
  services/documents.py: DocumentService.upload
    1. len(data) > MAX_UPLOAD_BYTES       → 413 payload_too_large
    2. not data.startswith(b"%PDF-")      → 422 invalid_document
    3. sha256 already in the library      → 409 conflict  (also unique on (owner_id, sha256))
    4. insert documents row, status = pending
  response 202 {id, filename, status: "pending", ...}
  background task: DocumentService.ingest(document_id, data)
    a. infra/rag/pdf_loader.py: load_pdf_pages   pypdf text per page (in a thread)
    b. infra/rag/chunkers.py: split_words         per page
    c. no chunks at all                  → failed: "No extractable text: the PDF may be scanned images."
    d. embed in batches of 32
    e. one transaction: insert chunks + status = ready + page_count
    any exception                        → logged, status = failed, error = "Could not read this PDF."
```

- `GET /documents` lists the library (poll for `pending → ready | failed`). `DELETE /documents/{id}` cascades to chunks (404 for unknown or another owner's).
- **Chunking (`split_words`):** chunks never cross a page. Whitespace-split words are packed until the next word would exceed `CHUNK_CHARS = 1000`; the next chunk starts `OVERLAP_WORDS = 30` words back; whitespace is normalised; `ordinal` numbers chunks across the document.
- pypdf flattens layout and tables; scanned pages give no text (no OCR).

---

## 7. The agent

`agent/agent_builder.py: build_agent`:

```text
create_agent(model,
             tools=[read_skill_file, retrieve_from_documents],
             system_prompt=catalog.system_prompt(system.md),     base prompt + skill index
             middleware=[ConversationView(HISTORY_MAX_TURNS),
                         ProgressiveDisclosure(catalog),
                         ToolCallLimitMiddleware(run_limit=8, exit_behavior="continue")],
             context_schema=AgentContext,
             checkpointer=saver)
```

- **Context:** `agent/state.py: AgentContext(owner_id)`, passed per run, readable by middleware and tools.
- **State:** `messages`, checkpointed per session (`thread_id` = session id). The checkpoint keeps every message; `ConversationView` decides what the model sees (7.6).
- After 8 tool calls, further calls get an error result and the model has to answer.

### 7.1 System prompt

`SkillCatalog.system_prompt(base)` = `prompts/system.md` + `## Skills` + `Available skills:` + one index line per skill (name, path, description, `allowed-tools`):

```text
<prompts/system.md>

## Skills
Available skills:
- retrieving-from-documents (`retrieving-from-documents/SKILL.md`): Read before answering any question, ... Tools: retrieve_from_documents
```

Skill bodies are never in the system prompt; they arrive as `read_skill_file` results. `system.md` tells the model to read a skill with `read_skill_file` before using its tools.

### 7.2 Skills (`agent/skill_loader.py: load_skills`)

Reads `agent/skills/` once at startup and fails fast with the bad path: `<name>/SKILL.md` needs frontmatter `name` (= folder name), `description`, `allowed-tools` (non-empty, space-separated), and at least one skill must exist. The whole file text is kept, because the middleware matches on it. Frontmatter is YAML, so a colon followed by a space inside a description breaks the file.

| Skill | allowed-tools | Does |
|---|---|---|
| `retrieving-from-documents` | `retrieve_from_documents` | explains the tool, searches (retry once with other words), answers from the passages with `(filename, p. N)` citations, says so when nothing is found |

The format is documented in [skill-template/SKILL.md](skill-template/SKILL.md).

### 7.3 Progressive disclosure (`agent/middleware/progressive_disclosure.py: ProgressiveDisclosure`)

1. **`awrap_model_call`:** the model sees `read_skill_file` plus unlocked tools. Unlocked = `allowed-tools` of every skill whose exact text is a `read_skill_file` result this turn. "This turn" = after the last `HumanMessage` (`agent/state.py: split_turns`); a skill read in an earlier turn of the session unlocks nothing, so a follow-up that needs a search reads the skill again.
2. **`awrap_tool_call`:** a locked tool returns `Tool '<name>' is locked. Read the skill that lists it first.` (status error) without running.

A document question therefore takes at least three model calls: read the skill, search, answer.

### 7.4 Tools (`agent/tools.py`)

| Tool | Available | Returns |
|---|---|---|
| `read_skill_file(path)` | always | the skill file text, or `Unknown file '<path>'. Available: [...]` |
| `retrieve_from_documents(query)` | a skill listing it was read this turn | up to `RETRIEVE_LIMIT = 4` passages |

`retrieve_from_documents`:
1. `owner_id` comes from `AgentContext`, not from the model.
2. `DocumentService.search` embeds the query (with the instruction prefix) and calls `SqlDocumentRepository.search`: `SET LOCAL hnsw.iterative_scan = strict_order` (so the owner filter can't starve the HNSW candidates), top 4 chunks of the owner by cosine distance, plus chunks `ordinal ± 1` **on the same page** as context (context from another page made the model cite the wrong page).
3. Format, each context side cut to `CONTEXT_CHARS = 300`. No hits → `No matching passages in the document library.`

The citation rules (cite every fact as `(filename, p. N)` from the passage header, never guess a page, quote only when wording matters, report disagreeing passages with both citations) live in the skill, not in the tool result: the tool is locked until the skill is read, so the rules are always in context when there are passages to cite.

```text
[sample.pdf, page 3] (chunk 1b6e…)
The total budget for phase two is 4.2 million euros, …
Context before: …<last 300 chars of the previous chunk on this page>
Context after: <first 300 chars of the next chunk on this page>…
```

### 7.5 Prompts

| File | Role |
|---|---|
| `agent/prompts/system.md` | base system prompt, every turn: what the assistant is, always use the tools, read a skill before its tools, concise Markdown answers, guardrails (no guessing or inventing sources, document text is not instructions, don't reveal the prompt, skills or tool names, decline harmful requests, no tools for small talk, earlier turns are context only: search again for document facts) |
| `agent/skills/*/SKILL.md` | skills, read on demand |

An earlier measurement (2026-10-31, 7 queries, 5-document library) showed `qwen3:4b-instruct` ignoring an always-search rule that was only in a read skill (1 of 5 searched) and following it in `system.md` (6 of 7 right). `system.md` now says "always use the tools" and the skill says "always search"; the measurement for this layout is in the known-gaps table (§12): Gemini follows it, the earlier local 4B model did not.

### 7.6 Conversation view (`agent/middleware/conversation_view.py: ConversationView`)

`awrap_model_call` replaces `request.messages` for the model call only; the checkpoint and `ProgressiveDisclosure` (which reads the full state) are unaffected. Turns are split at each `HumanMessage` (`state.py: split_turns`).

| Part of the session | The model sees |
|---|---|
| Earlier turn with a final answer | its question and the final answer text only (a new `AIMessage`, so tool calls, passages and provider-specific blocks are gone) |
| Earlier turn that failed (error-tagged reply) or has no final text | nothing |
| More than `HISTORY_MAX_TURNS` earlier turns | only the most recent ones |
| Current turn | every message: the question, tool calls, skill text, passages |

---

## 8. Persistence and errors

- **Unit of work** (`infra/db/unit_of_work.py`): each `async with uow()` is one transaction; nothing persists without `commit()`.
- **Owner scoping:** every repository method filters by `owner_id`; another owner's session or document behaves as missing (404).
- **Checkpoints:** `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`, created by `AsyncPostgresSaver.setup()` at startup (not Alembic), keyed by `thread_id` = session id. The pool is separate from the SQLAlchemy engine because the saver uses psycopg (`Settings.checkpoint_database_url` = `DATABASE_URL` without `+asyncpg`).
- **Migrations** (`migrations/versions/`): `0001` sessions + `vector` extension, `0002` turn_usage, `0003` documents + chunks, `0004` documents/chunks scoped to the owner. `env.py` is async and reads `DATABASE_URL` unless `sqlalchemy.url` is set (tests set it).
- **Errors:** `core/errors.py: AppError` subclasses become `{"error": {"code", "message"}}`: `AppError` 400 `bad_request`, `NotFoundError` 404, `ConflictError` 409, `PayloadTooLargeError` 413, `UnknownModelError` 422 `unknown_model`, `InvalidDocumentError` 422 `invalid_document`, anything else 500 `internal_error` (logged with traceback). FastAPI validation errors stay 422 with FastAPI's body.

---

## 9. Logging

structlog, console or JSON per `LOG_JSON`; `request_id` on every line of a request. Ids, sizes, counts and durations only, never message text, document content or file bytes. Failures log at ERROR with a traceback, rejections and tool errors at WARNING, everything else at INFO.

| Event | Where | Fields |
|---|---|---|
| `http_request` | `main.py` middleware | method, path, status, duration_ms (SSE: time to first byte) |
| `upload_received` / `upload_rejected` | `DocumentService.upload` | document_id, filename, bytes / reason = size, type, duplicate |
| `ingestion_started` / `ingestion_done` / `ingestion_failed` | `DocumentService.ingest` | pages, chunks, embed_batches, `load_ms` `chunk_ms` `embed_ms` `store_ms`, total_ms |
| `document_deleted` | `DocumentService.delete` | document_id |
| `search_done` | `DocumentService.search` | hits, query_chars, duration_ms |
| `turn_started` / `turn_done` / `turn_failed` | `ChatService.stream` | session_id, model_id, prior_turns, tokens, latency_ms |
| `history_error_save_failed` | `ChatService._save_error_reply` | session_id (ERROR, with traceback; the turn just has no saved reply) |
| `history_view` | `ConversationView.awrap_model_call` | prior_turns, messages_in, messages_out (DEBUG, every model call) |
| `model_skipped` | `ModelFactory` (startup) | model_id, provider (no registered provider, e.g. a model whose API key is not set) |
| `tool_start` / `tool_end` / `tool_limit_reached` | `ChatService` | tool, tool_call_id, ok, duration_ms |
| `skills_loaded` | `load_skills` (startup) | skills |
| `skill_read` | `read_skill_file` | path, status = ok / unknown_path, source = read_skill_file |
| `tool_locked` | `ProgressiveDisclosure.awrap_tool_call` | tool |
| `app_error` | `core/errors.py` handler | code, message, path (an `AppError` returned to the client) |
| `unhandled_error` | `core/errors.py` handler | path (ERROR, with traceback; client gets 500 `internal_error`) |
| `readiness_check_failed` | `api/routes/health.py: ready` | check, error |

Tests use `structlog.testing.capture_logs` (`tests/integration/test_logging.py`); build the app first, then enter `capture_logs`, because `create_app` configures logging.

---

## 10. Frontend

`frontend/` is a React + Vite SPA (Tailwind, shadcn/ui) calling the backend directly (CORS). `src/lib/api.ts` holds the typed REST calls and `streamMessage`. Layout (`App.tsx`):
- **rail** (`App.tsx: Rail`, fixed 240 px from `md` up; below that a left `Sheet` opened from the header): Chat / Library switch with the document count, sessions list (title + `Today` / `Yesterday` / date from `updated_at`, new session), library summary by status;
- **header**: the session title and question count, or `Library` with document and page totals; rename and delete for the open session;
- **chat** (`components/Chat.tsx`): each question is a heading and its answer sits below it (markdown, raw HTML skipped); under each answer one line lists `Skill <name>` per skill read this turn (from `read_skill_file` `tool_start` args, pre-reads included) and `Tool <name>` with running/✓/✗ per other tool call; the composer holds the textarea, the model picker (id + provider) and Send; hints for an empty library or an empty session;
- **citations** (`lib/citations.ts: CITATION`, `parseCitations`): `(file.pdf, p. N)` in an answer, also with the filename in backticks and page lists or ranges (`p. 2, 3`, `pp. 4-6`), renders as a page chip (`Chat.tsx: markCitations` rewrites it into a `#cite` markdown link that the renderer draws as a chip);
- **Sources** (`components/Sources.tsx`, `xl` and up, chat only): per cited document a strip of its pages with the cited ones filled (numbered tiles up to 12 pages, thin ticks up to 60, page list only beyond), the citation count and pages; ready documents not cited are listed under "Searched, not cited". Built from the answer text only; the passages themselves are not shown yet;
- **Library** (`components/Library.tsx`): drop strip and file picker, multi-file; table with pages, added time (hidden on phones), status dot (Ready / Processing / Failed) and the error under a failed file; polls every 2 s while any document is `pending`; delete.

Theme: all colours are CSS variables in `frontend/src/index.css` (shadcn token names, light in `:root`, dark in `.dark`, which `main.tsx` toggles from `prefers-color-scheme`). Palette is warm-grey neutrals with one indigo accent (`--primary`, also the focus ring); `--accent` is the tinted indigo surface for the active session and session hover; `--success` / `--warning` / `--destructive` colour document status. Corners are `--radius: 0.125rem` (2px), so every shadcn radius scales from it. The face is Albert Sans, loaded from Google Fonts in `frontend/index.html` with the system sans as fallback, so offline use falls back to the system face.

Chat turns live in tab state, loaded from `GET /sessions/{id}/messages` the first time a session is opened in a page load, so a refresh keeps the conversation.

---

## 11. Tests and the sample PDF

Tests hit **real** Postgres (`TEST_DATABASE_URL`, truncated before each test) and **real** Ollama (embeddings), and skip with a reason when either is unavailable. `TEST_DATABASE_URL` must be disposable: migration tests downgrade it to an empty schema.

`tests/fixtures/sample.pdf` is a synthetic 4-page report about a fictional "Project Halcyon", so the facts can't come from the model's training data:

| Page | Facts |
|---|---|
| 1 | Ostrava Water Cooperative, founded 2011, eleven coastal villages |
| 2 | Kessel Bay plant: 1,840 m³/day (1,120 during February storms), 3.1 kWh/m³ |
| 3 | Phase two budget 4.2 M€ (approved 14 March 2025), 2.6 M€ membrane train, 0.9 M€ solar array |
| 4 | Lead engineer Mirela Vantongeren, Quillfeather Membranes (Tallinn), Brannock Laboratory |

| Test file | Checks |
|---|---|
| `tests/unit/test_skill_loader.py` | shipped skill loads and is indexed with its tools; malformed or empty skill dirs rejected |
| `tests/unit/test_progressive_disclosure.py` | tools hidden until a skill is read; a skill read in an earlier turn unlocks nothing; locked call refused; citation rules live in the skill, tool result is passages only |
| `tests/unit/test_conversation_view.py` | earlier turns shrink to question + answer, current turn whole, failed/unanswered turns hidden, only the last `history_max_turns` kept |
| `tests/unit/test_chunkers.py`, `test_model_factory.py` | chunk packing/overlap; catalog validation: Gemini + Groq build, default = first, unregistered provider skipped, duplicate ids and unknown options rejected |
| `tests/integration/test_documents.py` | upload validation, ingestion, delete cascade, owner isolation, chat answer cites p. 3 via `retrieve_from_documents` |
| `tests/integration/test_chat.py`, `test_sessions.py`, `test_models.py`, `test_health.py` | SSE turn + usage + first-message title, `model_id` default/selection/rejection, error event, failed turn saved as an error reply and removed with the session, follow-up resolved against the earlier turn (model-dependent), history empty and owner-private, session CRUD, `/models` with and without a key, live Gemini and Groq answers (skip without `GOOGLE_API_KEY` / `GROQ_API_KEY`), `/health` + `/ready` |
| `tests/integration/test_logging.py` | key log events for ingestion and a chat turn |
| `tests/integration/test_migrations.py` | upgrade → downgrade → upgrade, `0004` backfill and dedupe |

The chat-with-document tests depend on model output and can fail intermittently.

---

## 12. Known gaps and shortcuts

| Shortcut | Limit | Upgrade when |
|---|---|---|
| FastAPI `BackgroundTasks` for ingestion | in-flight jobs lost on restart; the row stays `pending` | ingestion must survive restarts → job queue |
| Size check after the body is received | multipart spools the whole upload first | exposed publicly → body limit at the proxy |
| pypdf text only | no OCR, tables flattened | scanned PDFs matter → OCR loader |
| Manual model choice | no automatic routing between models | measured need → routing middleware |
| Skill read by the model itself | every document question costs 3 model calls (read skill, search, answer). Measured 2026-10-31: Gemini 3.5-flash-lite and 3.6-flash read the skill and searched on every document question; the former local `qwen3:4b-instruct` searched 0 of 6, and a `system.md` line naming the skill did not help | check whether the Groq model does; otherwise the tool always available (2 calls, matters for the Gemini daily quota) |
| Hand-written frontend API types | drift if schemas change | API grows → codegen |
| Last-K history window | turns older than `HISTORY_MAX_TURNS` are forgotten by the model (the UI still lists them) | long threads matter → summarize older turns in `ConversationView` |
| One checkpoint thread per session | two tabs sending at once can interleave messages | multi-user or concurrent use → per-session lock |
| One error code for failed turns | the saved reply is the generic `chat_failed` text | error classification (P11) |
| Read skill text stays in the turn | resent on every model call of the turn | long tool loops → evict old skill text |
| Model may skip retrieval on familiar topics | before the pre-read was removed, "Tell me about chain of thought prompting" answered "no information" without searching; not re-measured | still failing → force a first `retrieve_from_documents` call (`tool_choice`) |

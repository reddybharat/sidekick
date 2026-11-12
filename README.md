# Sidekick

A local personal assistant. Upload your PDFs and ask questions about them; every answer cites the page it came from. It can also search the web and check the weather.

## Setup (Windows, one time)

Everything runs natively on your machine; no Docker needed.

### 1. uv
```powershell
winget install --id=astral-sh.uv -e
```
Open a new terminal and check `uv --version`.

### 2. PostgreSQL 18
1. Install from https://www.postgresql.org/download/windows/ with the defaults (port `5432`) and set a password for `postgres`. Skip Stack Builder.
2. Add `C:\Program Files\PostgreSQL\18\bin` to your user `PATH` and check `psql --version`.

### 3. pgvector
There is no Windows installer, so build it once:
1. Install **Visual Studio Build Tools** with the **"Desktop development with C++"** workload: https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. Open **"x64 Native Tools Command Prompt for VS"** as Administrator and run:
   ```bat
   set "PGROOT=C:\Program Files\PostgreSQL\18"
   cd %TEMP%
   git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git
   cd pgvector
   nmake /F Makefile.win
   nmake /F Makefile.win install
   ```

### 4. Database
```powershell
psql -U postgres
```
```sql
CREATE ROLE app LOGIN PASSWORD 'app';
CREATE DATABASE sidekick OWNER app;
\c sidekick
CREATE EXTENSION vector;
\q
```

### 5. Ollama
Install from https://ollama.com/download, then:
```powershell
ollama pull qwen3-embedding:0.6b
```

### 6. Chat model key
Get at least one key (you will paste it into `backend/.env` in step 8):
- Gemini (free): https://aistudio.google.com/apikey → `GOOGLE_API_KEY`
- Groq: https://console.groq.com/keys → `GROQ_API_KEY`

### 7. custom-mcp-server
Web search and weather come from [custom-mcp-server](https://github.com/reddybharat/custom-mcp-server); Sidekick does not start without it. Set it up by following its README, then run it on port 8001:
```powershell
uvicorn main:app --port 8001
```

### 8. Project
```powershell
cd backend
copy .env.example .env
uv sync
uv run alembic upgrade head

cd ..\frontend
npm install
```
In `backend/.env`, set your chat model key from step 6 and `MCP_API_KEY` (the same value as in custom-mcp-server's `.env`). Change `DATABASE_URL` if you used a different password in step 4.

Optional tracing: create a free project at https://cloud.langfuse.com and set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` in `backend/.env`. Every chat turn then shows up as a trace, including prompts and retrieved passages.

Evals (answer quality on the sample PDF, spends model quota): `uv run pytest -m eval -s` in `backend/`.

## Run

Start each in its own terminal, in this order:

| What | Where | Command |
|---|---|---|
| MCP tools | custom-mcp-server | `uvicorn main:app --port 8001` |
| API | `backend/` | `uv run uvicorn app.main:create_app --factory --reload` |
| UI | `frontend/` | `npm run dev` |

Open http://localhost:5173, upload PDFs in the **Library** view, then ask questions in a chat.

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built and why.
- [docs/FLOW.md](docs/FLOW.md): what is implemented now, settings, tests and developer commands.
- [PRODUCT.md](PRODUCT.md): product and brand context read by the impeccable design skill when styling the UI.

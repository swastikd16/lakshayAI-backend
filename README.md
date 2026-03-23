# LakshayAI Backend

Express + TypeScript backend for LakshayAI.  
Provides auth, onboarding, planner, adaptive practice/review, doubt solver, revision engine, analytics, profile APIs, and multimodal YouTube video-note processing.

## 1) Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express
- **DB/Auth Storage:** Supabase (via service role key)
- **AI Runtime:** Ollama (planner/doubt/adaptive/multimodal summarization)
- **YouTube transcript extraction:** Python helper + `youtube-transcript-api`

## 2) Prerequisites

- Node.js **18+** (Node 20 recommended)
- npm **9+**
- Supabase project + credentials
- Ollama running locally (default `http://127.0.0.1:11434`)
- Python **3.9+** (for YouTube transcript helper)

## 3) Setup

### Install Node dependencies

```bash
npm install
```

### Install Python dependency (for multimodal transcript feature)

```bash
pip install -r scripts/requirements.txt
```

### Environment file

Copy `.env.example` to `.env` and fill required values:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Required minimum:

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
PORT=4000
CORS_ORIGIN=http://localhost:5173
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:1b
```

## 4) Database Migrations (Supabase SQL)

Run SQL files in order:

1. `supabase/sql/001_basic_auth.sql`
2. `supabase/sql/002_full_app_schema_reset.sql`
3. `supabase/sql/003_planner_ai_columns.sql`
4. `supabase/sql/004_revision_items_origin.sql`
5. `supabase/sql/005_multimodal_video_notes.sql`

After running migrations, refresh PostgREST schema cache:

```sql
NOTIFY pgrst, 'reload schema';
```

## 5) Run

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Typecheck only

```bash
npm run typecheck
```

## 6) API Modules / Route Groups

Mounted in `src/server.ts`:

- `/health`
- `/auth`
- `/onboarding`
- `/dashboard`
- `/planner`
- `/adaptive`
- `/doubt`
- `/revision`
- `/analytics`
- `/profile`
- `/multimodal`

## 7) Multimodal (YouTube -> Notes + Mermaid)

### Endpoints

- `POST /multimodal/youtube/process`
- `GET /multimodal/youtube/history?limit=20`
- `GET /multimodal/youtube/:id`

### Processing flow

1. Validate/parse YouTube URL -> canonical `videoId`
2. Call Python script `scripts/youtube_transcript_fetch.py`
3. Generate notes/summary/mermaid via Ollama
4. Persist to `public.multimodal_video_notes`
5. Return structured response

### Python script contract

- Input args:
  - `--video-id`
  - `--languages` (comma-separated)
  - `--timeout-ms`
- Output:
  - JSON with transcript segments and normalized metadata
- Error codes mapped in backend:
  - `TRANSCRIPT_UNAVAILABLE`
  - `VIDEO_NOT_FOUND`
  - `LANGUAGE_NOT_AVAILABLE`
  - `FETCH_TIMEOUT`

## 8) Environment Variables

Defined in `src/lib/env.ts`.

### Core

- `SUPABASE_URL` (required)
- `SUPABASE_SERVICE_ROLE_KEY` (required)
- `PORT` (default `4000`)
- `CORS_ORIGIN` (default `*`)

### Ollama / AI

- `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` (default `gemma3:1b`)
- `PLANNER_LLM_TIMEOUT_MS` (default `20000`)

### Multimodal + transcript helper

- `PYTHON_BIN` (default `python`)
- `YOUTUBE_TRANSCRIPT_TIMEOUT_MS` (default `15000`)
- `MULTIMODAL_MAX_TRANSCRIPT_CHARS` (default `24000`)

### Optional placeholders / legacy

- `YOUTUBE_DATA_API_KEY` (placeholder, not required by current transcript method)
- `MULTIMODAL_API_KEY` (placeholder)
- `GEMINI_API_KEY` (legacy compatibility path)
- `GEMINI_MODEL`
- `OPENAI_API_KEY` (legacy compatibility path)
- `OPENAI_MODEL`

### Doubt AI diagnostics

- `DOUBT_AI_DEBUG` (default `false`)
- `DOUBT_AI_TIMEOUT_MS` (default `8000`)

## 9) Project Structure

```txt
LakshayAI-backend/
  src/
    index.ts
    server.ts
    lib/
      env.ts
      supabase.ts
      response.ts
      adminAuth.ts
    middleware/
      auth.ts
    routes/
      auth.ts
      onboarding.ts
      dashboard.ts
      planner.ts
      adaptive.ts
      doubt.ts
      revision.ts
      analytics.ts
      profile.ts
      multimodal.ts
    services/
      ...domain services...
      youtubeUrlService.ts
      youtubeTranscriptService.ts
      multimodalSummarizerService.ts
  scripts/
    requirements.txt
    youtube_transcript_fetch.py
  supabase/sql/
    001_...sql
    ...
    005_multimodal_video_notes.sql
```

## 10) Dependency/Config Files (Important)

- `package.json`: scripts + Node dependencies
- `package-lock.json`: locked dependency tree
- `tsconfig.json`: TypeScript compile settings (`outDir=dist`, `rootDir=src`)
- `.env.example`: documented env template
- `.env`: local runtime config (never commit secrets)
- `scripts/requirements.txt`: Python packages for transcript extraction

## 11) Auth Behavior

- Protected routes use `Authorization: Bearer <token>`
- Middleware validates token against `auth_sessions` in Supabase
- Admin bypass token path exists via `src/lib/adminAuth.ts`

## 12) Troubleshooting

### `Request failed with status 404` on new endpoints
- Backend likely running old process/version.
- Restart backend and verify route mount in `src/server.ts`.

### `Could not find table 'public.multimodal_video_notes' in schema cache`
- Run `005_multimodal_video_notes.sql`.
- Run `NOTIFY pgrst, 'reload schema';`.

### Python transcript failures
- Install requirements: `pip install -r scripts/requirements.txt`
- Ensure `PYTHON_BIN` points to valid Python executable.

### Ollama generation issues
- Ensure Ollama is running and model exists:
  - base URL matches `OLLAMA_BASE_URL`
  - model name matches `OLLAMA_MODEL`

### CORS errors from frontend
- Set `CORS_ORIGIN` to frontend origin (usually `http://localhost:5173`).

## 13) Security Notes

- Do not commit real secrets in `.env`.
- Use `.env.example` for shared templates.
- Service role key has elevated access; keep it private.

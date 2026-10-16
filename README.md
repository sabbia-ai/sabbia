# Sabbia AI

Sabbia AI is an open-source, self-hosted multimodal and voice agent framework. One Bun process serves a web console, a REST API, an event journal, and SQLite-backed knowledge, support, voice, and vision workflows. Original TypeScript and vanilla browser modules run directly: no runtime dependencies, package installation, bundler, or application build step. Documents and transcripts live on your infrastructure; live inference uses your NVIDIA endpoint and keys.

| Module | Capability |
| --- | --- |
| M1 · Knowledge | Document extraction, overlapping chunks, lexical + dense RRF retrieval, separate relevance judge, cited answers |
| M2 · Support | Intent routing, PII redaction, four-state safety checks, knowledge search, persisted escalation tickets |
| M3 · Voice | Transcript-based agent replies, per-session timing, interruption flags, and guardrail verdicts |
| M4 · Vision | Scene descriptions, text transcription, structured table extraction, visual Q&A |

## Quickstart

Install **Bun 1.2 or later**, open this repository directory, then:

```sh
cp .env.example .env
# Set NVIDIA_API_KEY in .env. Or set SABBIA_MOCK=1 for offline inference.
bun run src/index.ts
```

Open **http://localhost:3000** for the landing page or **http://localhost:3000/console** for the console. In PowerShell, use `Copy-Item .env.example .env`. Bun reads `.env` automatically; existing process environment variables take precedence.

For a one-command offline start:

```sh
SABBIA_MOCK=1 bun run src/index.ts
```

PowerShell equivalent:

```powershell
$env:SABBIA_MOCK='1'
bun run src/index.ts
```

In **Sources**, upload a document and wait for `indexed`. Ask a question on **Knowledge**, then click an `[S1]` chip to inspect its source. Console and Knowledge use the selected corpus; API calls without `corpusId`, Support, and Voice use the oldest corpus as the default. Creating another corpus never changes that default. Image uploads belong in **Vision**.

### Docker

```sh
cp .env.example .env
# Configure keys or mock mode in .env.
docker compose up --build -d
docker compose logs -f sabbia
```

The `sabbia` service binds port 3000 and persists SQLite and uploads in `./data:/data`. Both container and Compose health checks use `/healthz`. To use a keys file in Docker, mount it separately and set `NVIDIA_KEYS_FILE` to its container path. Optional scanned-PDF OCR needs `pdftoppm` installed in the deployment image; the base image does not install it.

### Verification

```sh
bun run typecheck
bash scripts/smoke.sh
bun run scripts/live.ts
```

The smoke test starts its own isolated mock server on port 3099, generates fixtures, checks ingestion/deduplication/search/SSE/resume/guardrails/vision/voice/errors, and removes test data. Set `SABBIA_SMOKE_PORT` in the test process to choose a different test port. `scripts/live.ts` uses real `.env` keys, port 3100, isolated data, and prints text/RAG/vision latencies. It makes provider calls.

Type checking uses TypeScript 5.9.3 through Bun's external tool cache and integrity-checked Bun/Node declarations in the OS temporary directory. The first check needs registry access. It creates no `node_modules` in this project and adds no package dependencies. Normal startup and mock inference require no network access.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Integer HTTP listener port |
| `HOST` | `0.0.0.0` | HTTP listener address |
| `SABBIA_DATA_DIR` | `./data` | SQLite database and uploads directory |
| `SABBIA_MOCK` | `0` | Set `1` for deterministic offline provider responses |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Compatible provider endpoint |
| `NVIDIA_API_KEY` | unset | Comma-separated keys |
| `NVIDIA_KEYS_FILE` | unset | Newline-separated keys, merged with the environment keys |
| `SABBIA_MAX_UPLOAD_MB` | `25` | Maximum individual uploaded file size in MiB |
| `SABBIA_RETRIEVAL_MIN_SCORE` | `0.18` | Minimum normalized best-hit relevance score, from 0 to 1 |
| `SABBIA_DENSE_RETRIEVAL` | `1` | Enable the dense retrieval channel; `0` uses lexical retrieval |
| `SABBIA_DENSE_MIN_SCORE` | `0.15` | Model-specific cosine floor; calibrate for the embedding model, independent of the lexical threshold |
| `SABBIA_JUDGE_RETRIEVAL` | `1` | Enable the separate passage judge before answer generation |
| `SABBIA_JUDGE_MAX_SEGMENTS` | `10` | Maximum raw passages judged per turn (1–100) |
| `SABBIA_JUDGE_CONCURRENCY` | `5` | Maximum parallel segment judges (1–20) |
| `SABBIA_VERIFY_ANSWERS` | `1` | Verify grounding; regenerate and re-verify at most once |
| `SABBIA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

Startup fails clearly if live mode has no keys, a specified keys file cannot be read, or configuration is invalid. Blank keys are ignored and duplicates removed. Public configuration exposes a data-directory configured flag, limits, thresholds, and aggregate key health only; no key material or prefixes are returned or logged.

## Running a public demo

The API is open by default and the console needs no login. Set `SABBIA_AUTH_TOKEN` on an internet deployment to protect operator deletion. **The daily model budget is the cost guard.** Limits bound abuse; a public user can spend the shared demo allowance and temporarily deny model access to everyone.

| Variable | Default | Scope / purpose |
| --- | --- | --- |
| `SABBIA_RATE_LIMIT_PER_MIN` | `120` | All requests per client IP; token bucket per minute |
| `SABBIA_MODEL_RATE_LIMIT_PER_MIN` | `6` | Model route admissions per client IP per minute |
| `SABBIA_MODEL_RATE_LIMIT_GLOBAL_PER_MIN` | `60` | Model route admissions across all clients per minute |
| `SABBIA_MODEL_BUDGET_PER_DAY` | `1500` | Global model route budget; resets at 00:00 UTC |
| `SABBIA_UPLOAD_RATE_PER_HOUR` | `10` | Source and asset uploads per client IP per hour |
| `SABBIA_MAX_CONCURRENT_STREAMS` | `40` | Simultaneous SSE responses across all clients |
| `SABBIA_MAX_CONCURRENT_STREAMS_PER_IP` | `3` | Simultaneous SSE responses per client IP |
| `SABBIA_MAX_UPLOAD_TOTAL_MB` | `500` | Total stored upload objects across sources and assets, in MiB |
| `SABBIA_MAX_SOURCES` | `50` | Maximum sources per corpus |
| `SABBIA_RETENTION_DAYS` | `14` | Anonymous data retention; hourly cleanup preserves operator rows |
| `SABBIA_MAX_JSON_KB` | `256` | Maximum JSON request body, in KiB |
| `SABBIA_MAX_DATABASE_MB` | `512` | SQLite metadata, chunks, events and telemetry ceiling, in MiB |
| `SABBIA_AUTH_TOKEN` | `unset` | Optional operator token for the three destructive routes; unset by default |
| `SABBIA_MAX_UPLOAD_MB` | `25` | Per-file upload ceiling in MiB (413) |

Reduce the request, model, upload, storage, source, and stream values to tighten the demo; raise them for more capacity. Restart after editing `.env`. Buckets start full, refill continuously, and discard idle identities; each bucket map holds at most 10,000 identities and rejects new ones at capacity. In addition, at most 128 non-streaming requests are admitted concurrently, and non-SSE connections close after their response. SSE responses expire after five minutes and close if a slow reader accumulates too many queued events. The reverse proxy **must overwrite `X-Forwarded-For`** with a trusted first client hop and restrict direct access to the listener; the first hop is used for IP limits, with the socket address as fallback. Multiple workers have separate minute/stream buckets; use one process for the public demo. The daily counter is persisted in SQLite across restarts.

The four model routes are `POST /v1/threads/:id/turns`, `POST /v1/vision/analyses`, `POST /v1/voice/sessions/:id/turns`, and `POST /v1/corpora/:id/search`. The dispatcher reserves one daily unit before admitting each request, including local replies, search, and rejected request bodies. PDF uploads also reserve a model unit before ingestion because scanned PDFs may invoke OCR. One route admission can make several bounded provider calls (guards, routing, retries); the budget counts route admissions, not tokens or dollars. No admitted request can bypass the daily hard stop; already admitted work can finish after it reaches zero. UTC midnight opens the next day's allowance.

`429 application/problem+json` names the exhausted limit and next availability/reset time; `Retry-After` is a number of seconds. A spent daily budget stays closed until 00:00 UTC. Stream limits use a five-second retry estimate because availability depends on disconnects. Upload objects are counted by actual stored bytes, including shared objects only once. Quota checks and file writes are atomic within the single process: exceeding 500 MiB returns `507 Storage quota exceeded` with current and maximum bytes. A corpus with 50 sources rejects another distinct source with `409`; duplicate sources still deduplicate. JSON bodies over 256 KiB and files over 25 MiB return `413`. Queries over 2,000 characters return `400`. SQLite has a separate 512 MiB ceiling to prevent metadata/event growth from filling disk; hitting it returns `507`. Existing databases larger than this ceiling retain their current size and cannot grow further. Leave space for SQLite WAL and temporary PDF extraction in addition to these ceilings.

### Visitor privacy, deletion, and retention

The first request issues a `sabbia_visitor` cookie with 32 random bytes, base64url encoded, `HttpOnly; Secure; SameSite=Lax`, and a 30-day expiry. Serve the public deployment over HTTPS. Scripts must retain and resend the cookie (for example, `curl -c cookies.txt -b cookies.txt ...`). The database stores only its SHA-256 hash and timestamps, with no IP or personal data. Losing the cookie loses access to the visitor's data. Up to 100,000 visitor identities are retained; new identities receive 429 at capacity until cleanup.

Thread and corpus lists contain only the caller's own rows. Direct-by-id reads, writes, event replay, voice sessions, images, searches, feedback, guardrails, and model usage lookups are scoped to the same cookie; another visitor receives `404`. Pre-migration rows keep `visitor_id IS NULL` and belong to the operator; a valid operator token permits direct access to these legacy rows. The token does not grant access to another visitor's data. A bundled English+Chinese corpus marked `is_public=1` is seeded at boot. It is read-only, discoverable at `GET /v1/demo/corpus`, and used automatically when the visitor owns no corpus. Uploading in the console creates a private corpus.

The three destructive routes `DELETE /v1/threads/:id`, `DELETE /v1/sources/:id`, and `DELETE /v1/voice/sessions/:id` are public **only while `SABBIA_AUTH_TOKEN` is unset** (local, single-user use). With a token configured they require `Authorization: Bearer <token>` or `X-API-Key: <token>`; comparison is constant-time and missing/incorrect credentials return `401`. Ownership still applies. Public GETs and model routes never require this token, and there is no login UI. The shared corpus cannot be modified even by the operator through public routes.

`GET /v1/visitor/export` exports the caller's threads, turns, corpus metadata, and source titles as JSON. `DELETE /v1/visitor` deletes all caller-owned data and clears the cookie, without the operator token; the console footer offers **Export my data** and **Delete my data**. This endpoint cannot delete operator or other visitor data. Hourly retention (also at boot) removes anonymous threads, corpora, sources, chunks, assets, and unreferenced upload objects older than `SABBIA_RETENTION_DAYS`; operator rows are never removed. Cleanup logs one summary line with counts and waits for admitted turn/ingestion work.

Reads and deletes are recorded locally in SQLite `access_log` as `{id, at, visitor_hash, method, route, resource_kind, resource_id, status}`. Routes are templates, request bodies and IPs are absent. The operator can inspect this table directly with SQLite. It is bounded to the latest 100,000 records and pruned by retention. `/healthz` exposes only audit counts, `limits: {model_remaining_today, model_budget_per_day, streams_open}`, and `storage: {used_mb, limit_mb, sources}`. `/api/config` exposes `dataDirConfigured: true` with no filesystem path; provider keys and prefixes are never exposed.

The console shows inline 429 notices with the limit and wait from `Retry-After`, and a friendly 507 storage-full message. Send is disabled until streaming completes or errors.

## API

JSON bodies require `Content-Type: application/json`. Multipart uploads use a field named `file`. Errors use RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, and `trace_id`. Every response carries `x-trace-id`.

| Method | Path | Request / response |
| --- | --- | --- |
| GET | `/healthz` | Status, version, uptime, mock flag, DB state, aggregate key health |
| GET | `/readyz` | Writable DB check; 503 when unavailable |
| GET | `/api/models` | Enabled model registry and capabilities |
| GET | `/api/config` | Safe public configuration |
| POST | `/v1/threads` | `{surface,title?}` → thread |
| GET | `/v1/threads?surface=&limit=&cursor=` | `{items,next_cursor}`; newest first, opaque cursor |
| GET | `/v1/threads/:id` | Thread with last 50 turns and latest voice session |
| DELETE | `/v1/threads/:id` | Archive thread |
| GET | `/v1/threads/:id/events?after=0` | Replay and subscribe to SSE journal |
| POST | `/v1/threads/:id/turns` | `{text,corpusId?}` → SSE; optional corpus selection for Knowledge/Console |
| POST | `/v1/threads/:id/feedback` | `{turnId,rating:-1\|0\|1,note?}` → persisted feedback |
| POST | `/v1/corpora` | `{name}` → corpus |
| GET | `/v1/corpora` | Corpora with source counts |
| POST | `/v1/corpora/:id/sources` | Multipart document → `{sourceId,status}`; async processing |
| GET | `/v1/corpora/:id/sources` | Source list for inspector |
| GET | `/v1/sources/:id` | Status, chunk count, failure reason |
| DELETE | `/v1/sources/:id` | Delete source and chunks; shared content-addressed files retained |
| POST | `/v1/corpora/:id/search` | `{query,k?}` → `{hits,insufficient,closestHeading}`; maximum 6 hits |
| POST | `/v1/assets` | Multipart image → `{assetId,url}` |
| GET | `/v1/assets/:id` | Raw image bytes with detected content type |
| POST | `/v1/vision/analyses` | `{assetId,task,question?}` → `{id,result,model,latency_ms}` |
| POST | `/v1/voice/sessions` | `{threadId?}` → `{sessionId,threadId}`; creates voice thread if omitted |
| POST | `/v1/voice/sessions/:id/turns` | `{speaker,transcript,interrupted?}` → `{reply,latency_ms,verdict}` for caller turns |
| GET | `/v1/voice/sessions/:id` | Session and transcript segments |
| DELETE | `/v1/voice/sessions/:id` | End session |
| GET | `/v1/threads/:id/guardrails` | Recent input/output verdicts |
| POST | `/v1/threads/:id/escalations` | `{reason?}` → local ticket; journals tool request/result |
| GET | `/model_calls?threadId=` | Calls, prompt/completion tokens, average latency, failures |
| GET | `/` | Public landing page |
| GET | `/console` | Web console |
| GET | `/static/*` | Public JavaScript and CSS assets |

Thread surfaces: `console`, `knowledge`, `support`, `voice`, `vision`. Vision tasks: `describe`, `text`, `table`, `qa`; Q&A requires `question`. Voice speakers: `caller`, `assistant`. Logging an assistant segment does not invoke another LLM turn.

### A minimal conversation

```sh
curl -s http://localhost:3000/v1/threads \
  -H 'Content-Type: application/json' \
  -d '{"surface":"knowledge","title":"Shipping question"}'
# Use the returned id in place of THREAD_ID:
curl -N http://localhost:3000/v1/threads/THREAD_ID/turns \
  -H 'Content-Type: application/json' \
  -d '{"text":"When do standard orders ship?"}'
```

### Event protocol

Every event has a monotonically increasing per-thread `id`, and a JSON `data` object containing `v:1`, `seq`, and `kind`. Open connections receive `retry: 3000`; subscribers receive a `:hb` comment every 15 seconds. Resume with `?after=N` or `Last-Event-ID`. The higher value wins when both are supplied. The journal replays committed events before subscribing to new ones, without a replay/subscription gap.

Kinds: `turn.start`, `block.open`, `text.delta`, `citations.set`, `tool.request`, `tool.result`, `guardrail.verdict`, `agent.handoff`, `turn.end`, `error`. User start/end events precede input guardrails. Assistant start and a text block precede deltas; citation metadata precedes assistant end. `block.open` describes the block as `block:{kind:"text"}`. Deltas use `text`; turns use `turnId`. A turn's error is followed by `turn.end` with `failed:true`.

Provider output is buffered while output guardrails run, then delivered as SSE text deltas. This adds safety-check latency before the first visible text. The provider client itself supports incremental SSE parsing and never retries an already partially emitted response. Disconnected POST clients do not cancel authorized generation; the completed turn remains available through replay. Turns on the same thread are serialized.

An output safety escalation regenerates once with the same context and a neutral, factual instruction, then checks safety once more. If uncertainty persists or regeneration fails, the original answer and citations remain visible with a short review notice in the input language. A successful retry must retain valid citations and pass the existing grounding verifier when enabled. Explicit refusals still block, with a language-matched explanation and a next step. Escalation records include the redacted triggering text in the existing `guardrail.verdict` journal event and `guardrail_hits.detail_json`.

## Architecture

```text
 Browser: landing + docs + transcript console
                    |
           Bun.serve explicit router
                    |
       +------------+-------------+
       |            |             |
   ingestion     orchestrator    vision tasks
       |       input/output guards    |
       |        routing + tools       |
       v            |             |
 SQLite WAL <-------+-------------+
 chunks + FTS5      |       voice segment log
 event journal      |
 telemetry          v
              provider adapter
              /             \
       mock provider    NVIDIA key pool
                        rotation + cooldown
```

### Storage and extraction

`data/sabbia.db` uses WAL and foreign keys. UUID identifiers and UTC ISO timestamps identify rows. Prepared statements back table repositories. Schema migrations are recorded in `schema_migrations`. Additional `feedback` and `escalations` tables hold the console's durable actions. FTS5 triggers synchronize inserts, updates, and cascading chunk deletion.

Uploads are bounded while reading, checked by signature and declared MIME, and stored under `uploads/<sha256><ext>`. Source hashes deduplicate within each corpus. Processing states are `queued → extracting → chunking → indexed`, or `failed`. A restart marks unfinished jobs as failed; remove and re-upload such a source to retry.

Supported input: UTF-8 TXT, Markdown, HTML, JSON, CSV, DOCX, and PDF. HTML removes scripts/styles and decodes common entities. DOCX validates and reads bounded ZIP entries; it optionally uses `unzip -p` with a manual central-directory/deflate fallback. The minimal PDF extractor handles text streams, Flate compression, `Tj`, `TJ`, quote operators, font-size filtering, and invisible text. It does not implement arbitrary embedded-font mappings, encrypted PDFs, or complete page-tree reconstruction. Its page markers enumerate readable text streams. For short extraction results, optional `pdftoppm` renders pages 1–3 at 150 DPI for vision OCR; temporary page images are removed afterward.

Chunking targets 700 estimated tokens with 80-token overlap and the nearest heading. Lexical retrieval uses FTS5 BM25, substring scans, bounded overlap, and the existing coverage/heading scores. RRF at k=60 weights each lexical list at 1 and the auxiliary dense list at 0.25. Dense contributes only ranks from its top 20 candidates, using its own model-specific cosine floor (`0.15`); lexical scores retain their `0.18` threshold. Without vectors, when embedding fails, or with dense disabled, lexical results remain byte-identical.

After indexing, ingestion embeds `heading + "\n" + content` as `input_type: "passage"` in batches of at most 32. Questions use `input_type: "query"`. SQLite `chunk_vectors(chunk_id, corpus_id, model, dim, vector, created_at)` stores each 2048-dimensional vector as an 8192-byte Float32 BLOB. Model IDs must match; a model change leaves old rows eligible for backfill. Chunk deletion also deletes its vector. Embedding failures leave sources indexed and their missing vectors available for a later retry.

The `judgeMain` map reads one entire raw passage per call, with a default cap of 10 passages and concurrency of 5. Its prompt bridges user outcomes to determining operational facts. Reduce keeps relevant passages in fused rank order and keeps any passage whose judge fails or returns malformed JSON. When no usable passage remains, one `textFast` completion replies naturally in Chinese for CJK input and English otherwise. Corpus IDs, chunk counts, closest headings, query tokens and judge verdicts are recorded only in `tool.result` diagnostics, never in chat text. Kept passages reach `textMain` in full, renumbered contiguously from `[S1]`; non-empty `answerable` sentences are retained on the existing citation records in storage and SSE. Source labels are normalized and validated as before.

Intent classification is pure and synchronous. Whole-message greetings, thanks, farewells and acknowledgements are normalized for case, outer punctuation, whitespace and repeated characters, then answered locally by subcase. Symbols, emoji and input without a token of at least two characters also stay local, with zero model or retrieval calls. Questions following a greeting or thanks still use knowledge search. Direct retrieval also rejects conversational or tokenless input before embedding or querying passages. Dense-only candidates must clear the model-specific cosine floor; the default `0.15` rejects baseline unrelated similarity while retaining the measured shipping paraphrase at `0.198`. Run `bun run scripts/live-conversation.ts` against a database containing the real air-conditioner document to record five Chinese replies and per-turn model/retrieval counts in `data/conversation-live-verification.json`.

The fallback acts as a general assistant with a document knowledge base: it answers conversational, meta, capability and general-knowledge questions normally, and declines only missing document facts with a concrete next step. It receives the last six conversation messages plus truthful model names from the server configuration. Its output filter checks only empty text, forbidden internal terms, source markers and script mismatch. Local acknowledgements or punctuation after a refusal, escalation or missing-document answer use the previous assistant verdict/text to acknowledge frustration synchronously. `scripts/behavior-smoke.ts` adds six regression checks to the full smoke suite. `bun run scripts/live-behavior.ts --corpus ID` replays all nine operator messages sequentially and records real provider verdicts in `data/behavior-live-verification.json`; `--local-fixture` explicitly selects the existing local verification fixture instead of production data.

`verifyMain` reads the answer plus the same kept raw passages and journals `verify_answer` through existing tool events. An unsupported verdict triggers one regeneration with the cited source numbers and at most one re-verification. Verifier errors preserve the answer. Setting dense, judge, and verify switches to `0` restores the original lexical six-hit answer path and context budget. `scripts/smoke.sh` covers the map, paraphrase bridge, failures, renumbering, verification bounds, and byte-identical dense-off behavior with a stubbed provider.

Run `bun run scripts/backfill-vectors.ts` after deploying to embed indexed chunks missing vectors for the configured model, including the bundled demo corpus. It is idempotent, prints progress, and never runs automatically at boot. `bun run scripts/live-vectors.ts` explicitly uploads a shipping/returns fixture to the real `data/` database, verifies a judged answer, and saves stage timings in `data/vector-live-verification.json`.

### Agent boundaries

Guardrail states are **allow**, **redact**, **refuse**, and **escalate**. Email, phone, SSN, and card patterns are redacted before persistence and inference. Request-boundary patterns refuse prompt/credential/other-user-data extraction. The safety classifier runs on input and generated output; classifier failures escalate. Each verdict is journaled and stored. Mock input containing the case-sensitive literal `BLOCKME` is refused.

Support uses a strict JSON intent router with a tolerant balanced-object parser. Confidence below 0.55 or `needs_human` routes to support and opens a local escalation. `search_knowledge` retrieves the default corpus; `open_escalation` saves a ticket. Tickets are local operator records; this framework does not send notifications or integrate an external helpdesk.

Vision tables are prompted as JSON, validated, retried once on parse failure, then returned as plain text if still malformed. No unsupported `response_format` parameter is sent. Every successful analysis records its actual model and latency.

Voice is transcript-based. The integrating application owns STT/TTS and audio transport. Create a session, send caller transcripts to `POST /v1/voice/sessions/:id/turns`, and read the reply, `latency_ms`, and guardrail `verdict`. Fetch `GET /v1/voice/sessions/:id` for transcript segments with session-relative timings and interruption flags. The console provides a text input for this same workflow.

The public API uses anonymous visitor cookies for isolation, configurable abuse limits, and an optional operator token for destructive routes. Serve it behind an HTTPS reverse proxy that overwrites client forwarding headers. No external fonts, scripts, analytics, or CDN assets are loaded by the web console. Local documentation is available at `/docs`.

## Model registry

Only the explicitly enabled registry below is used; provider discovery is never used to choose a model.

| Role | Model | Timeout | Max tokens |
| --- | --- | --- | --- |
| textMain | `openai/gpt-oss-20b` | 60 s | 900 |
| embedMain | `nvidia/nemotron-3.5-embed-1b` | 20 s | 2048 dimensions |
| judgeMain | `nvidia/nemotron-3.5-bolt-e4b` | 20 s | 220 |
| verifyMain | `nvidia/nemotron-3.5-bolt-e4b` | 25 s | 400 |
| textFast | `nvidia/nemotron-3.5-bolt-e4b` | 30 s | 400 |
| textBig | `nvidia/nemotron-3-ultra-550b-a55b` | 120 s | 1200 |
| visionMain | `nvidia/nemotron-3.5-super-vl-120b-a12b` | 90 s | 1400 |
| visionAlt | `meta/llama-3.2-11b-vision-instruct` | 15 s | 600 |
| visionLean | `meta/muse-glimmer-30b` | 60 s | 600 |
| guardMain | `meta/llama-guard-4-12b` | 20 s | 64 |
| guardAlt | `nvidia/nemotron-3.5-content-safety` | 20 s | 64 |
| guardJson | `nvidia/llama-3.1-nemotron-safety-guard-8b-v3` | 20 s | 128 |
| codeFast | `poolside/laguna-xs-2.1` | 60 s | 900 |

**Reasoning vision caveat:** `visionMain` needs a large generation budget. The client always sends at least 1,200 tokens (normally 1,400), reads only `choices[0].message.content`, and never exposes `reasoning_content`. An empty content field with reasoning present triggers one retry at 2,800 tokens. `visionAlt` can use approximately 1,600 image prompt tokens and has variable latency; it has a 15-second timeout, exactly one retry, then falls back to `visionMain`. The alternate vision path is available through `visionCompletion` for integrators; public image analysis defaults to `visionMain`. `nvidia/nemotron-parse-2.0` is unused because its chat endpoint returns an empty body.

## Operations and troubleshooting

- **Empty vision response:** increase `max_tokens`; reasoning may consume the budget. The client already performs the guarded retry above.
- **404 / `Function '<uuid>': Not found for account`:** the selected model is not enabled for those keys. The provider's full model list is not an entitlement list. Use the registry and verify account access.
- **429 or transient provider failure:** round-robin keys enter 5 s → 10 s → 20 s exponential cooldown, capped at 5 minutes. HTTP 500/502/503 and network errors also trigger rotation, up to `min(key count,5)` attempts. Fewer than 20% usable keys emits a warning. When all keys cool, requests fail with a clear retry message.
- **No RAG answer:** wait for indexed status, select the correct corpus, inspect search scores, and add passages that actually answer the question. Empty corpora and scores below the configured threshold are not sent as evidence.
- **DOCX/PDF extraction failure:** inspect `fail_reason`. UTF-8 text, supported ZIP compression, and ordinary PDF text streams work without external packages. Install optional `pdftoppm` for scanned-PDF OCR. An image uploaded as a document is rejected; use Vision.
- **Upload rejected:** compare declared MIME with detected bytes and check total multipart size. Rename extensions correctly; the server does not trust extensions for binary formats.
- **Port already in use:** set `PORT`, or choose another smoke-test port. Do not run two server processes on the same listener.
- **Type check needs network on first run:** tooling is cached outside the repository. Normal `bun run src/index.ts` has no install step.

Logs are JSON on stdout with timestamp, severity, request trace ID, route, HTTP status, and latency. Key statistics and model telemetry include failed attempts; provider tokens are recorded when supplied (mock tokens are estimates). `SIGINT` and `SIGTERM` stop acceptance, close SSE subscriptions, wait up to 10 seconds for active work, close SQLite, and exit successfully. Back up the data directory using a SQLite-aware backup or stop the service before copying the DB and WAL files.

## License

Apache-2.0.

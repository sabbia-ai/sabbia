#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null || { echo 'FAIL: Bun is required on PATH' >&2; exit 1; }
# The embedded runner owns an isolated mock server and generates every fixture.
bun run - <<'JS'
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
const directory = mkdtempSync(join(tmpdir(), "sabbia-smoke-"));
// Boot from the previous external-content schema, with an existing English row.
const legacy = new Database(join(directory, "sabbia.db"));
legacy.exec(`
CREATE TABLE corpora(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sources(id TEXT PRIMARY KEY, corpus_id TEXT NOT NULL REFERENCES corpora(id), title TEXT NOT NULL, mime TEXT NOT NULL, object_key TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, fail_reason TEXT, chunk_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(corpus_id,sha256));
CREATE TABLE chunks(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, heading TEXT NOT NULL, content TEXT NOT NULL, token_count INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, heading, content='chunks', content_rowid='rowid');
CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,content,heading) VALUES(new.rowid,new.content,new.heading); END;
CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,content,heading) VALUES('delete',old.rowid,old.content,old.heading); END;
CREATE TRIGGER chunks_update AFTER UPDATE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,content,heading) VALUES('delete',old.rowid,old.content,old.heading); INSERT INTO chunks_fts(rowid,content,heading) VALUES(new.rowid,new.content,new.heading); END;
INSERT INTO corpora VALUES('legacy','default','Existing English',datetime('now'));
INSERT INTO sources VALUES('legacy-source','legacy','ArchiveNebula.md','text/markdown','legacy',20,'legacy','indexed',NULL,1,datetime('now'));
INSERT INTO chunks VALUES('legacy-chunk','legacy-source',1,'Refund policy','Refund requests require a receipt.',10,datetime('now'));
INSERT INTO corpora VALUES('overlap','default','Bounded overlap',datetime('now'));
INSERT INTO sources VALUES('overlap-source','overlap','Fragments.md','text/markdown','overlap',20,'overlap','indexed',NULL,1001,datetime('now'));
`);
const fragment = legacy.prepare("INSERT INTO chunks VALUES(?,?,?,'Fragment',?,2,datetime('now'))");
legacy.transaction(() => {
  let ordinal = 0;
  for (const pair of ["alpha beta", "beta gamma", "gamma delta", "delta epsilon", "epsilon zeta"]) for (let i = 0; i < 200; i++) fragment.run(`fragment-${++ordinal}`, 'overlap-source', ordinal, pair);
  fragment.run('overlap-target', 'overlap-source', ++ordinal, 'alpha beta gamma delta');
})();
legacy.close(true);
const port = process.env.SABBIA_SMOKE_PORT || "3099", base = `http://127.0.0.1:${port}`;
const child = Bun.spawn([process.execPath, "run", "src/index.ts"], { env: { ...process.env, SABBIA_MOCK: "1", SABBIA_AUTH_TOKEN: "", SABBIA_RATE_LIMIT_PER_MIN: "10000", SABBIA_MODEL_RATE_LIMIT_PER_MIN: "1000", SABBIA_MODEL_RATE_LIMIT_GLOBAL_PER_MIN: "1000", SABBIA_MODEL_BUDGET_PER_DAY: "10000", SABBIA_UPLOAD_RATE_PER_HOUR: "1000", PORT: port, HOST: "127.0.0.1", SABBIA_DATA_DIR: directory, SABBIA_LOG_LEVEL: "warn" }, stdout: "pipe", stderr: "pipe" });
const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
let cookie = "";
async function clientFetch(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...options.headers, ...(cookie ? { cookie } : {}) } });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0]; return response;
}
let failed = false;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function call(path, body, method = body ? "POST" : "GET") {
  const response = await clientFetch(base + path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  assert(response.ok, `${method} ${path}: HTTP ${response.status} ${response.ok ? "" : await response.text()}`); return response;
}
async function upload(path, bytes, name, mime) {
  const form = new FormData(); form.append("file", new File([bytes], name, { type: mime }));
  const response = await clientFetch(base + path, { method: "POST", body: form }); assert(response.ok, `Upload failed: ${await response.clone().text()}`); return response.json();
}
function parseEvents(text) { return text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))); }
try {
  let healthy = false;
  for (let i = 0; i < 100; i++) { try { const response = await clientFetch(base + "/healthz"); const health = await response.json(); if (health.ok && health.mock) { healthy = true; break; } } catch {} await Bun.sleep(100); }
  assert(healthy, "Mock server did not become healthy"); console.log("PASS healthz: ok=true, mock=true");
  const runningConfig = await (await call("/api/config")).json(); assert(runningConfig.dataDirConfigured === true && !("dataDir" in runningConfig), "Config leaks a path");
  const corpus = await (await call("/v1/corpora", { name: "Smoke knowledge" })).json();
  const fixture = "# Warehouse policy\n\nThe warehouse stocks 120 bolts and 340 nuts. Standard orders ship within three business days. Returns are accepted for thirty days with a receipt.\n\n# Support hours\n\nWarehouse support is available Monday through Friday from 09:00 to 17:00 UTC.";
  const fixturePath = join(directory, "warehouse.txt"); await Bun.write(fixturePath, fixture);
  const source = await upload(`/v1/corpora/${corpus.id}/sources`, await Bun.file(fixturePath).arrayBuffer(), "warehouse.txt", "text/plain");
  let status;
  for (let i = 0; i < 100; i++) { status = await (await call(`/v1/sources/${source.sourceId}`)).json(); if (["indexed", "failed"].includes(status.status)) break; await Bun.sleep(100); }
  assert(status.status === "indexed" && status.chunk_count > 0, `Ingestion failed: ${JSON.stringify(status)}`); console.log(`PASS ingestion: indexed, ${status.chunk_count} chunks`);
  const duplicate = await upload(`/v1/corpora/${corpus.id}/sources`, fixture, "warehouse.txt", "text/plain"); assert(duplicate.sourceId === source.sourceId && duplicate.deduplicated, "Source dedupe failed");
  const search = await (await call(`/v1/corpora/${corpus.id}/search`, { query: "warehouse bolts orders" })).json(); assert(search.hits.length > 0 && typeof search.hits[0].score === "number", "Search returned no scored hits"); console.log(`PASS retrieval and deduplication: ${search.hits.length} scored hits`);
  const thread = await (await call("/v1/threads", { surface: "knowledge", title: "Smoke conversation" })).json();
  const text = await (await call(`/v1/threads/${thread.id}/turns`, { text: "How many bolts does the warehouse stock?", corpusId: corpus.id })).text(), events = parseEvents(text);
  for (const kind of ["turn.start", "text.delta", "citations.set", "turn.end"]) assert(events.some(event => event.kind === kind), `Missing SSE event ${kind}`);
  assert(events.find(event => event.kind === "citations.set").citations.length > 0, "No citations returned");
  assert(events.filter(event => event.kind === "text.delta").map(event => event.text).join("").includes('[S1]'), "English answer lost its ASCII citation");
  assert(events.every((event, index) => event.v === 1 && event.seq === index + 1), "SSE version or sequence invalid");
  const replay = await clientFetch(base + `/v1/threads/${thread.id}/events?after=${events.at(-1).seq - 1}`); const reader = replay.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value); await reader.cancel(); assert(first.includes(`id: ${events.at(-1).seq}`) && first.includes("retry: 3000"), "SSE replay did not resume"); console.log("PASS chat SSE and resume: turn.start, text.delta, citations.set, turn.end");
  const blocked = parseEvents(await (await call(`/v1/threads/${thread.id}/turns`, { text: "BLOCKME" })).text()); assert(blocked.some(event => event.kind === "guardrail.verdict" && event.verdict === "refuse"), "BLOCKME was not refused"); console.log("PASS guardrail: BLOCKME refused");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const asset = await upload("/v1/assets", png, "sample.png", "image/png"); const vision = await (await call("/v1/vision/analyses", { assetId: asset.assetId, task: "table" })).json(); assert(vision.result.columns.length > 0 && vision.result.rows.length > 0, "Vision result is empty"); console.log("PASS vision: structured table returned");
  const session = await (await call("/v1/voice/sessions", {})).json(); const voice = await (await call(`/v1/voice/sessions/${session.sessionId}/turns`, { speaker: "caller", transcript: "How many bolts are stocked?" })).json(); assert(voice.reply.length > 0, "Voice reply is empty"); const logged = await (await call(`/v1/voice/sessions/${session.sessionId}`)).json(); assert(logged.segments.length === 2, "Voice transcript was not logged");
  const bad = await clientFetch(base + "/v1/assets", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const problem = await bad.json(); assert(bad.status === 415 && bad.headers.get("content-type").includes("application/problem+json") && bad.headers.get("x-trace-id") === problem.trace_id, "Problem response invalid"); console.log("PASS voice transcript, problem+json, and trace ID");
  // Legacy rows remain private until explicitly assigned by an operator.
  assert((await clientFetch(base + '/v1/corpora/legacy/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"refund"}' })).status === 404, 'Legacy rows exposed anonymously');
  const owner = new Bun.CryptoHasher('sha256').update(cookie.split('=')[1]).digest('hex');
  const ownershipDb = new Database(join(directory, 'sabbia.db'));
  ownershipDb.prepare("UPDATE corpora SET visitor_id=? WHERE id IN ('legacy','overlap')").run(owner); ownershipDb.close(true);
  const migrated = await (await call('/v1/corpora/legacy/search', { query: 'refund' })).json();
  assert(migrated.hits[0]?.heading === 'Refund policy' && migrated.hits[0].score >= 0.99, 'Migration lost the English hit or its score');
  const inspection = new Database(join(directory, 'sabbia.db'));
  assert(inspection.query("SELECT sql FROM sqlite_master WHERE name='chunks_fts'").get().sql.includes("tokenize='trigram'"), 'Trigram migration did not run');
  assert(inspection.query('SELECT version FROM schema_migrations WHERE version=2').get(), 'Migration version missing');
  console.log(`PASS migration: existing English row retained, refund score=${migrated.hits[0].score}`);
  const chinese = await (await call('/v1/corpora', { name: 'Fixture only' })).json();
  const chineseFixture = '# Hollow shell design\n\nThe scheme uses a hollow structure and emphasises depth and space.\n\n## Material selection\n\nLightweight foam forms the body, coated with white paint.\n\n## Installation\n\nFix the base, mount the supports, then check every joint.';
  const chineseSource = await upload(`/v1/corpora/${chinese.id}/sources`, chineseFixture, 'hollow-shell-design.md', 'text/markdown');
  let chineseStatus;
  for (let i = 0; i < 100; i++) { chineseStatus = await (await call(`/v1/sources/${chineseSource.sourceId}`)).json(); if (['indexed', 'failed'].includes(chineseStatus.status)) break; await Bun.sleep(100); }
  assert(chineseStatus.status === 'indexed', `Chinese ingestion failed: ${JSON.stringify(chineseStatus)}`);
  const exact = await (await call(`/v1/corpora/${chinese.id}/search`, { query: 'hollow shell design' })).json();
  assert(!exact.insufficient && exact.hits[0]?.score >= 0.9, 'Exact match did not comfortably clear 0.18');
  console.log(`PASS exact match: indexed ${chineseStatus.chunk_count} chunks, score=${exact.hits[0].score}`);
  const partial = await (await call(`/v1/corpora/${chinese.id}/search`, { query: 'shell' })).json();
  assert(!partial.insufficient && partial.hits[0]?.score > 0, 'Partial query returned no hit');
  console.log(`PASS partial match: shell, score=${partial.hits[0].score}`);
  const mixed = await (await call(`/v1/corpora/${chinese.id}/search`, { query: 'design hollow shell' })).json();
  assert(!mixed.insufficient && mixed.hits.length > 0, 'Reordered query returned no hit');
  console.log('PASS reordered terms: reordered query terms retrieve passages');
  const titleHit = await (await call('/v1/corpora/legacy/search', { query: 'ArchiveNebula' })).json();
  assert(titleHit.hits[0]?.chunkId === 'legacy-chunk', 'Source title was not indexed');
  assert(inspection.query("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").get('"ArchiveNebula"'), 'Source title missing from the FTS index');
  inspection.prepare("UPDATE sources SET title='RenamedNebula.md' WHERE id='legacy-source'").run();
  const renamed = await (await call('/v1/corpora/legacy/search', { query: 'RenamedNebula' })).json();
  assert(renamed.hits[0]?.sourceTitle === 'RenamedNebula.md', 'Source title trigger failed');
  inspection.exec("INSERT INTO chunks(id,source_id,ordinal,heading,content,token_count,created_at,source_title) VALUES('temporary','legacy-source',2,'Temporary','ZephyrMarker',1,datetime('now'),'RenamedNebula.md'); UPDATE chunks SET content='ChangedMarker' WHERE id='temporary'; DELETE FROM chunks WHERE id='temporary'; INSERT INTO chunks_fts(chunks_fts,rank) VALUES('integrity-check',1);");
  console.log('PASS source title and triggers: filename search, rename, insert/update/delete integrity');
  const chatThread = await (await call('/v1/threads', { surface: 'knowledge', title: 'Chinese conversation' })).json();
  const localTurn = async text => {
    const stream = parseEvents(await (await call(`/v1/threads/${chatThread.id}/turns`, { text, corpusId: chinese.id })).text());
    assert(!stream.some(event => event.kind === 'error'), 'Local turn failed');
    const reply = stream.filter(event => event.kind === 'text.delta').map(event => event.text).join('');
    assert(!/missing source passages|No related heading|do not cover/i.test(reply) && reply.length > 0, `Unexpected local reply: ${reply}`);
    assert(!stream.some(event => event.kind === 'citations.set' && event.citations.length), 'Local reply unexpectedly retrieved documents');
    return reply;
  };
  const greeting = await localTurn('hello'); assert(/hello/i.test(greeting), 'Greeting not natural');
  assert(/welcome/i.test(await localTurn('thanks')) && /goodbye/i.test(await localTurn('bye')), 'Thanks or farewell reply not natural');
  assert(inspection.query('SELECT COUNT(*) AS count FROM model_calls WHERE thread_id=?').get(chatThread.id).count === 0, 'Greeting incurred model calls');
  console.log('PASS greeting: natural reply, zero model calls');
  await localTurn('what can you do');
  assert(inspection.query('SELECT COUNT(*) AS count FROM model_calls WHERE thread_id=?').get(chatThread.id).count === 0, 'Capability reply incurred model calls');
  console.log('PASS capability: local answer, zero model calls');
  const english = await (await call(`/v1/corpora/${corpus.id}/search`, { query: 'warehouse' })).json();
  assert(english.hits[0]?.heading === 'Warehouse policy' && english.hits[0].score > 0.18, 'English exact regression');
  console.log(`PASS English regression: uploaded document hit, score=${english.hits[0].score}`);
  const ungrounded = 'What is the refund policy for lunar orbit?';
  const missing = await (await call(`/v1/corpora/${chinese.id}/search`, { query: ungrounded })).json();
  assert(missing.insufficient && missing.hits.length === 0, 'Fallback too permissive for unrelated question');
  const refusalEvents = parseEvents(await (await call(`/v1/threads/${chatThread.id}/turns`, { text: ungrounded, corpusId: chinese.id })).text());
  const refusal = refusalEvents.filter(event => event.kind === 'text.delta').map(event => event.text).join('');
  assert(refusal.length > 0 && !/corpus|chunk|closest heading|upload a document|try a focused search|\[S/i.test(refusal), `Insufficient reply leaked diagnostics: ${refusal}`);
  console.log('PASS ungrounded: insufficient search and natural fallback without diagnostics');
  const overlap = await (await call('/v1/corpora/overlap/search', { query: 'alpha beta gamma delta epsilon zeta' })).json();
  assert(!overlap.insufficient && overlap.hits.some(hit => hit.chunkId === 'overlap-target'), 'Bounded overlap fallback missed a chunk beyond per-term limits');
  inspection.close(true);
  console.log('PASS bounded fallback: two distinct term pairs recover the passage after candidate limits');
  // Import application modules only after pointing them at the isolated database.
  process.env.SABBIA_MOCK = '1'; process.env.SABBIA_DATA_DIR = directory; process.env.SABBIA_LOG_LEVEL = 'warn';
  const { normalizeCitations } = await import('./src/rag.ts');
  const { db, threads, turns, events: journalEvents } = await import('./src/db.ts');
  const { runTurn } = await import('./src/agents.ts');
  const { chat, chatStream } = await import('./src/nvidia.ts');
  const normalized = normalizeCitations('Need 14 units【S1】, budget〔S2〕, see (S3).');
  assert(normalized === 'Need 14 units[S1], budget[S2], see [S3].', 'Citation normalization changed other text');
  for (const [open, close] of [['【','】'], ['〔','〕'], ['［','］'], ['（','）'], ['(',')'], ['[',']']]) {
    for (const letter of ['s', 'S']) assert(normalizeCitations(`${open}${letter}12${close}`) === '[S12]', 'Citation form not normalized');
  }
  const untouched = '14 units, 1.5 ton, 2026 [3] (S) 【S1] ordinary text';
  assert(normalizeCitations(untouched) === untouched && normalizeCitations(normalized) === normalized, 'Normalization touched non-markers or is not idempotent');
  console.log('PASS citation normalization: all six bracket pairs, lowercase, unrelated text, idempotence');

  const answerEvents = parseEvents(await (await call(`/v1/threads/${chatThread.id}/turns`, { text: 'What material does the hollow shell design use?', corpusId: chinese.id })).text());
  const answer = answerEvents.filter(event => event.kind === 'text.delta').map(event => event.text).join('');
  assert(!answerEvents.some(event => event.kind === 'error') && /\[S\d+\]/.test(answer) && /foam/i.test(answer) && !answer.includes('could not produce a reliably cited answer'), `Grounded answer failed: ${answer}`);
  console.log('PASS grounded answer end-to-end: uploaded fixture, grounded text, ASCII citations in SSE');

  const stubThread = threads.create('knowledge', 'Citation normalization stub');
  process.env.SABBIA_MOCK_TEXT_MAIN_REPLY = 'Use lightweight foam【S1】.';
  try {
    const result = await runTurn(stubThread.id, 'What material does the hollow shell design use?', chinese.id);
    const stored = JSON.parse(turns.get(result.turnId, stubThread.id).blocks_json).find(block => block.kind === 'text').text;
    const streamed = [...journalEvents.after(stubThread.id, 0)].filter(event => event.kind === 'text.delta').map(event => event.text).join('');
    assert(result.reply === 'Use lightweight foam[S1].' && stored === result.reply && streamed === stored, 'Full-width citation was not normalized before SSE and storage');
    assert(db.query("SELECT COUNT(*) AS n FROM model_calls WHERE thread_id=? AND role='textMain'").get(stubThread.id).n === 1, 'Valid full-width marker caused an unnecessary retry');
    for (const index of [0, 999]) {
      process.env.SABBIA_MOCK_TEXT_MAIN_REPLY = `Invalid source【s${index}】`;
      const invalidThread = threads.create('knowledge');
      const invalid = await runTurn(invalidThread.id, 'What material does the hollow shell design use?', chinese.id);
      assert(invalid.reply.includes('could not produce a reliably cited answer'), 'Out-of-range citation was accepted');
      assert(db.query("SELECT COUNT(*) AS n FROM model_calls WHERE thread_id=? AND role='textMain'").get(invalidThread.id).n === 2, 'Invalid index must trigger exactly one retry');
    }
  } finally { delete process.env.SABBIA_MOCK_TEXT_MAIN_REPLY; }
  console.log('PASS full-width tolerance: stored/SSE [S1], no retry; invalid indices retry once then fall back');

  const longQuery = 'Please explain which specific technical requirements the foam has to meet';
  const longSearch = await (await call(`/v1/corpora/${chinese.id}/search`, { query: longQuery })).json();
  assert(!longSearch.insufficient && longSearch.hits.some(hit => hit.score >= 0.5), 'Long question suffered scoring dilution');
  const gated = Bun.spawn([process.execPath, '--eval', `const {retrieve}=await import('./src/rag.ts'); const r=await retrieve(${JSON.stringify(longQuery)},${JSON.stringify(chinese.id)}); if(!r.insufficient || r.hits.length) process.exit(1);`], { env: { ...process.env, SABBIA_RETRIEVAL_MIN_SCORE: '1', SABBIA_DENSE_RETRIEVAL: '0' }, stdout: 'pipe', stderr: 'pipe' });
  const gatedOutput = Promise.all([new Response(gated.stdout).text(), new Response(gated.stderr).text()]);
  assert(await gated.exited === 0, `Minimum-score gate failed: ${(await gatedOutput).join('')}`);
  console.log(`PASS scoring: long question score=${longSearch.hits[0].score}, configured minimum still enforced`);

  const syntheticId = 'missing-telemetry-thread';
  const completion = await chat('textMain', [{ role: 'user', content: 'Return a short answer.' }], syntheticId);
  assert(completion.content.length > 0 && db.query("SELECT COUNT(*) AS n FROM model_calls WHERE thread_id IS NULL AND role='textMain'").get().n > 0, 'Unknown telemetry thread aborted completion or was not stored as NULL');
  db.exec("CREATE TEMP TRIGGER smoke_telemetry_failure BEFORE INSERT ON model_calls BEGIN SELECT RAISE(ABORT,'forced telemetry failure'); END;");
  const warnings = [], originalLog = console.log;
  console.log = (...args) => warnings.push(args.join(' '));
  try {
    const resilient = await chat('textMain', [{ role: 'user', content: 'Return content despite telemetry failure.' }], syntheticId);
    const streamed = await chatStream('textMain', [{ role: 'user', content: 'Return streamed content.' }], syntheticId, () => {});
    assert(resilient.content.length > 0 && streamed.content.length > 0 && warnings.some(line => line.includes('"level":"warn"') && line.includes('Model telemetry insert failed')), 'Telemetry insert failure was not warned and swallowed');
  } finally { console.log = originalLog; db.exec('DROP TRIGGER smoke_telemetry_failure'); }
  db.close(true);
  console.log('PASS telemetry resilience: unknown thread stored as NULL; insert failure warns, completions succeed');
  console.log("SMOKE PASS: all 25 checks passed (20 existing + 5 citation/scoring/telemetry checks)");
} catch (error) { failed = true; console.error(`SMOKE FAIL: ${error.message}`); }
finally {
  child.kill(); await child.exited;
  const output = (await stdout) + (await stderr); if (failed && output.trim()) console.error(output);
  const root = resolve(tmpdir()) + sep, target = resolve(directory);
  if (target.startsWith(root) && target.slice(root.length).startsWith("sabbia-smoke-") && !target.slice(root.length).includes(sep)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(failed ? 1 : 0);
JS

bun run scripts/abuse-smoke.ts
# Includes dense cosine relevance, judge confidence precedence, lexical scores and nonzero paraphrase citations.
bun run scripts/vector-smoke.ts
bun run scripts/map-verify-smoke.ts

# Conversational short circuits, natural fallback and calibrated dense floor.
bun run scripts/conversation-smoke.ts
bun run scripts/behavior-smoke.ts

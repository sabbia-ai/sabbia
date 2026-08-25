import { Database } from "bun:sqlite";
import { owns, visitorId } from "./context";
import { config, log } from "./config";

export const db = new Database(`${config.dataDir}/sabbia.db`, { create: true, strict: true });
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, surface TEXT NOT NULL, title TEXT NOT NULL, agent_key TEXT, last_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), ordinal INTEGER NOT NULL, author TEXT NOT NULL, agent_key TEXT, blocks_json TEXT NOT NULL, usage_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(thread_id,ordinal));
CREATE TABLE IF NOT EXISTS thread_events(thread_id TEXT NOT NULL REFERENCES threads(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(thread_id,seq));
CREATE TABLE IF NOT EXISTS corpora(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, corpus_id TEXT NOT NULL REFERENCES corpora(id), title TEXT NOT NULL, mime TEXT NOT NULL, object_key TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','extracting','chunking','indexed','failed')), fail_reason TEXT, chunk_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(corpus_id,sha256));
CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, heading TEXT NOT NULL, content TEXT NOT NULL, token_count INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, object_key TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER, height INTEGER, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vision_runs(id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), thread_id TEXT REFERENCES threads(id), task TEXT NOT NULL, model TEXT NOT NULL, result_json TEXT NOT NULL, latency_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS voice_sessions(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), stt_mode TEXT NOT NULL, tts_voice TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS voice_segments(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES voice_sessions(id), speaker TEXT NOT NULL, transcript TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, interrupted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS guardrail_hits(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), turn_id TEXT REFERENCES turns(id), rule TEXT NOT NULL, verdict TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_calls(id TEXT PRIMARY KEY, thread_id TEXT REFERENCES threads(id), role TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, latency_ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), turn_id TEXT NOT NULL REFERENCES turns(id), rating INTEGER NOT NULL CHECK(rating IN (-1,0,1)), note TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS escalations(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS source_corpus ON sources(corpus_id);
CREATE INDEX IF NOT EXISTS chunk_source ON chunks(source_id);
CREATE INDEX IF NOT EXISTS thread_surface ON threads(surface,created_at);
INSERT OR IGNORE INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);

// Keep titles on the external-content rows so rebuilds and cascading deletes use
// exactly the same values as the index, even after the parent source is deleted.
db.transaction(() => {
  const definition = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='chunks_fts'").get()?.sql ?? "";
  if (/tokenize\s*=\s*'trigram'/i.test(definition) && /source_title/i.test(definition)) return;
  db.exec("DROP TRIGGER IF EXISTS chunks_insert; DROP TRIGGER IF EXISTS chunks_delete; DROP TRIGGER IF EXISTS chunks_update; DROP TRIGGER IF EXISTS source_title_update;");
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(chunks)").all();
  if (!columns.some(column => column.name === "source_title")) db.exec("ALTER TABLE chunks ADD COLUMN source_title TEXT NOT NULL DEFAULT ''");
  db.exec(`UPDATE chunks SET source_title=(SELECT title FROM sources WHERE sources.id=chunks.source_id);
DROP TABLE IF EXISTS chunks_fts;
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, heading, source_title, content='chunks', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,content,heading,source_title) VALUES(new.rowid,new.content,new.heading,new.source_title); END;
CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,content,heading,source_title) VALUES('delete',old.rowid,old.content,old.heading,old.source_title); END;
CREATE TRIGGER chunks_update AFTER UPDATE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,content,heading,source_title) VALUES('delete',old.rowid,old.content,old.heading,old.source_title); INSERT INTO chunks_fts(rowid,content,heading,source_title) VALUES(new.rowid,new.content,new.heading,new.source_title); END;
CREATE TRIGGER source_title_update AFTER UPDATE OF title ON sources BEGIN UPDATE chunks SET source_title=new.title WHERE source_id=new.id; END;
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
INSERT OR IGNORE INTO schema_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
}).immediate();
// Nullable ownership preserves legacy/operator rows without exposing them to visitors.
db.transaction(() => {
  for (const table of ["threads", "corpora", "assets"]) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!columns.some(c => c.name === "visitor_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN visitor_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_visitor ON ${table}(visitor_id)`);
  }
  if (!db.query<{ name: string }, []>("PRAGMA table_info(corpora)").all().some(c => c.name === "is_public")) db.exec("ALTER TABLE corpora ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS visitors(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_log(id TEXT PRIMARY KEY, at TEXT NOT NULL, visitor_hash TEXT NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, resource_kind TEXT, resource_id TEXT, status INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_budget(day TEXT PRIMARY KEY, used INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS access_log_at ON access_log(at);
    INSERT OR IGNORE INTO schema_migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
}).immediate();
db.transaction(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS chunk_vectors (
    chunk_id TEXT PRIMARY KEY, corpus_id TEXT NOT NULL, model TEXT NOT NULL,
    dim INTEGER NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunk_vectors_corpus ON chunk_vectors(corpus_id);
  CREATE TRIGGER IF NOT EXISTS chunk_vector_delete AFTER DELETE ON chunks BEGIN
    DELETE FROM chunk_vectors WHERE chunk_id=old.id;
  END;
  INSERT OR IGNORE INTO schema_migrations VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
}).immediate();
// Bound metadata, chunks, event journals, and telemetry as well as uploads.
const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
const existingPages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
db.exec(`PRAGMA max_page_count=${Math.max(existingPages, Math.floor(config.maxDatabaseBytes / pageSize))}`);
export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export function withTx<T>(fn: () => T): T { return db.transaction(fn)(); }
export function writable(): boolean { try { withTx(() => db.exec("UPDATE schema_migrations SET version=version WHERE version=1")); return true; } catch { return false; } }
export interface Thread { visitor_id: string | null; id: string; workspace_id: string; surface: string; title: string; agent_key: string | null; last_seq: number; created_at: string; archived_at: string | null }
export interface Turn { id: string; thread_id: string; ordinal: number; author: string; agent_key: string | null; blocks_json: string; usage_json: string; created_at: string }
export interface Corpus { visitor_id: string | null; is_public: number; id: string; name: string; created_at: string; source_count?: number }
export interface Source { id: string; corpus_id: string; title: string; mime: string; object_key: string; byte_size: number; sha256: string; status: string; fail_reason: string | null; chunk_count: number; created_at: string }
export interface Chunk { id: string; source_id: string; ordinal: number; heading: string; content: string; token_count: number }
export interface Asset { visitor_id: string | null; id: string; object_key: string; mime: string; sha256: string; width: number | null; height: number | null }
export interface VoiceSession { id: string; thread_id: string; stt_mode: string; tts_voice: string; started_at: string; ended_at: string | null }
export interface JournalEvent { v: 1; seq: number; kind: string; [key: string]: unknown }

// Threads and turns
const insertThread = db.prepare("INSERT INTO threads(id,workspace_id,surface,title,agent_key,created_at,visitor_id) VALUES(?,'default',?,?,?,?,?)");
const findThread = db.query<Thread, [string]>("SELECT * FROM threads WHERE id=? AND archived_at IS NULL");
const archiveThread = db.prepare("UPDATE threads SET archived_at=? WHERE id=?");
const insertTurn = db.prepare("INSERT INTO turns VALUES(?,?,(SELECT COALESCE(MAX(ordinal),0)+1 FROM turns WHERE thread_id=?),?,?,?,?,?)");
const lastTurns = db.query<Turn, [string]>("SELECT * FROM (SELECT * FROM turns WHERE thread_id=? ORDER BY ordinal DESC LIMIT 50) ORDER BY ordinal");
const turnById = db.query<Turn, [string, string]>("SELECT * FROM turns WHERE id=? AND thread_id=?");
export const threads = {
  create(surface: string, title = "New conversation") { const id = uuid(); insertThread.run(id, surface, title, surface === "knowledge" || surface === "console" ? "rag" : surface, now(), visitorId()); return findThread.get(id)!; },
  get: (id: string) => { const row = findThread.get(id); return owns(row) ? row : null; }, list: (surface = "", limit = 30, cursor = "") => db.query<Thread, [string | null, string, string, string, string, number]>("SELECT * FROM threads WHERE visitor_id=? AND archived_at IS NULL AND (?='' OR surface=?) AND (?='' OR created_at||id < ?) ORDER BY created_at DESC,id DESC LIMIT ?").all(visitorId(), surface, surface, cursor, cursor, limit), archive: (id: string) => archiveThread.run(now(), id),
};
export const turns = {
  add(threadId: string, author: string, blocks: unknown[], usage: unknown = {}, agent: string | null = null, id = uuid()) { insertTurn.run(id, threadId, threadId, author, agent, JSON.stringify(blocks), JSON.stringify(usage), now()); return id; },
  list: (threadId: string) => lastTurns.all(threadId), get: (id: string, threadId: string) => turnById.get(id, threadId),
};
// Event journal: sequence allocation and persistence are one SQLite transaction.
const bumpSequence = db.query<{ last_seq: number }, [string]>("UPDATE threads SET last_seq=last_seq+1 WHERE id=? RETURNING last_seq");
const insertEvent = db.prepare("INSERT INTO thread_events VALUES(?,?,?,?,?)");
const replayEvents = db.query<{ payload_json: string }, [string, number]>("SELECT payload_json FROM thread_events WHERE thread_id=? AND seq>? ORDER BY seq");
export const events = {
  append(threadId: string, kind: string, payload: Record<string, unknown>) { return withTx(() => { const seq = bumpSequence.get(threadId)!.last_seq; const event: JournalEvent = { ...payload, v: 1, seq, kind }; insertEvent.run(threadId, seq, kind, JSON.stringify(event), now()); return event; }); },
  after: function* (id: string, seq: number) { for (const row of replayEvents.iterate(id, seq)) yield JSON.parse(row.payload_json) as JournalEvent; },
};
// Corpora, sources and chunks
const insertCorpus = db.prepare("INSERT INTO corpora(id,workspace_id,name,created_at,visitor_id) VALUES(?,'default',?,?,?)");
const ownCorpora = db.query<Corpus, [string | null]>("SELECT c.*,COUNT(s.id) AS source_count FROM corpora c LEFT JOIN sources s ON s.corpus_id=c.id WHERE c.visitor_id=? GROUP BY c.id ORDER BY c.created_at,c.id");
const findCorpus = db.query<Corpus, [string]>("SELECT * FROM corpora WHERE id=?");
const insertSource = db.prepare("INSERT INTO sources(id,corpus_id,title,mime,object_key,byte_size,sha256,status,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)");
const findSource = db.query<Source, [string]>("SELECT * FROM sources WHERE id=?");
const duplicateSource = db.query<Source, [string, string]>("SELECT * FROM sources WHERE corpus_id=? AND sha256=?");
const listSources = db.query<Source, [string]>("SELECT * FROM sources WHERE corpus_id=? ORDER BY created_at DESC");
const updateSource = db.prepare("UPDATE sources SET status=?,chunk_count=?,fail_reason=? WHERE id=?");
const deleteSource = db.prepare("DELETE FROM sources WHERE id=?");
const insertChunk = db.prepare("INSERT INTO chunks(id,source_id,ordinal,heading,content,token_count,created_at,source_title) VALUES(?,?,?,?,?,?,?,(SELECT title FROM sources WHERE id=?))");
export const corpora = { create(name: string) { const id = uuid(); insertCorpus.run(id, name, now(), visitorId()); return findCorpus.get(id)!; }, list: () => ownCorpora.all(visitorId()),
  defaultId: () => db.query<{ id: string }, [string | null]>("SELECT id FROM corpora WHERE visitor_id=? OR is_public=1 ORDER BY is_public,created_at,id LIMIT 1").get(visitorId())?.id,
  get: (id: string) => { const row = findCorpus.get(id); return owns(row) || row?.is_public === 1 ? row : null; } };
export const sources = {
  create(corpus: string, title: string, mime: string, objectKey: string, bytes: number, hash: string) { const id = uuid(); insertSource.run(id, corpus, title, mime, objectKey, bytes, hash, now()); return findSource.get(id)!; },
  get: (id: string) => { const row = findSource.get(id); return row && corpora.get(row.corpus_id) ? row : null; }, duplicate: (corpus: string, hash: string) => duplicateSource.get(corpus, hash), list: (corpus: string) => listSources.all(corpus),
  update: (id: string, status: string, count = 0, reason: string | null = null) => updateSource.run(status, count, reason, id), remove: (id: string) => deleteSource.run(id),
};
export const chunks = { add(source: string, ordinal: number, heading: string, content: string) { insertChunk.run(uuid(), source, ordinal, heading, content, Math.ceil(content.length / 4), now(), source); } };

interface VectorRow { chunk_id: string; corpus_id: string; model: string; dim: number; vector: Uint8Array; created_at: string }
export const vectors = {
  add(chunkId: string, corpusId: string, model: string, vector: number[]) {
    if (!vector.length || !vector.every(Number.isFinite)) throw new Error("Invalid chunk vector");
    const f32 = new Float32Array(vector);
    // The source may have been deleted while its embedding request was in flight.
    db.prepare(`INSERT OR REPLACE INTO chunk_vectors(chunk_id,corpus_id,model,dim,vector,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM chunks c JOIN sources s ON s.id=c.source_id WHERE c.id=? AND s.corpus_id=? AND s.status='indexed')`)
      .run(chunkId, corpusId, model, f32.length, Buffer.from(f32.buffer), now(), chunkId, corpusId);
  },
  getByCorpus(corpusId: string, model: string) {
    return db.query<VectorRow, [string, string]>("SELECT * FROM chunk_vectors WHERE corpus_id=? AND model=? ORDER BY rowid").all(corpusId, model).map(row => ({
      ...row, vector: new Float32Array(Uint8Array.from(row.vector).buffer),
    }));
  },
  count(corpusId: string, model: string) {
    return db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM chunk_vectors WHERE corpus_id=? AND model=?").get(corpusId, model)!.n;
  },
};
// Assets and vision analyses
const insertAsset = db.prepare("INSERT INTO assets(id,workspace_id,object_key,mime,width,height,sha256,created_at,visitor_id) VALUES(?,'default',?,?,?,?,?,?,?)");
const findAsset = db.query<Asset, [string]>("SELECT * FROM assets WHERE id=?");
const insertVision = db.prepare("INSERT INTO vision_runs VALUES(?,?,?,?,?,?,?,?)");
export const assets = { add(objectKey: string, mime: string, hash: string, width: number | null, height: number | null) { const id = uuid(); insertAsset.run(id, objectKey, mime, width, height, hash, now(), visitorId()); return id; }, get: (id: string) => { const row = findAsset.get(id); return owns(row) ? row : null; } };
export const visionRuns = { add(asset: string, thread: string | null, task: string, model: string, result: unknown, latency: number) { const id = uuid(); insertVision.run(id, asset, thread, task, model, JSON.stringify(result), latency, now()); return id; } };
// Voice sessions and segments
const insertSession = db.prepare("INSERT INTO voice_sessions VALUES(?,?,'browser','default',?,NULL)");
const findSession = db.query<VoiceSession, [string]>("SELECT * FROM voice_sessions WHERE id=?");
const latestSession = db.query<VoiceSession, [string]>("SELECT * FROM voice_sessions WHERE thread_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1");
const insertSegment = db.prepare("INSERT INTO voice_segments VALUES(?,?,?,?,?,?,?)");
const getSegments = db.prepare("SELECT * FROM voice_segments WHERE session_id=? ORDER BY start_ms,rowid");
const endSession = db.prepare("UPDATE voice_sessions SET ended_at=? WHERE id=?");
const interruptSegment = db.prepare("UPDATE voice_segments SET interrupted=1 WHERE id=(SELECT id FROM voice_segments WHERE session_id=? AND speaker='assistant' ORDER BY rowid DESC LIMIT 1)");
export const voiceSessions = { create(thread: string) { const id = uuid(); insertSession.run(id, thread, now()); return id; }, get: (id: string) => { const row = findSession.get(id); return row && threads.get(row.thread_id) ? row : null; }, latest: (thread: string) => latestSession.get(thread), end: (id: string) => endSession.run(now(), id) };
export const voiceSegments = { add(session: string, speaker: string, text: string, start: number, end: number, interrupted = false) { insertSegment.run(uuid(), session, speaker, text, start, end, Number(interrupted)); }, list: (session: string) => getSegments.all(session), interrupt: (session: string) => interruptSegment.run(session) };
// Guardrail journal and model telemetry
const insertGuard = db.prepare("INSERT INTO guardrail_hits VALUES(?,?,?,?,?,?,?)");
const recentGuards = db.prepare("SELECT * FROM guardrail_hits WHERE thread_id=? ORDER BY rowid DESC LIMIT 100");
const insertCall = db.prepare("INSERT INTO model_calls VALUES(?,(SELECT id FROM threads WHERE id=?),?,?,?,?,?,?,?,?)");
const usageQuery = db.prepare("SELECT COUNT(*) AS calls,COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,COALESCE(SUM(completion_tokens),0) AS completion_tokens,COALESCE(AVG(latency_ms),0) AS avg_latency_ms,SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failures FROM model_calls WHERE (?='' OR thread_id=?)");
export const guardrails = { add(thread: string, turn: string | null, rule: string, verdict: string, detail: unknown) { insertGuard.run(uuid(), thread, turn, rule, verdict, JSON.stringify(detail), now()); }, list: (id: string) => recentGuards.all(id) };
export const modelCalls = { add(thread: string | null, role: string, model: string, prompt: number, completion: number, latency: number, ok: boolean, error: string | null) {
  try { insertCall.run(uuid(), thread, role, model, prompt, completion, latency, Number(ok), error, now()); }
  catch { log("warn", "Model telemetry insert failed", { extra: { role, model } }); }
}, usage: (thread = "") => usageQuery.get(thread, thread) };
// Feedback and support escalation tools
const insertFeedback = db.prepare("INSERT INTO feedback VALUES(?,?,?,?,?,?)");
const insertEscalation = db.prepare("INSERT INTO escalations(id,thread_id,reason,created_at) VALUES(?,?,?,?)");
export function addFeedback(thread: string, turn: string, rating: number, note: string) { insertFeedback.run(uuid(), thread, turn, rating, note, now()); }
export function openEscalation(thread: string, reason: string) { const id = uuid(); insertEscalation.run(id, thread, reason, now()); return { ticketId: id, status: "open" }; }

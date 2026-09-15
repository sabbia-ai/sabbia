import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { config, log } from "./config";
import { db, now, uuid, corpora, sources, chunks } from "./db";
import { HttpError } from "./http";
import { collectObjects } from "./storage";
import { pendingTurns } from "./agents";
import { pendingIngestion } from "./ingest";

export const visitorCookie = (value: string, age = 2592000) => `sabbia_visitor=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}; Expires=${new Date(Date.now() + age * 1000).toUTCString()}`;
export function operatorAuthorized(request: Request) {
  if (!config.authToken) return false;
  const authorization = request.headers.get("authorization");
  const value = authorization?.startsWith("Bearer ") ? authorization.slice(7) : request.headers.get("x-api-key") ?? "";
  return timingSafeEqual(createHash("sha256").update(value).digest(), createHash("sha256").update(config.authToken).digest());
}
export function identify(request: Request) {
  const token = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith("sabbia_visitor="))?.slice(15);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const id = hash(token);
    if (db.query<{ id: string }, [string, string]>("SELECT id FROM visitors WHERE id=? AND expires_at>?").get(id, now())) return { id, cookie: null };
  }
  if (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM visitors").get()!.n >= 100000) throw new HttpError(429, `Public visitor capacity limit reached; retry availability at ${new Date(Date.now() + 3600000).toISOString()} after retention cleanup`, 3600);
  const value = randomBytes(32).toString("base64url"), id = hash(value);
  db.prepare("INSERT INTO visitors VALUES(?,?,?)").run(id, now(), new Date(Date.now() + 2592000000).toISOString());
  return { id, cookie: visitorCookie(value) };
}
export function audit(visitor: string, method: string, route: string, kind: string | null, id: string | null, status: number) {
  if (method !== "GET" && method !== "DELETE") return;
  db.prepare("INSERT INTO access_log VALUES(?,?,?,?,?,?,?,?)").run(uuid(), now(), visitor, method, route, kind, id, status);
  // Bound the journal even if retention is configured very generously.
  db.exec("DELETE FROM access_log WHERE rowid <= (SELECT MAX(rowid)-100000 FROM access_log)");
}
export const auditHealth = () => ({ reads: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM access_log WHERE method='GET'").get()!.n, deletes: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM access_log WHERE method='DELETE'").get()!.n });
export const deletingVisitors = new Set<string>();
function purge(visitor: string, cutoff: string) {
  return db.transaction(() => {
    const threadIds = db.query<{ id: string }, [string, string]>("SELECT id FROM threads WHERE visitor_id=? AND created_at<?").all(visitor, cutoff).map(r => r.id);
    const corpusIds = db.query<{ id: string }, [string, string]>("SELECT id FROM corpora WHERE visitor_id=? AND created_at<?").all(visitor, cutoff).map(r => r.id);
    let sourceCount = 0, assetCount = 0;
    for (const id of threadIds) {
      db.prepare("DELETE FROM voice_segments WHERE session_id IN (SELECT id FROM voice_sessions WHERE thread_id=?)").run(id);
      for (const table of ["voice_sessions", "vision_runs", "feedback", "escalations", "guardrail_hits", "model_calls", "thread_events", "turns"]) db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(id);
      db.prepare("DELETE FROM threads WHERE id=?").run(id);
    }
    const oldSources = db.query<{ id: string }, [string, string]>("SELECT s.id FROM sources s JOIN corpora c ON c.id=s.corpus_id WHERE c.visitor_id=? AND s.created_at<?").all(visitor, cutoff);
    for (const { id } of oldSources) { db.prepare("DELETE FROM sources WHERE id=?").run(id); sourceCount++; }
    for (const id of corpusIds) {
      sourceCount += db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sources WHERE corpus_id=?").get(id)!.n;
      db.prepare("DELETE FROM sources WHERE corpus_id=?").run(id);
      db.prepare("DELETE FROM corpora WHERE id=?").run(id);
    }
    const oldAssets = db.query<{ id: string }, [string, string]>("SELECT id FROM assets WHERE visitor_id=? AND created_at<?").all(visitor, cutoff);
    for (const { id } of oldAssets) { db.prepare("DELETE FROM vision_runs WHERE asset_id=?").run(id); db.prepare("DELETE FROM assets WHERE id=?").run(id); assetCount++; }
    return { threads: threadIds.length, corpora: corpusIds.length, sources: sourceCount, assets: assetCount };
  }).immediate();
}
export async function deleteVisitor(visitor: string) {
  deletingVisitors.add(visitor);
  try {
    await Promise.allSettled([pendingTurns(), pendingIngestion()]);
    const counts = purge(visitor, "9999");
    db.prepare("DELETE FROM visitors WHERE id=?").run(visitor); collectObjects(); return counts;
  } finally { deletingVisitors.delete(visitor); }
}
export async function retentionSweep() {
  const cutoff = new Date(Date.now() - config.retentionDays * 86400000).toISOString();
  const visitors = db.query<{ id: string }, []>("SELECT id FROM visitors").all();
  // Pause admissions for these visitors while already admitted work finishes.
  for (const { id } of visitors) deletingVisitors.add(id);
  try {
    await Promise.allSettled([pendingTurns(), pendingIngestion()]);
    const counts = { threads: 0, corpora: 0, sources: 0, assets: 0, chunks: 0, objects: 0 };
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()!.n;
    for (const { id } of visitors) { const removed = purge(id, cutoff); for (const key of ["threads", "corpora", "sources", "assets"] as const) counts[key] += removed[key]; }
    counts.chunks = before - db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()!.n;
    counts.objects = collectObjects();
    db.prepare("DELETE FROM access_log WHERE at<?").run(cutoff);
    db.prepare("DELETE FROM visitors WHERE expires_at<? AND id NOT IN (SELECT visitor_id FROM threads WHERE visitor_id IS NOT NULL UNION SELECT visitor_id FROM corpora WHERE visitor_id IS NOT NULL UNION SELECT visitor_id FROM assets WHERE visitor_id IS NOT NULL)").run(now());
    log("info", "Retention sweep", counts);
  } finally { for (const { id } of visitors) deletingVisitors.delete(id); }
}
export function exportVisitor(visitor: string) {
  return { exported_at: now(), threads: db.query("SELECT * FROM threads WHERE visitor_id=?").all(visitor), turns: db.query("SELECT t.* FROM turns t JOIN threads th ON th.id=t.thread_id WHERE th.visitor_id=?").all(visitor), corpora: db.query("SELECT * FROM corpora WHERE visitor_id=?").all(visitor), sources: db.query("SELECT s.id,s.corpus_id,s.title,s.created_at FROM sources s JOIN corpora c ON c.id=s.corpus_id WHERE c.visitor_id=?").all(visitor) };
}
export async function seedDemo() {
  if (db.query("SELECT id FROM corpora WHERE is_public=1").get()) return;
  const content = await Bun.file(new URL("./demo.md", import.meta.url)).text();
  db.transaction(() => {
    const corpus = corpora.create("Shared demo knowledge");
    db.prepare("UPDATE corpora SET is_public=1 WHERE id=?").run(corpus.id);
    const source = sources.create(corpus.id, "Public sample (English and Chinese)", "text/markdown", "bundled-demo", 0, "bundled-demo-v1");
    chunks.add(source.id, 1, "Shipping and returns", content); sources.update(source.id, "indexed", 1);
  }).immediate();
}

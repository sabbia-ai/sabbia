import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

function assert(value: unknown, detail: string): asserts value { if (!value) throw new Error(detail); }
type Client = ReturnType<typeof client>;
function client(base: string, ip = "198.51.100.1") {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", extra: Record<string, string> = {}) {
      const response = await fetch(base + path, { method, headers: { cookie, "x-forwarded-for": ip, ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...extra }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
      const issued = response.headers.get("set-cookie"); if (issued) cookie = issued.split(";")[0]; return response;
    },
    async json<T = { id: string }>(path: string, body?: unknown): Promise<T> {
      const r = await this.request(path, body); assert(r.ok, `${path}: ${r.status} ${await r.clone().text()}`); return r.json() as Promise<T>;
    },
  };
}
function file(text: string) { const form = new FormData(); form.append("file", new File([text], "sample.txt", { type: "text/plain" })); return form; }
async function limited(r: Response, name: string) {
  assert(r.status === 429 && /^\d+$/.test(r.headers.get("retry-after") ?? ""), `${name}: expected 429 and numeric Retry-After, got ${r.status}`);
  const p = await r.json() as { title: string; detail: string }; assert(p.title === "Too many requests" && r.headers.get("content-type")?.includes("application/problem+json") && p.detail.includes(name), `${name}: invalid problem detail`);
}
async function serverTest(label: string, env: Record<string, string>, test: (c: Client, base: string, dir: string, stop: () => Promise<void>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "sabbia-abuse-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = reservation.port!; await reservation.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "run", "src/index.ts"], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), SABBIA_MOCK: "1", SABBIA_DATA_DIR: directory, SABBIA_AUTH_TOKEN: "", SABBIA_LOG_LEVEL: "info", SABBIA_RATE_LIMIT_PER_MIN: "10000", SABBIA_MODEL_RATE_LIMIT_PER_MIN: "1000", SABBIA_MODEL_RATE_LIMIT_GLOBAL_PER_MIN: "1000", SABBIA_MODEL_BUDGET_PER_DAY: "10000", SABBIA_UPLOAD_RATE_PER_HOUR: "1000", ...env }, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text(); let failed = false;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/readyz", { headers: { "x-forwarded-for": "127.0.0.2" } })).ok) { ready = true; break; } } catch {} if (child.exitCode !== null) break; await Bun.sleep(50); }
    assert(ready, "Temporary server failed to start"); const c = client(base); await test(c, base, directory, async () => { child.kill(); await child.exited; }); console.log(`PASS ${label}`);
  } catch (e) { failed = true; console.error(`FAIL ${label}: ${e instanceof Error ? e.message : e}`); throw e; }
  finally {
    child.kill(); await child.exited;
    const logs = (await output) + (await errors); if (failed) console.error(logs);
    const target = resolve(directory), root = resolve(tmpdir()) + sep;
    if (target.startsWith(root) && target.slice(root.length).startsWith("sabbia-abuse-") && !target.slice(root.length).includes(sep)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const searchDemo = async (c: Client) => c.json("/v1/demo/corpus");
await serverTest("per-IP model limit: 429 + Retry-After", { SABBIA_MODEL_RATE_LIMIT_PER_MIN: "2" }, async c => {
  const corpus = await searchDemo(c);
  for (let i = 0; i < 2; i++) await c.json(`/v1/corpora/${corpus.id}/search`, { query: "shipping" });
  await limited(await c.request(`/v1/corpora/${corpus.id}/search`, { query: "shipping" }), "Per-IP model limit");
});
await serverTest("daily model budget: hard stop, health remaining=0, persists on disk", { SABBIA_MODEL_BUDGET_PER_DAY: "2" }, async (c, base, directory) => {
  const corpus = await searchDemo(c);
  await c.json(`/v1/corpora/${corpus.id}/search`, { query: "shipping" });
  const other = client(base, "198.51.100.2"); await other.json(`/v1/corpora/${corpus.id}/search`, { query: "shipping" });
  await limited(await other.request(`/v1/corpora/${corpus.id}/search`, { query: "shipping" }), "public demo budget is spent");
  const h = await c.json<{ limits: { model_remaining_today: number } }>("/healthz"); assert(h.limits.model_remaining_today === 0, "Budget health did not reach zero");
  const db = new Database(join(directory, "sabbia.db")); assert((db.query("SELECT used FROM demo_budget").get() as { used: number }).used === 2, "Budget not persisted"); db.close(true);
});
await serverTest("per-IP request limit: 429", { SABBIA_RATE_LIMIT_PER_MIN: "2" }, async c => {
  await c.json("/healthz"); await c.json("/healthz"); await limited(await c.request("/healthz"), "Per-IP request limit");
});
await serverTest("upload count limit: 429", { SABBIA_UPLOAD_RATE_PER_HOUR: "1" }, async c => {
  const corpus = await c.json("/v1/corpora", { name: "Quota" }); assert((await c.request(`/v1/corpora/${corpus.id}/sources`, file("First"))).ok, "First upload failed");
  await limited(await c.request(`/v1/corpora/${corpus.id}/sources`, file("Second")), "Per-IP upload limit");
});
await serverTest("storage quota: 507, concurrent uploads cannot overbook", { SABBIA_MAX_UPLOAD_TOTAL_MB: "0.001" }, async (c, _base, dir) => {
  const corpus = await c.json("/v1/corpora", { name: "Storage" });
  const results = await Promise.all([c.request(`/v1/corpora/${corpus.id}/sources`, file("a".repeat(700))), c.request(`/v1/corpora/${corpus.id}/sources`, file("b".repeat(700)))]);
  assert(results.filter(r => r.status === 507).length === 1 && results.filter(r => r.status === 202).length === 1, "Storage reservation race");
  const problem = await results.find(r => r.status === 507)!.json() as { title: string; detail: string }; assert(problem.title === "Storage quota exceeded" && /maximum/.test(problem.detail), "Storage problem invalid");
  const health = await c.json<{ storage: { used_mb: number } }>("/healthz"); assert(health.storage.used_mb === 700 / 1048576, "Storage accounting inaccurate");
  // Assets share the same quota.
  const form = new FormData(); form.append("file", new File([Buffer.from("GIF89a" + "c".repeat(600))], "test.gif", { type: "image/gif" }));
  assert((await c.request("/v1/assets", form)).status === 507, "Asset escaped aggregate quota");
});
await serverTest("sources per corpus: 409", { SABBIA_MAX_SOURCES: "1" }, async c => {
  const corpus = await c.json("/v1/corpora", { name: "Sources" });
  const results = await Promise.all([c.request(`/v1/corpora/${corpus.id}/sources`, file("First")), c.request(`/v1/corpora/${corpus.id}/sources`, file("Second"))]);
  assert(results.some(r => r.status === 202) && results.some(r => r.status === 409), "Source cap did not reject second upload");
});
await serverTest("concurrent streams per IP: 429; disconnect releases slot", { SABBIA_MAX_CONCURRENT_STREAMS_PER_IP: "1" }, async c => {
  const thread = await c.json("/v1/threads", { surface: "knowledge" }); const stream = await c.request(`/v1/threads/${thread.id}/events`); assert(stream.ok, "Stream failed");
  await limited(await c.request(`/v1/threads/${thread.id}/events`), "Per-IP concurrent stream limit"); await stream.body!.cancel();
  await Bun.sleep(100); const next = await c.request(`/v1/threads/${thread.id}/events`); assert(next.ok, "Stream slot leaked"); await next.body!.cancel();
});
await serverTest("config has no absolute path or provider key material", {}, async c => {
  const r = await c.request("/api/config"), text = await r.text();
  assert(!/:\s*"(?:\/|[A-Za-z]:[\\/])/.test(text) && !/nvapi-|NVIDIA_API_KEY|secret/i.test(text) && !text.includes('"dataDir"'), "Config leaks host or credentials");
});
await serverTest("destructive auth: anonymous GET=200, DELETE=401, authorized DELETE=200", { SABBIA_AUTH_TOKEN: "smoke-operator-secret" }, async c => {
  assert((await c.request("/v1/threads")).status === 200, "GET auth wall");
  const thread = await c.json("/v1/threads", { surface: "knowledge" });
  assert((await c.request(`/v1/threads/${thread.id}`, undefined, "DELETE")).status === 401, "Missing destructive auth");
  assert((await c.request(`/v1/threads/${thread.id}`, undefined, "DELETE", { authorization: "Bearer smoke-operator-secret" })).status === 200, "Authorized delete failed");
  const corpus = await c.json("/v1/corpora", { name: "Protected" });
  const source = await c.json<{ sourceId: string }>(`/v1/corpora/${corpus.id}/sources`, file("Protected source"));
  assert((await c.request(`/v1/sources/${source.sourceId}`, undefined, "DELETE")).status === 401, "Source DELETE unprotected");
  assert((await c.request(`/v1/sources/${source.sourceId}`, undefined, "DELETE", { "x-api-key": "smoke-operator-secret" })).ok, "X-API-Key rejected");
  const session = await c.json<{ sessionId: string }>("/v1/voice/sessions", {});
  assert((await c.request(`/v1/voice/sessions/${session.sessionId}`, undefined, "DELETE")).status === 401, "Voice DELETE unprotected");
  assert((await c.request(`/v1/voice/sessions/${session.sessionId}`, undefined, "DELETE", { "x-api-key": "smoke-operator-secret" })).ok, "Voice operator DELETE failed");
});
await serverTest("visitor isolation, cookie, shared demo, export, self deletion, audit", {}, async (c, base, dir) => {
  const first = await c.request("/v1/threads"); const cookie = first.headers.get("set-cookie")!;
  assert(/sabbia_visitor=[\w-]{43};/.test(cookie) && ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=2592000"].every(v => cookie.includes(v)), "Cookie invalid");
  const thread = await c.json("/v1/threads", { surface: "knowledge" }); const corpus = await c.json("/v1/corpora", { name: "Private document" });
  const source = await c.json<{ sourceId: string }>(`/v1/corpora/${corpus.id}/sources`, file("Private document receipt"));
  const session = await c.json<{ sessionId: string }>("/v1/voice/sessions", { threadId: (await c.json("/v1/threads", { surface: "voice" })).id });
  const png = new FormData(); png.append("file", new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")], "one.png", { type: "image/png" }));
  const asset = await c.json<{ assetId: string }>("/v1/assets", png);
  const stranger = client(base, "198.51.100.99");
  assert((await stranger.json<{ items: unknown[] }>("/v1/threads")).items.length === 0 && (await stranger.json<unknown[]>("/v1/corpora")).length === 0, "Global lists leaked data");
  for (const path of [`/v1/threads/${thread.id}`, `/v1/sources/${source.sourceId}`, `/v1/assets/${asset.assetId}`, `/v1/voice/sessions/${session.sessionId}`, `/v1/corpora/${corpus.id}/sources`, `/model_calls?threadId=${thread.id}`]) assert((await stranger.request(path)).status === 404, `${path} leaked existence`);
  for (const [path, body] of [[`/v1/threads/${thread.id}/turns`, { text: "hello" }], [`/v1/corpora/${corpus.id}/search`, { query: "receipt" }], ["/v1/vision/analyses", { assetId: asset.assetId, task: "describe" }], ["/v1/voice/sessions", { threadId: thread.id }]] as const) assert((await stranger.request(path, body)).status === 404, `${path} not scoped`);
  assert((await stranger.request(`/v1/threads/${thread.id}`, undefined, "DELETE")).status === 404, "Cross-visitor delete allowed");
  const demo = await searchDemo(stranger); assert((await stranger.request(`/v1/corpora/${demo.id}/sources`, file("Attack"))).status === 404, "Shared demo mutable");
  const turn = await stranger.json("/v1/threads", { surface: "knowledge" }); const reply = await (await stranger.request(`/v1/threads/${turn.id}/turns`, { text: "When do warehouse orders ship?" })).text(); assert(reply.includes("citations.set") && !reply.includes('"kind":"error"'), "New visitor demo failed");
  assert((await c.request(`/v1/corpora/${corpus.id}/search`, { query: "x".repeat(2001) })).status === 400, "Long query not a clean 400");
  assert((await c.request("/v1/threads", { surface: "knowledge", title: "x".repeat(262144) })).status === 413, "JSON limit missing");
  const bundle = await c.json<{ threads: unknown[]; sources: { title: string }[] }>("/v1/visitor/export"); assert(bundle.threads.length === 2 && bundle.sources[0]?.title === "sample.txt", "Export incomplete");
  const deleted = await c.request("/v1/visitor", undefined, "DELETE"); assert(deleted.ok && deleted.headers.get("set-cookie")?.includes("Max-Age=0"), "Self deletion failed");
  assert((await c.request(`/v1/assets/${asset.assetId}`)).status === 404 && (await c.json<unknown[]>("/v1/corpora")).length === 0, "Data survived deletion");
  const inspection = new Database(join(dir, "sabbia.db"));
  assert((inspection.query("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n === 0 && (inspection.query("SELECT COUNT(*) AS n FROM sources WHERE id=?").get(source.sourceId) as { n: number }).n === 0, "Rows survived self deletion");
  assert((inspection.query("SELECT COUNT(*) AS n FROM access_log WHERE method NOT IN ('GET','DELETE')").get() as { n: number }).n === 0, "Audit logs writes"); inspection.close(true);
});
await serverTest("global model and stream limits apply across IPs", { SABBIA_MODEL_RATE_LIMIT_GLOBAL_PER_MIN: "1", SABBIA_MAX_CONCURRENT_STREAMS: "1" }, async (c, base) => {
  const corpus = await searchDemo(c); await c.json(`/v1/corpora/${corpus.id}/search`, { query: "receipt" });
  const other = client(base, "198.51.100.2"); await limited(await other.request(`/v1/corpora/${corpus.id}/search`, { query: "receipt" }), "Global model limit");
  const a = await c.json("/v1/threads", { surface: "knowledge" }), b = await other.json("/v1/threads", { surface: "knowledge" });
  const stream = await c.request(`/v1/threads/${a.id}/events`);
  await limited(await other.request(`/v1/threads/${b.id}/events`), "Global concurrent stream limit"); await stream.body!.cancel();
});
await serverTest("retention removes anonymous data and objects; preserves operator rows", {}, async (c, _base, dir, stop) => {
  const thread = await c.json("/v1/threads", { surface: "knowledge" });
  const corpus = await c.json("/v1/corpora", { name: "Old data" });
  const source = await c.json<{ sourceId: string }>(`/v1/corpora/${corpus.id}/sources`, file("Old document contents"));
  for (let i = 0; i < 50; i++) { const status = await c.json<{ status: string }>(`/v1/sources/${source.sourceId}`); if (status.status === "indexed") break; await Bun.sleep(20); }
  await stop();
  const inspection = new Database(join(dir, "sabbia.db"));
  inspection.exec("UPDATE threads SET created_at='2000-01-01T00:00:00.000Z'; UPDATE corpora SET created_at='2000-01-01T00:00:00.000Z'; UPDATE sources SET created_at='2000-01-01T00:00:00.000Z'; INSERT INTO threads(id,workspace_id,surface,title,created_at) VALUES('operator','default','knowledge','Preserve me','2000-01-01T00:00:00.000Z');");
  inspection.close(true);
  const sweep = Bun.spawn([process.execPath, "--eval", 'const {retentionSweep}=await import("./src/privacy.ts"); await retentionSweep(); const {db}=await import("./src/db.ts"); db.close(true);'], { env: { ...process.env, SABBIA_MOCK: "1", SABBIA_DATA_DIR: dir, SABBIA_RETENTION_DAYS: "14", SABBIA_LOG_LEVEL: "info" }, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(sweep.stdout).text(), stderr = new Response(sweep.stderr).text();
  assert(await sweep.exited === 0, `Sweep failed: ${await stderr}`); const log = await stdout;
  assert(log.split("Retention sweep").length === 2 && /"threads":1/.test(log) && /"corpora":1/.test(log) && /"sources":1/.test(log) && /"chunks":1/.test(log) && /"objects":1/.test(log), `Sweep summary invalid: ${log}`);
  const checked = new Database(join(dir, "sabbia.db"));
  const threadDeleted = !checked.query("SELECT id FROM threads WHERE id=?").get(thread.id), operatorRetained = checked.query("SELECT id FROM threads WHERE id='operator'").get();
  const sourceDeleted = !checked.query("SELECT id FROM sources WHERE id=?").get(source.sourceId), demoRetained = checked.query("SELECT id FROM corpora WHERE is_public=1").get(); checked.close(true);
  assert(threadDeleted && operatorRetained, "Retention ownership boundary failed");
  assert(sourceDeleted && demoRetained, "Retention deleted demo or retained visitor data");
});
await serverTest("SQLite metadata ceiling: 507 without unbounded database growth", { SABBIA_MAX_DATABASE_MB: "1" }, async (c, _base, dir) => {
  const thread = await c.json("/v1/threads", { surface: "knowledge" });
  const stream = await c.request(`/v1/threads/${thread.id}/turns`, { text: "hello" }); await stream.text();
  const conversation = await c.json<{ turns: { id: string }[] }>(`/v1/threads/${thread.id}`);
  let full = false;
  for (let i = 0; i < 1500; i++) {
    const response = await c.request(`/v1/threads/${thread.id}/feedback`, { turnId: conversation.turns[0].id, rating: 1, note: "x".repeat(2000) });
    if (response.status === 507) { full = true; break; }
    assert(response.status === 201, `Unexpected metadata status ${response.status}`);
  }
  assert(full, "SQLite ceiling did not reject writes");
  const inspection = new Database(join(dir, "sabbia.db"));
  const pages = (inspection.query("PRAGMA page_count").get() as { page_count: number }).page_count; inspection.close(true);
  assert(pages <= 256, `SQLite exceeded configured page ceiling: ${pages}`);
});
console.log("ABUSE SMOKE PASS: all 13 checks passed (9 required + isolation + global limits + retention + SQLite quota)");

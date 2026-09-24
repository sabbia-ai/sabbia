import { requestContext, visitorId, owns } from "./context";
import { requestLimit, uploadLimit, modelLimit, modelRemaining, streamsOpen, cleanLimits, rejectLimit } from "./limits";
import { identify, operatorAuthorized, visitorCookie, audit, auditHealth, deletingVisitors, deleteVisitor, exportVisitor, retentionSweep, seedDemo } from "./privacy";
import { storageHealth, collectObjects } from "./storage";
import { config, log, publicConfig } from "./config";
import { keyHealth } from "./keys";
import { modelRegistry } from "./models";
import { db, threads, turns, corpora, sources, assets, addFeedback, guardrails, modelCalls, openEscalation, voiceSessions, voiceSegments, writable } from "./db";
import { HttpError, json, problem, bodyJson, textField, integer, multipartFile, sniff, validateMime, storeUpload, objectFile, imageDimensions } from "./http";
import { enqueueIngestion, pendingIngestion } from "./ingest";
import { retrieve } from "./rag";
import { eventStream, journal, closeEventStreams } from "./sse";
import { queueTurn, runTurn, pendingTurns, redactPII } from "./agents";
import { analyzeImage, type VisionTask } from "./vision";
import { createVoiceSession, voiceTurn } from "./voice";

type Params = Record<string, string>;
type Handler = (request: Request, params: Params, url: URL) => Response | Promise<Response>;
const routes: { method: string; parts: string[]; handler: Handler }[] = [];
function on(method: string, path: string, handler: Handler) { routes.push({ method, parts: path.split("/").filter(Boolean), handler }); }
function requireThread(id: string) { const thread = threads.get(id); if (!thread) throw new HttpError(404, "Thread not found"); return thread; }
function requireCorpus(id: string, write = false) { const row = corpora.get(id); if (!row || (write && (!owns(row) || row.is_public === 1))) throw new HttpError(404, "Corpus not found"); }
function requireSource(id: string, write = false) { const row = sources.get(id); if (!row) throw new HttpError(404, "Source not found"); requireCorpus(row.corpus_id, write); return row; }
function requireSession(id: string) { const row = voiceSessions.get(id); if (!row) throw new HttpError(404, "Voice session not found"); return row; }
function sourceCapacity(id: string) { if (sources.list(id).length >= config.maxSources) throw new HttpError(409, `Corpus source limit reached: maximum ${config.maxSources} sources per corpus`); }
const started = Date.now(); let inFlight = 0, shuttingDown = false;

on("GET", "/healthz", () => json({ ok: true, version: "0.1.0", uptime_s: Math.floor((Date.now() - started) / 1000), keys: keyHealth(), mock: config.mock, db: "ok", limits: { model_remaining_today: modelRemaining(), model_budget_per_day: config.modelBudgetPerDay, streams_open: streamsOpen() }, storage: storageHealth(), audit: auditHealth() }));
on("GET", "/readyz", () => { if (shuttingDown || !writable()) throw new HttpError(503, "Database is not writable"); return json({ ok: true, db: "ok" }); });
on("GET", "/api/models", () => json(modelRegistry()));
on("GET", "/api/config", () => json({ ...publicConfig(), keys: keyHealth() }));
on("GET", "/model_calls", (_r, _p, url) => { const id = url.searchParams.get("threadId") ?? ""; if (id) requireThread(id); return json(modelCalls.usage(id)); });
on("GET", "/v1/threads", (_r, _p, url) => {
  const items = threads.list(url.searchParams.get("surface") ?? "", integer(url.searchParams.get("limit"), 30, 1, 100), url.searchParams.get("cursor") ?? "");
  const last = items.at(-1); return json({ items, next_cursor: last ? last.created_at + last.id : null });
});
on("POST", "/v1/threads", async request => {
  const body = await bodyJson(request), surface = textField(body, "surface", 30);
  if (!["console", "knowledge", "support", "voice", "vision"].includes(surface)) throw new HttpError(400, "Unknown surface");
  return json(threads.create(surface, textField(body, "title", 200, false) || "New conversation"), 201);
});
on("GET", "/v1/threads/:id", (_r, p) => json({ ...requireThread(p.id), voiceSession: voiceSessions.latest(p.id), turns: turns.list(p.id).map(t => ({ ...t, blocks: JSON.parse(t.blocks_json) as unknown, usage: JSON.parse(t.usage_json) as unknown })) }));
on("DELETE", "/v1/threads/:id", (_r, p) => { requireThread(p.id); threads.archive(p.id); return json({ archived: true }); });
on("GET", "/v1/threads/:id/events", (request, p, url) => {
  requireThread(p.id); const after = Math.max(integer(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER), integer(request.headers.get("last-event-id"), 0, 0, Number.MAX_SAFE_INTEGER));
  return eventStream(p.id, after, request.signal);
});
on("POST", "/v1/threads/:id/turns", async (request, p) => {
  const thread = requireThread(p.id), body = await bodyJson(request), text = textField(body, "text");
  const corpusId = textField(body, "corpusId", 100, false) || undefined; if (corpusId) requireCorpus(corpusId);
  return eventStream(p.id, thread.last_seq, request.signal, false, async () => { await queueTurn(p.id, () => runTurn(p.id, text, corpusId)); });
});
on("POST", "/v1/threads/:id/feedback", async (request, p) => {
  requireThread(p.id); const body = await bodyJson(request), turnId = textField(body, "turnId", 100);
  if (!turns.get(turnId, p.id)) throw new HttpError(404, "Turn not found in this thread");
  if (typeof body.rating !== "number" || ![-1, 0, 1].includes(body.rating)) throw new HttpError(400, "rating must be -1, 0, or 1");
  addFeedback(p.id, turnId, body.rating, redactPII(textField(body, "note", 2000, false))); return json({ saved: true }, 201);
});
on("GET", "/v1/threads/:id/guardrails", (_r, p) => { requireThread(p.id); return json(guardrails.list(p.id)); });
on("POST", "/v1/threads/:id/escalations", async (request, p) => {
  requireThread(p.id); const body = await bodyJson(request);
  journal(p.id, "tool.request", { tool: "open_escalation" }); const ticket = openEscalation(p.id, redactPII(textField(body, "reason", 2000, false)) || "Requested in console");
  journal(p.id, "tool.result", { tool: "open_escalation", ...ticket }); return json(ticket, 201);
});
on("POST", "/v1/corpora", async request => json(corpora.create(textField(await bodyJson(request), "name", 200)), 201));
on("GET", "/v1/corpora", () => json(corpora.list()));
on("GET", "/v1/corpora/:id/sources", (_r, p) => { requireCorpus(p.id); return json(sources.list(p.id)); });
on("POST", "/v1/corpora/:id/sources", async (request, p) => {
  requireCorpus(p.id, true); const upload = await multipartFile(request), type = sniff(upload.bytes, upload.name);
  if (type.mime.startsWith("image/")) throw new HttpError(415, "Images belong in /v1/assets");
  validateMime(upload.declaredMime, type.mime);
  const hash = new Bun.CryptoHasher("sha256").update(upload.bytes).digest("hex"), existing = sources.duplicate(p.id, hash);
  if (existing) return json({ sourceId: existing.id, status: existing.status, deduplicated: true });
  sourceCapacity(p.id); if (type.mime === "application/pdf") modelLimit(requestContext.getStore()!.ip);
  const stored = storeUpload(upload.bytes, type.ext);
  const source = sources.create(p.id, upload.name, type.mime, stored.objectKey, upload.bytes.length, hash); enqueueIngestion(source);
  return json({ sourceId: source.id, status: "queued" }, 202);
});
on("GET", "/v1/sources/:id", (_r, p) => { const source = requireSource(p.id); return json(source); });
on("DELETE", "/v1/sources/:id", (_r, p) => { requireSource(p.id, true); sources.remove(p.id); collectObjects(); return json({ deleted: true }); });
on("POST", "/v1/corpora/:id/search", async (request, p) => { requireCorpus(p.id); const body = await bodyJson(request); return json(await retrieve(textField(body, "query", 2000), p.id, integer(body.k, 6, 1, 6))); });
on("POST", "/v1/assets", async request => {
  const upload = await multipartFile(request), type = sniff(upload.bytes, upload.name); if (!type.mime.startsWith("image/")) throw new HttpError(415, "Expected a PNG, JPEG, GIF, or WebP image");
  validateMime(upload.declaredMime, type.mime); const [width, height] = imageDimensions(upload.bytes, type.mime);
  if ((width !== null && (!width || width > 30000)) || (height !== null && (!height || height > 30000))) throw new HttpError(422, "Invalid or excessive image dimensions");
  const stored = storeUpload(upload.bytes, type.ext);
  const id = assets.add(stored.objectKey, type.mime, stored.hash, width, height); return json({ assetId: id, url: `/v1/assets/${id}` }, 201);
});
on("GET", "/v1/assets/:id", (_r, p) => { const asset = assets.get(p.id); if (!asset) throw new HttpError(404, "Asset not found"); return new Response(objectFile(asset.object_key), { headers: { "content-type": asset.mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } }); });
on("POST", "/v1/vision/analyses", async request => {
  const body = await bodyJson(request), task = textField(body, "task", 30); if (!["describe", "text", "table", "qa"].includes(task)) throw new HttpError(400, "Unknown vision task");
  return json(await analyzeImage(textField(body, "assetId", 100), task as VisionTask, textField(body, "question", 2000, false)));
});
on("POST", "/v1/voice/sessions", async request => { const body = await bodyJson(request), id = textField(body, "threadId", 100, false); if (id) requireThread(id); return json(createVoiceSession(id || undefined), 201); });
on("POST", "/v1/voice/sessions/:id/turns", async (request, p) => {
  requireSession(p.id); const body = await bodyJson(request), speaker = textField(body, "speaker", 30); if (!["caller", "assistant"].includes(speaker)) throw new HttpError(400, "speaker must be caller or assistant");
  return json(await voiceTurn(p.id, speaker as "caller" | "assistant", textField(body, "transcript"), body.interrupted === true));
});
on("GET", "/v1/voice/sessions/:id", (_r, p) => { const session = requireSession(p.id); return json({ ...session, segments: voiceSegments.list(p.id) }); });
on("DELETE", "/v1/voice/sessions/:id", (_r, p) => { requireSession(p.id); voiceSessions.end(p.id); return json({ ended: true }); });

on("GET", "/v1/demo/corpus", () => json(corpora.get(db.query<{ id: string }, []>("SELECT id FROM corpora WHERE is_public=1 LIMIT 1").get()!.id)));
on("GET", "/v1/visitor/export", () => json(exportVisitor(visitorId()!)));
on("DELETE", "/v1/visitor", async () => { await deleteVisitor(visitorId()!); const response = json({ deleted: true }); response.headers.set("set-cookie", visitorCookie("", 0)); return response; });

const publicRoot = new URL("../public/", import.meta.url);
async function staticResponse(name: string) { const file = Bun.file(new URL(name, publicRoot)); if (!await file.exists()) throw new HttpError(404, "Static asset not found"); return new Response(file); }
on("GET", "/", () => staticResponse("index.html"));
on("GET", "/docs", () => staticResponse("docs.html"));
on("GET", "/console", () => staticResponse("console.html"));
on("GET", "/static/:file", (_r, p) => { if (!["app.js", "styles.css"].includes(p.file)) throw new HttpError(404, "Static asset not found"); return staticResponse(p.file); });

// An interrupted extraction is visible and can be removed/re-uploaded after restart.
db.prepare("UPDATE sources SET status='failed',fail_reason='Ingestion interrupted by server restart' WHERE status IN ('queued','extracting','chunking')").run();
await seedDemo();
collectObjects();
const cleanupTimer = setInterval(cleanLimits, 60000); cleanupTimer.unref();
let sweep: Promise<void> | undefined;
function sweepRetention() { if (!sweep) sweep = retentionSweep().catch(() => log("error", "Retention sweep failed")).finally(() => { sweep = undefined; }); }
const retentionTimer = setInterval(sweepRetention, 3600000); retentionTimer.unref();
sweepRetention();
const server = Bun.serve({
  port: config.port, hostname: config.host, idleTimeout: 255, maxRequestBodySize: Math.ceil(Math.max(config.maxUploadBytes + 65536, config.maxJsonBytes)),
  async fetch(request, server) {
    const traceId = crypto.randomUUID(), began = Date.now(); inFlight++; let response: Response;
    const url = new URL(request.url);
    let visitor: ReturnType<typeof identify> | undefined, matchedRoute = url.pathname, resourceKind: string | null = null, resourceId: string | null = null;
    try {
      if (shuttingDown) throw new HttpError(503, "Server is shutting down");
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 128) || server.requestIP(request)?.address || "unknown";
      requestLimit(ip);
      if (inFlight > 128) rejectLimit("Global concurrent request limit (retry availability)", 5);
      visitor = identify(request);
      if (deletingVisitors.has(visitor.id)) throw new HttpError(409, "Visitor data cleanup is in progress; retry shortly");
      const operator = operatorAuthorized(request);
      const parts = url.pathname.split("/").filter(Boolean); let match: { handler: Handler; params: Params } | undefined;
      for (const route of routes) {
        if (route.method !== request.method || route.parts.length !== parts.length) continue;
        const params: Params = {}; let good = true;
        for (let i = 0; i < parts.length; i++) { if (route.parts[i].startsWith(":")) { try { params[route.parts[i].slice(1)] = decodeURIComponent(parts[i]); } catch { throw new HttpError(400, "Malformed path encoding"); } } else if (route.parts[i] !== parts[i]) { good = false; break; } }
        if (good) { match = { handler: route.handler, params }; matchedRoute = "/" + route.parts.join("/"); resourceKind = route.parts[1] ?? null; resourceId = params.id ?? null; break; }
      }
      if (!match) throw new HttpError(404, "Route not found");
      if (request.method === "DELETE" && /^\/v1\/(threads|sources|voice\/sessions)\/:id$/.test(matchedRoute) && config.authToken && !operator) throw new HttpError(401, "This destructive route requires the operator token (Bearer or X-API-Key)");
      if (request.method === "POST" && (matchedRoute === "/v1/assets" || matchedRoute === "/v1/corpora/:id/sources")) uploadLimit(ip);
      if (request.method === "POST" && ["/v1/threads/:id/turns", "/v1/vision/analyses", "/v1/voice/sessions/:id/turns", "/v1/corpora/:id/search"].includes(matchedRoute)) modelLimit(ip);
      response = await requestContext.run({ visitor: visitor.id, ip, operator }, () => match!.handler(request, match!.params, url));
    } catch (e) {
      if (!(e instanceof HttpError)) log("error", "Request failed", { trace_id: traceId, route: url.pathname, extra: { error: e instanceof Error ? e.message : "Unknown error" } });
      response = problem(e, url.pathname, traceId);
    } finally { inFlight--; }
    if (visitor) {
      if (visitor.cookie && !response.headers.has("set-cookie")) response.headers.set("set-cookie", visitor.cookie);
      try { audit(visitor.id, request.method, matchedRoute, resourceKind, resourceId, response.status); } catch { log("warn", "Audit capacity reached; record could not be stored"); }
    }
    response.headers.set("cache-control", "no-store");
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) response.headers.set("connection", "close");
    response.headers.set("x-trace-id", traceId); response.headers.set("x-content-type-options", "nosniff"); response.headers.set("referrer-policy", "same-origin");
    log("info", "Request", { trace_id: traceId, route: url.pathname, status: response.status, latency_ms: Date.now() - began }); return response;
  },
  error() { const trace = crypto.randomUUID(); const response = problem(new HttpError(413, "Request body exceeds the upload limit or is malformed"), "/", trace); response.headers.set("x-trace-id", trace); return response; },
});
log("info", config.mock ? "Sabbia AI listening (mock provider)" : "Sabbia AI listening", { extra: { url: `http://${config.host}:${server.port}`, mock: config.mock } });
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true; log("info", "Graceful shutdown started");
  clearInterval(cleanupTimer); clearInterval(retentionTimer);
  void server.stop(false); closeEventStreams();
  await Promise.race([(async () => { await Promise.allSettled([pendingTurns(), pendingIngestion(), ...(sweep ? [sweep] : [])]); while (inFlight) await Bun.sleep(25); })(), Bun.sleep(10000)]);
  await server.stop(true); db.close(); log("info", "Shutdown complete"); process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); }); process.on("SIGTERM", () => { void shutdown(); });

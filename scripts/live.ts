// Optional live verification. It uses .env and isolates all test data in a temporary directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";

const directory = mkdtempSync(join(tmpdir(), "sabbia-live-"));
process.env.SABBIA_MOCK = "0"; process.env.SABBIA_DATA_DIR = directory;
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port!; await reservation.stop(true);
const base = `http://127.0.0.1:${port}`;
const child = Bun.spawn([process.execPath, "run", "src/index.ts"], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SABBIA_LOG_LEVEL: "warn", SABBIA_MODEL_RATE_LIMIT_PER_MIN: "6", SABBIA_MODEL_RATE_LIMIT_GLOBAL_PER_MIN: "60", SABBIA_MODEL_BUDGET_PER_DAY: "1500", SABBIA_RATE_LIMIT_PER_MIN: "120" }, stdout: "pipe", stderr: "pipe" });
const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
let cookie = "", clientIp = "203.0.113.10";
async function clientFetch(url: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers); headers.set("x-forwarded-for", clientIp); if (cookie) headers.set("cookie", cookie);
  const response = await fetch(url, { ...options, headers });
  const issued = response.headers.get("set-cookie"); if (issued) cookie = issued.split(";")[0]; return response;
}
let failed = false;
async function api(path: string, body?: unknown) {
  const response = await clientFetch(base + path, { ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(await response.text()); return response;
}
async function upload(path: string, data: BlobPart, name: string, type: string): Promise<Record<string, string>> {
  const form = new FormData(); form.append("file", new File([data], name, { type }));
  const response = await clientFetch(base + path, { method: "POST", body: form }); if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<Record<string, string>>;
}
function pngChunk(type: string, data: Buffer) {
  const label = Buffer.from(type), crcData = Buffer.concat([label, data]); let crc = 0xffffffff;
  for (const byte of crcData) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([size, label, data, checksum]);
}
function samplePng() {
  const width = 256, height = 128, header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 3 + 1) + 1 + x * 3; const rectangle = x >= 65 && x < 190 && y >= 30 && y < 100; pixels[offset] = rectangle ? 30 : 245; pixels[offset + 1] = rectangle ? 100 : 245; pixels[offset + 2] = rectangle ? 220 : 245; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { const health = await (await api("/healthz")).json() as { ok: boolean; mock: boolean; keys: { available: number } }; if (health.ok && !health.mock && health.keys.available > 0) { ready = true; break; } } catch { /* Wait for the isolated listener. */ } await Bun.sleep(100); }
  if (!ready) throw new Error("Live server failed to start with usable keys");
  const runningConfig = await (await api("/api/config")).json() as { dataDirConfigured: boolean };
  if (!runningConfig.dataDirConfigured) throw new Error("Live config missing safe directory flag");
  const initialHealth = await (await api("/healthz")).json() as { limits: { model_remaining_today: number } };
  const { chat } = await import("../src/nvidia");
  const completion = await chat("textMain", [{ role: "user", content: "Reply with a single short sentence saying that the connection is working." }]);
  console.log(`LIVE PASS text completion: ${completion.latency_ms} ms (${completion.model})`);
  const corpus = await (await api("/v1/corpora", { name: "Live verification" })).json() as { id: string };
  const source = await upload(`/v1/corpora/${corpus.id}/sources`, "# Shipping policy\n\nStandard warehouse orders ship within three business days. A receipt is required for returns within thirty days.\n", "policy.md", "text/markdown");
  for (let i = 0; i < 100; i++) { const status = await (await api(`/v1/sources/${source.sourceId}`)).json() as { status: string }; if (status.status === "failed") throw new Error("Live document ingestion failed"); if (status.status === "indexed") break; await Bun.sleep(100); }
  const thread = await (await api("/v1/threads", { surface: "knowledge", title: "Live RAG check" })).json() as { id: string };
  const start = Date.now(), sse = await (await api(`/v1/threads/${thread.id}/turns`, { text: "How quickly do standard warehouse orders ship?" })).text();
  const events = sse.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)) as { kind: string; text?: string; detail?: string });
  const answer = events.filter(e => e.kind === "text.delta").map(e => e.text).join("");
  if (!/\[S\d+\]/.test(answer) || events.some(e => e.kind === "error")) throw new Error(`Live RAG check failed: ${events.find(e => e.kind === "error")?.detail ?? answer}`);
  if (!sse.includes("text.delta") || !sse.includes("turn.end")) throw new Error("Normal turn did not stream");
  console.log(`LIVE PASS RAG answer with citation: ${Date.now() - start} ms`);
  const asset = await upload("/v1/assets", samplePng(), "rectangle.png", "image/png");
  const vision = await (await api("/v1/vision/analyses", { assetId: asset.assetId, task: "describe" })).json() as { result: unknown; latency_ms: number; model: string };
  if (!vision.result) throw new Error("Live vision result is empty");
  console.log(`LIVE PASS vision analysis: ${vision.latency_ms} ms (${vision.model})`);
  // A fresh client IP makes this a burst check independent of provider latency.
  clientIp = "203.0.113.11";
  for (let i = 0; i < 6; i++) await api(`/v1/corpora/${corpus.id}/search`, { query: "warehouse" });
  const seventh = await clientFetch(base + `/v1/corpora/${corpus.id}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "warehouse" }) });
  if (seventh.status !== 429 || !/^\d+$/.test(seventh.headers.get("retry-after") ?? "")) throw new Error(`Seventh model request returned ${seventh.status}`);
  console.log(`LIVE PASS seventh model request: 429, Retry-After=${seventh.headers.get("retry-after")} seconds`);
  const finalHealth = await (await api("/healthz")).json() as { limits: { model_remaining_today: number } };
  if (initialHealth.limits.model_remaining_today - finalHealth.limits.model_remaining_today !== 8) throw new Error("Daily budget did not decrease by eight admissions");
  console.log(`LIVE PASS daily budget: ${initialHealth.limits.model_remaining_today} -> ${finalHealth.limits.model_remaining_today}`);
} catch (error) { failed = true; console.error(`LIVE FAIL: ${error instanceof Error ? error.message : "Unknown error"}`); }
finally {
  child.kill(); await child.exited; const output = (await stdout) + (await stderr); if (failed && output.trim()) console.error(output);
  const { db } = await import("../src/db"); db.close(true);
  const root = resolve(tmpdir()) + sep, target = resolve(directory);
  if (target.startsWith(root) && target.slice(root.length).startsWith("sabbia-live-") && !target.slice(root.length).includes(sep)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(failed ? 1 : 0);

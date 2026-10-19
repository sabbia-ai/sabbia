// Explicit operator verification: uploads a fixture into the real data database.
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const directory = resolve("data");
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port!; await reservation.stop(true);
const base = `http://127.0.0.1:${port}`;
const child = Bun.spawn([process.execPath, "run", "src/index.ts"], {
  env: { ...process.env, SABBIA_DATA_DIR: directory, SABBIA_MOCK: "0", SABBIA_DENSE_RETRIEVAL: "1", SABBIA_JUDGE_RETRIEVAL: "1", SABBIA_VERIFY_ANSWERS: "1", SABBIA_LOG_LEVEL: "debug", PORT: String(port), HOST: "127.0.0.1" },
  stdout: "pipe", stderr: "pipe",
});
const logLines: Record<string, unknown>[] = [];
const stdout = (async () => {
  const reader = child.stdout.getReader(), decoder = new TextDecoder(); let pending = "";
  while (true) {
    const next = await reader.read(); if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { logLines.push(JSON.parse(line) as Record<string, unknown>); } catch { /* Ignore non-JSON process output. */ }
    }
  }
})();
const stderr = new Response(child.stderr).text();
let cookie = "";
async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers); if (cookie) headers.set("cookie", cookie);
  const response = await fetch(base + path, { ...options, headers });
  const issued = response.headers.get("set-cookie"); if (issued) cookie = issued.split(";")[0];
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
}
const post = (path: string, body: unknown) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let inspection: Database | undefined;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const health = await (await api("/healthz")).json() as { ok: boolean; mock: boolean }; if (health.ok && !health.mock) { ready = true; break; } } catch { /* Wait for listener startup. */ }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Real-key server did not start");
  inspection = new Database(`${directory}/sabbia.db`, { readonly: true });
  const corpus = await (await post("/v1/corpora", { name: "Dense Chinese live verification" })).json() as { id: string };
  const document = "# Shipping and returns\n\nStandard warehouse orders ship within three business days. Returns are accepted within thirty days with a receipt. Support runs Monday to Friday.\n\n# Astronomy\n\nStars produce light and heat through fusion. The Moon orbits the Earth.\n\n# Equipment order\n\nThe meeting room needs fourteen air conditioners.\n";
  const form = new FormData(); form.append("file", new File([document], "shipping-returns.md", { type: "text/markdown" }));
  const source = await (await api(`/v1/corpora/${corpus.id}/sources`, { method: "POST", body: form })).json() as { sourceId: string };
  let indexed = false;
  for (let i = 0; i < 600; i++) {
    const status = await (await api(`/v1/sources/${source.sourceId}`)).json() as { status: string; chunk_count: number };
    if (status.status === "failed") throw new Error("Live ingestion failed");
    const count = inspection.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM chunk_vectors v JOIN chunks c ON c.id=v.chunk_id WHERE c.source_id=? AND v.model='nvidia/nemotron-3.5-embed-1b'").get(source.sourceId)!.n;
    if (status.status === "indexed" && count === status.chunk_count && count >= 3) { indexed = true; break; }
    await Bun.sleep(100);
  }
  if (!indexed) throw new Error("Real uploaded source did not acquire all vectors");
  const thread = await (await post("/v1/threads", { surface: "knowledge", title: "dense and judge" })).json() as { id: string };
  const began = performance.now(), logStart = logLines.length;
  const stream = await (await post(`/v1/threads/${thread.id}/turns`, { text: "how long until it arrives", corpusId: corpus.id })).text();
  const total = performance.now() - began;
  const events = stream.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)) as Record<string, unknown>);
  const answer = events.filter(event => event.kind === "text.delta").map(event => event.text).join("");
  const judge = events.find(event => event.kind === "tool.result" && event.tool === "judge_retrieval");
  const citations = events.find(event => event.kind === "citations.set")?.citations as { sourceId: string; heading: string; answerable?: string }[] | undefined;
  const verifications = events.filter(event => event.kind === "tool.result" && event.tool === "verify_answer");
  const verdicts = judge?.verdicts as { relevant: boolean; answerable: string; fallback: boolean }[] | undefined;
  if (events.some(event => event.kind === "error") || !/\[S1\]/.test(answer) || !/fourteen|14/i.test(answer) || !/ship|business day/i.test(answer) || !citations?.some(citation => citation.sourceId === source.sourceId && citation.answerable === "Standard warehouse orders ship within three business days.") || judge?.fallback !== false || !verdicts?.some(v => v.relevant) || !verifications.length || verifications.some(v => v.fallback) || verifications.at(-1)?.supported !== true) throw new Error(`map/verify answer failed: ${answer}; judge=${JSON.stringify(judge)}; verify=${JSON.stringify(verifications)}`);
  const timings = logLines.slice(logStart);
  const denseTiming = timings.find(line => line.msg === "Dense retrieval timing"), retrievalTiming = timings.find(line => line.msg === "Retrieval timing"), judgeTiming = timings.find(line => line.msg === "Judge retrieval timing");
  if (!denseTiming || !retrievalTiming || !judgeTiming) throw new Error("Missing stage timings");
  const calls = inspection.query<{ role: string; model: string; latency_ms: number; ok: number }, [string]>("SELECT role,model,latency_ms,ok FROM model_calls WHERE thread_id=? ORDER BY rowid").all(thread.id);
  const embedMs = Number(denseTiming.embed_ms);
  const answerMs = timings.filter(line => line.msg === "Answer generation timing").reduce((sum, line) => sum + Number(line.answer_ms), 0);
  const verifyMs = timings.filter(line => line.msg === "Answer verification timing").reduce((sum, line) => sum + Number(line.verify_ms), 0);
  const report = {
    corpusId: corpus.id, sourceId: source.sourceId, threadId: thread.id, query: "how long until it arrives", answer, citations, judge, verifications,
    latency_ms: { embed: embedMs, lexical: Number(retrievalTiming.lexical_ms), dense: Number(denseTiming.retrieve_ms), map: Number(judgeTiming.judge_ms), answer: answerMs, verify: verifyMs, total },
    calls,
  };
  await Bun.write(`${directory}/vector-live-verification.json`, JSON.stringify(report, null, 2));
  console.log(`LIVE PASS real data/ upload: ${source.sourceId}, Chinese shipping/returns + unrelated astronomy, all vectors stored`);
  console.log(`LIVE PASS how long until it arrives: ${answer}`);
  console.log(`LIVE PASS judge: ${JSON.stringify(judge)}`);
  console.log(`LIVE PASS citations: ${JSON.stringify(citations)}`);
  console.log(`LIVE PASS verify: ${JSON.stringify(verifications)}`);
  console.log(`LATENCY ms: ${JSON.stringify(report.latency_ms)}`);
  console.log("Evidence: data/vector-live-verification.json");
} finally {
  inspection?.close(); child.kill(); await child.exited; await stdout;
  const errors = await stderr; if (errors.trim()) console.error(errors);
}

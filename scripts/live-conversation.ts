// Explicit operator verification against existing documents and real provider keys.
export {};
process.env.SABBIA_MOCK = "0";
process.env.SABBIA_DENSE_RETRIEVAL = "1";
process.env.SABBIA_JUDGE_RETRIEVAL = "1";
process.env.SABBIA_VERIFY_ANSWERS = "1";
process.env.SABBIA_LOG_LEVEL = "error";
const { db, threads, events } = await import("../src/db");
const { requestContext } = await import("../src/context");
const { config } = await import("../src/config");
const originalFetch = globalThis.fetch;
let embeddingCalls = 0, retrievalQueries = 0;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
  if (String(input).endsWith("/embeddings")) embeddingCalls++;
  return originalFetch(input, options);
}) as typeof fetch;
const originalQuery = db.query, originalPrepare = db.prepare;
const tracked = new WeakSet<object>();
function trackedQuery(...args: Parameters<typeof db.query>) {
  const statement = originalQuery.apply(db, args);
  if (!tracked.has(statement)) {
    tracked.add(statement);
    const originalAll = statement.all, sql = args[0];
    statement.all = function (...bindings: Parameters<typeof statement.all>) {
      if (/SELECT[\s\S]*FROM (?:chunks_fts|chunks c|chunk_vectors)/i.test(sql)) retrievalQueries++;
      return originalAll.apply(this, bindings);
    };
  }
  return statement;
}
db.query = trackedQuery as typeof db.query;
db.prepare = trackedQuery as typeof db.prepare;
const { runTurn, fallbackPrompt } = await import("../src/agents");
try {
  await requestContext.run({ visitor: "operator-conversation-verification", ip: "local", operator: true }, async () => {
    const conversationOnly = process.argv.includes("--conversation-only");
    const localFixture = process.argv.includes("--local-fixture");
    const corpus = localFixture ? db.query<{ id: string }, []>("SELECT s.corpus_id AS id FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.status='indexed' AND c.heading='Equipment order' ORDER BY c.rowid DESC LIMIT 1").get() : conversationOnly ? db.query<{ id: string }, []>("SELECT id FROM corpora ORDER BY rowid LIMIT 1").get() : db.query<{ id: string }, []>("SELECT s.corpus_id AS id FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.status='indexed' AND (c.heading LIKE '%Xiangyang%' OR c.heading LIKE '%14 units%') ORDER BY c.rowid LIMIT 1").get();
    if (!corpus) throw new Error("Existing air-conditioner document was not found");
    const results = [];
    const question = localFixture ? "how many air conditioners does the equipment order need?" : "why fourteen units?";
    const inputs = ["ok", "?", "thanks", "why do you output these", ...(conversationOnly ? [] : [question])];
    for (const text of inputs) {
      const thread = threads.create("knowledge", `Live verification: ${text}`).id;
      embeddingCalls = 0; retrievalQueries = 0;
      const began = performance.now(), result = await runTurn(thread, text, corpus.id);
      const counts = db.query<{ role: string; n: number }, [string]>("SELECT role,COUNT(*) AS n FROM model_calls WHERE thread_id=? GROUP BY role").all(thread);
      const journal = [...events.after(thread, 0)];
      const report = { input: text, reply: result.reply, threadId: thread, elapsedMs: Math.round(performance.now() - began), counts: { embedding: embeddingCalls, retrievalQueries, judge: counts.find(row => row.role === "judgeMain")?.n ?? 0, models: Object.fromEntries(counts.map(row => [row.role, row.n])) }, citations: result.citations, diagnostics: journal.find(event => event.tool === "insufficient_diagnostics"), judgeVerdicts: journal.find(event => event.kind === "tool.result" && event.tool === "judge_retrieval")?.verdicts };
      results.push(report);
      console.log(`LIVE ${text}: ${result.reply}`);
      console.log(`COUNTS ${text}: ${JSON.stringify(report.counts)}`);
      await Bun.write(`${config.dataDir}/conversation-live-verification.json`, JSON.stringify({ scope: localFixture ? "Existing local air-conditioner verification fixture and real keys; production corpus not available" : conversationOnly ? "Real local database/keys; production air-conditioner corpus not available" : "Real air-conditioner database and provider keys", corpusId: corpus.id, prompt: fallbackPrompt("why do you output these"), results }, null, 2));
      if (/corpus|chunk|closest heading|upload a document|try a focused search/i.test(result.reply)) throw new Error(`Unacceptable reply for ${text}`);
      if (["ok", "?", "thanks"].includes(text) && (embeddingCalls || retrievalQueries || counts.length)) throw new Error("Local reply incurred pipeline work");
      if (text === question && !result.citations.length) throw new Error("Genuine document question lost its citations");
    }
    console.log(`LIVE ${conversationOnly || localFixture ? "PARTIAL (production corpus unavailable)" : "PASS"}: real database/keys, ${inputs.length} Chinese replies; evidence: data/conversation-live-verification.json`);
  });
} finally {
  globalThis.fetch = originalFetch; db.query = originalQuery; db.prepare = originalPrepare; db.close(true);
}

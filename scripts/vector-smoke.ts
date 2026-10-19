import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "sabbia-vectors-"));
process.env.SABBIA_DATA_DIR = directory;
process.env.SABBIA_MOCK = process.argv.includes("--provider") ? "0" : "1";
process.env.SABBIA_DENSE_RETRIEVAL = "1";
process.env.SABBIA_JUDGE_RETRIEVAL = "1";
process.env.SABBIA_VERIFY_ANSWERS = "1";
process.env.SABBIA_LOG_LEVEL = "error";
if (process.argv.includes("--provider")) { process.env.NVIDIA_API_KEY = "offline-test-key"; delete process.env.NVIDIA_KEYS_FILE; }
const { db, corpora, sources, chunks, vectors, threads, turns, events } = await import("../src/db");
const { MODELS, modelRegistry } = await import("../src/models");
const { embed, EmbeddingError } = await import("../src/nvidia");
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };

try {
  if (process.argv.includes("--provider")) {
    // Exercise the real provider client with HTTP-shaped responses, offline.
    const originalFetch = globalThis.fetch;
    let mode = "valid", cosine = 0.143;
    const requests: { input: string[]; input_type: string; model: string; truncate: string; encoding_format: string }[] = [];
    globalThis.fetch = (async (_input: unknown, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)); requests.push(body);
      if (mode === "outage") return new Response("", { status: 503 });
      if (mode === "missing") return Response.json({ data: [{}] });
      if (mode === "dimension") return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
      if (mode === "dense") { const vector = Array<number>(2048).fill(0); vector[0] = cosine; vector[1] = Math.sqrt(1 - cosine ** 2); return Response.json({ data: [{ index: 0, embedding: vector }] }); }
      if (mode === "timeout") return new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
      return Response.json({ data: body.input.map((input: string, index: number) => ({ index, embedding: Array<number>(2048).fill(Number(input)) })).reverse(), usage: { prompt_tokens: 7 } });
    }) as typeof fetch;
    try {
      const result = await embed("embedMain", Array.from({ length: 65 }, (_, i) => String(i)), "passage");
      assert(requests.map(r => r.input.length).join() === "32,32,1" && result.every((v, i) => v.length === 2048 && v[0] === i), "Embedding batching/order failed");
      assert(requests.every(r => r.input_type === "passage" && r.truncate === "END" && r.encoding_format === "float" && r.model === MODELS.embedMain.id), "Embedding wire contract failed");
      await embed("embedMain", ["1"], "query"); assert(requests.at(-1)?.input_type === "query", "Query input_type failed");
      for (const invalid of ["missing", "dimension"]) {
        mode = invalid;
        try { await embed("embedMain", ["1"], "query"); throw new Error("Invalid embedding accepted"); }
        catch (error) { assert(error instanceof EmbeddingError && error.code === "invalid_response", "Missing/wrong-sized embedding was not typed"); }
      }
      const { requestContext } = await import("../src/context");
      await requestContext.run({ visitor: "provider-smoke", ip: "local", operator: true }, async () => {
        const corpus = corpora.create("Low cosine"), source = sources.create(corpus.id, "Policy", "text/plain", "low", 0, "low");
        chunks.add(source.id, 1, "Policy", "Standard warehouse orders ship within three business days. Returns are accepted within thirty days with a receipt. Support runs Monday to Friday."); sources.update(source.id, "indexed", 1);
        const id = db.query<{ id: string }, [string]>("SELECT id FROM chunks WHERE source_id=?").get(source.id)!.id;
        const vector = Array<number>(2048).fill(0); vector[0] = 1; vectors.add(id, corpus.id, MODELS.embedMain.id, vector);
        mode = "dense";
        const { retrieve, denseCandidates } = await import("../src/rag");
        const dense = await denseCandidates("how long until it arrives", corpus.id);
        const dead = await retrieve("how long until it arrives", corpus.id);
        assert(dense.length === 0 && dead.insufficient && !dead.hits.length, "Below-floor dense row resurrected a dead lexical query");
        console.log("PASS conversational 6/7: dense cosine 0.143 below default 0.15 cannot resurrect a dead query");
        cosine = 0.198;
        const hit = (await retrieve("how long until it arrives", corpus.id)).hits[0];
        assert(hit?.chunkId === id && hit.score === 0.198 && Math.abs(hit.similarity! - cosine) < 0.0001, "Shipping cosine 0.198 was rejected by lexical threshold or replaced with RRF");
        console.log("PASS conversational 7/7: paraphrase retrieves shipping above the dense floor");
      });
      mode = "timeout";
      const mutable = MODELS.embedMain as { timeoutMs: number }, timeout = mutable.timeoutMs;
      mutable.timeoutMs = 5;
      try {
        await embed("embedMain", ["1"], "query"); throw new Error("Embedding timeout accepted");
      } catch (error) { assert(error instanceof EmbeddingError && /timed out/.test(error.message), "Embedding timeout was not typed"); }
      finally { mutable.timeoutMs = timeout; }
      assert(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM model_calls WHERE role='embedMain' AND ok=0").get()!.n === 3, "Embedding failures missing from telemetry");
      assert(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM model_calls WHERE model=? AND ok=1").get(MODELS.embedMain.id)!.n === 7, "Embedding successes missing from telemetry");
    } finally { globalThis.fetch = originalFetch; }
    console.log("PASS embedding provider: batches 32/32/1, input order/types, cosine 0.143 rejected / 0.198 retained, typed malformed/dimension/timeout errors, telemetry");
  } else {
    const { requestContext } = await import("../src/context");
    const { retrieve, denseCandidates, assembleContext } = await import("../src/rag");
    const { embedChunks, enqueueIngestion, pendingIngestion } = await import("../src/ingest");
    const { seedDemo } = await import("../src/privacy");
    const { runTurn } = await import("../src/agents");
    const { config } = await import("../src/config");
    const rows = (corpus: string) => db.query<import("../src/db").Chunk & { corpus_id: string }, [string]>("SELECT c.*,s.corpus_id FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.corpus_id=? ORDER BY c.ordinal").all(corpus);
    await requestContext.run({ visitor: "vector-smoke", ip: "127.0.0.1", operator: true }, async () => {
      await seedDemo();
      const demo = db.query<{ id: string }, []>("SELECT id FROM corpora WHERE is_public=1").get()!.id;
      const paraphrases = ["how long until it arrives", "can I get a refund", "How long until it arrives?"];
      for (const query of paraphrases) assert((await retrieve(query, demo)).hits.length === 0, `Fixture has lexical paraphrase hits: ${query}`);
      await embedChunks(rows(demo));
      const unrelated = sources.create(demo, "Astronomy", "text/plain", "unrelated", 0, "unrelated");
      chunks.add(unrelated.id, 1, "Astronomy", "Stars produce light through nuclear fusion."); sources.update(unrelated.id, "indexed", 1);
      await embedChunks(rows(demo).filter(row => row.source_id === unrelated.id));
      const relevanceScores = new Map<string, Map<string, number>>();
      for (const query of paraphrases) {
        const result = await retrieve(query, demo);
        assert(result.hits.length > 0 && /Shipping and returns/.test(result.hits[0].heading), `Dense paraphrase failed: ${query}`);
        relevanceScores.set(query, new Map(result.hits.map(hit => [hit.chunkId, hit.score])));
        for (const hit of result.hits) assert(hit.similarity !== undefined && Math.abs(hit.score - hit.similarity) < 0.0001 && hit.score > 0.05 && hit.similarity >= config.denseMinScore && hit.score <= 1, `Invalid relevance: ${query}: ${JSON.stringify(hit)}`);
      }
      console.log("PASS dense-only relevance: cosine carried as similarity and score, >0.05, >= dense minimum, <=1");
      process.env.SABBIA_MOCK_JUDGE_REPLY = '{"relevant":true,"confidence":0.8,"answerable":"Standard orders ship within three business days.","reason":"Relevant"}';
      try {
        for (const query of paraphrases) {
          const thread = threads.create("knowledge").id, result = await runTurn(thread, query, demo);
          const streamed = [...events.after(thread, 0)].find(event => event.kind === "citations.set")?.citations as typeof result.citations;
          const stored = (JSON.parse(turns.get(result.turnId, thread)!.blocks_json) as { kind: string; citations?: typeof result.citations }[]).find(block => block.kind === "citations")?.citations;
          assert(result.citations.length > 0 && [result.citations, streamed, stored].every(hits => hits?.length && hits.every(hit => hit.score === 0.8 && hit.similarity !== undefined && hit.answerable === "Standard orders ship within three business days.")), `Judge confidence lost from citation: ${query}`);
        }
        console.log("PASS judge confidence wins: 0.8 on returned, SSE and stored citations; similarity and supporting sentence preserved");
      } finally { delete process.env.SABBIA_MOCK_JUDGE_REPLY; }
      process.env.SABBIA_MOCK_JUDGE_REPLY = "garbage";
      try {
        for (const query of paraphrases) {
          const result = await runTurn(threads.create("knowledge").id, query, demo);
          assert(result.citations.length > 0 && result.citations.every(hit => hit.score > 0 && hit.score === relevanceScores.get(query)?.get(hit.chunkId)), `Zero-percent fallback citation: ${query}`);
        }
      } finally { delete process.env.SABBIA_MOCK_JUDGE_REPLY; }
      console.log("PASS no zero-percent cards: all 3 bundled paraphrases retain nonzero relevance when judge fails");
      const scoreCorpus = corpora.create("Lexical score regression"), scoreSource = sources.create(scoreCorpus.id, "Policy", "text/plain", "scores", 0, "scores");
      chunks.add(scoreSource.id, 1, "Policy", "alpha beta gamma delta"); sources.update(scoreSource.id, "indexed", 1);
      const lexicalScores = await Promise.all(["alpha beta", "alpha beta gamma delta epsilon zeta"].map(query => retrieve(query, scoreCorpus.id)));
      assert(lexicalScores[0].hits[0]?.score === 1 && lexicalScores[1].hits[0]?.score === 0.82 && lexicalScores.every(result => result.hits[0].similarity === undefined), "Pure lexical scores changed");
      console.log("PASS lexical relevance unchanged: 1 / 0.82 without dense vectors or judge");
      console.log("PASS dense paraphrase: three paraphrase queries -> shipping/returns first (lexical: 0 hits each)");
      for (const query of ["returns", "shipping", "support", "refund", "warehouse"]) assert((await retrieve(query, demo)).hits.length > 0, `Regression: ${query}`);
      const english = await runTurn(threads.create("knowledge").id, "How long until it arrives?", demo);
      assert(english.reply.includes("[S1]") && /three business days/.test(english.reply), "English cited answer failed");
      console.log("PASS no regression: verbatim terms hit; English RAG answer cites [S1]");

      const corpus = corpora.create("Judge mapping"), source = sources.create(corpus.id, "Shipping passages", "text/plain", "judge", 0, "judge");
      for (let i = 1; i <= 13; i++) chunks.add(source.id, i, `Shipping policy ${i}`, `Shipping passage number ${i}: standard orders ship within three business days.`);
      sources.update(source.id, "indexed", 13);
      const candidates = (await retrieve("shipping", corpus.id, 12)).hits;
      assert(candidates.length === 12, "Judge did not receive top 12 candidates");
      process.env.SABBIA_MOCK_JUDGE_REPLY = '{"relevant":true,"confidence":0.9,"answerable":"","reason":"Relevant"}';
      const mappingThread = threads.create("knowledge").id, mapped = await runTurn(mappingThread, "shipping", corpus.id);
      const context = assembleContext(mapped.citations);
      assert(mapped.citations.map(hit => hit.chunkId).join() === candidates.slice(0, 10).map(hit => hit.chunkId).join() && /\[S1\]/.test(context) && /\[S2\]/.test(context) && !/\[S11\]/.test(context), "Judge numbering has gaps or wrong contents");
      assert(context.includes(candidates[1].content) && context.includes(candidates[2].content) && mapped.reply.includes("[S1]") && mapped.reply.includes("[S2]"), "Judge context/answer mapping failed");
      assert([...events.after(mappingThread, 0)].filter(e => e.tool === "judge_retrieval").map(e => e.kind).join() === "tool.request,tool.result", "Judge journal missing");
      console.log("PASS judge mapping: capped at 10 raw segments, contiguous labels, matching answer/citation chips and journal");
      for (const failure of ["garbage", "timeout", "empty"]) {
        process.env.SABBIA_MOCK_JUDGE_REPLY = failure === "empty" ? '{"relevant":true,"confidence":null,"answerable":"","reason":"Invalid confidence"}' : "garbage";
        if (failure === "timeout") process.env.SABBIA_MOCK_JUDGE_FAILURE = "timeout";
        const result = await runTurn(threads.create("knowledge").id, "shipping", corpus.id);
        delete process.env.SABBIA_MOCK_JUDGE_FAILURE;
          assert(result.reply.includes("[S1]") && result.citations.map(hit => hit.chunkId).join() === candidates.slice(0, 10).map(hit => hit.chunkId).join() && result.citations.every((hit, i) => hit.score === candidates[i].score), `Judge ${failure} broke the answer or lexical score`);
      }
      process.env.SABBIA_MOCK_JUDGE_REPLY = '{"relevant":false,"confidence":0.9,"answerable":"","reason":"No evidence"}';
      const rejected = await runTurn(threads.create("knowledge").id, "shipping", corpus.id);
      assert(rejected.reply.length > 0 && !/corpus|chunk|\[S/i.test(rejected.reply) && !rejected.citations.length, "Explicit judge insufficiency did not use natural fallback");
      delete process.env.SABBIA_MOCK_JUDGE_REPLY;
      console.log("PASS judge failure: garbage, timeout, invalid confidence retain all capped passages; explicit rejection uses insufficient reply");

      const lexical = await retrieve("shipping", corpus.id);
      await embedChunks(rows(corpus.id));
      process.env.SABBIA_MOCK_EMBED_FAILURE = "1";
      assert(JSON.stringify(await retrieve("shipping", corpus.id)) === JSON.stringify(lexical), "Embedding outage changed lexical results");
      const outage = await runTurn(threads.create("knowledge").id, "shipping", corpus.id);
      assert(outage.reply.includes("[S1]") && outage.citations.length > 0, "Embedding outage broke answer");
      const failedSource = sources.create(corpus.id, "Failed embedding", "text/plain", "embed-outage.txt", 20, "embed-outage");
      await Bun.write(join(directory, "uploads", "embed-outage.txt"), "# Outage policy\n\nOrders ship in three business days.");
      enqueueIngestion(failedSource); await pendingIngestion();
      assert(sources.get(failedSource.id)?.status === "indexed" && !rows(corpus.id).filter(c => c.source_id === failedSource.id).some(c => db.query("SELECT chunk_id FROM chunk_vectors WHERE chunk_id=?").get(c.id)), "Embedding failure broke ingestion or wrote vectors");
      delete process.env.SABBIA_MOCK_EMBED_FAILURE;
      console.log("PASS provider outage: identical lexical retrieval, cited answer, upload stays indexed with missing vectors");

      const old = corpora.create("Old model"), oldSource = sources.create(old.id, "Old", "text/plain", "old", 0, "old");
      chunks.add(oldSource.id, 1, "Old", "Unrelated content"); sources.update(oldSource.id, "indexed", 1);
      vectors.add(rows(old.id)[0].id, old.id, "different/model", [1, 0, 1]);
      assert(vectors.count(old.id, MODELS.embedMain.id) === 0 && vectors.getByCorpus(old.id, MODELS.embedMain.id).length === 0 && (await denseCandidates("how long until it arrives", old.id)).length === 0, "Mixed model/dimension was compared");
      const blob = db.query<{ size: number; kind: string }, [string]>("SELECT length(vector) AS size,typeof(vector) AS kind FROM chunk_vectors WHERE corpus_id=?").get(demo)!;
      assert(blob.size === 8192 && blob.kind === "blob", "Vector not Float32 BLOB");
      console.log("PASS no mixed dimensions: different model ignored; current vectors stored as 8192-byte Float32 BLOBs");

      // Remove one current vector and replace another with an old-model row.
      const currentRows = rows(corpus.id);
      db.prepare("DELETE FROM chunk_vectors WHERE chunk_id=?").run(currentRows[0].id);
      vectors.add(currentRows[1].id, corpus.id, "different/model", [1, 0]);
      const backfill = async () => {
        const child = Bun.spawn([process.execPath, "run", "scripts/backfill-vectors.ts"], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
        const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
        assert(await child.exited === 0, `Backfill failed: ${await error}`); return output;
      };
      await backfill();
      assert(vectors.count(corpus.id, MODELS.embedMain.id) === currentRows.length && (await backfill()).includes("0 embedded"), "Backfill not idempotent or failed old-model replacement");
      process.env.SABBIA_MOCK_EMBED_FAILURE = "1";
      const lexicalBaseline = JSON.stringify(await retrieve("shipping", corpus.id));
      delete process.env.SABBIA_MOCK_EMBED_FAILURE;
      const disabledCode = `
        const {retrieve}=await import('./src/rag.ts');
        const {runTurn}=await import('./src/agents.ts');
        const {requestContext}=await import('./src/context.ts');
        const {threads,events}=await import('./src/db.ts');
        await requestContext.run({visitor:'vector-smoke',ip:'local',operator:true},async()=>{
          if(JSON.stringify(await retrieve('shipping',${JSON.stringify(corpus.id)}))!==${JSON.stringify(lexicalBaseline)})throw new Error('Disabled dense changed lexical bytes');
          const id=threads.create('knowledge').id;
          await runTurn(id,'shipping',${JSON.stringify(corpus.id)});
          if([...events.after(id,0)].some(e=>e.tool==='judge_retrieval'||e.tool==='verify_answer'))throw new Error('Disabled judge was called');
          console.log(JSON.stringify(await retrieve('how long until it arrives',${JSON.stringify(demo)})));
        });`;
      const disabled = Bun.spawn([process.execPath, "--eval", disabledCode], { env: { ...process.env, SABBIA_DENSE_RETRIEVAL: "0", SABBIA_JUDGE_RETRIEVAL: "0", SABBIA_VERIFY_ANSWERS: "0" }, stdout: "pipe", stderr: "pipe" });
      const disabledOutput = new Response(disabled.stdout).text(), disabledError = new Response(disabled.stderr).text();
      assert(await disabled.exited === 0 && JSON.parse((await disabledOutput).trim()).hits.length === 0, `Disable switches failed: ${await disabledError}`);
      const sourceChunks = rows(old.id).map(row => row.id); sources.remove(oldSource.id);
      assert(!sourceChunks.some(id => db.query("SELECT chunk_id FROM chunk_vectors WHERE chunk_id=?").get(id)), "Vectors survived source deletion");
      assert(modelRegistry().find(m => m.role === "embedMain")?.capabilities[0] === "embedding" && modelRegistry().find(m => m.role === "judgeMain")?.capabilities[0] === "judge", "New capabilities missing");
      console.log("PASS vector operations: idempotent backfill, old-model replacement, disable switches, deletion, registry");
    });
    const provider = Bun.spawn([process.execPath, "run", "scripts/vector-smoke.ts", "--provider"], { env: { ...process.env }, stdout: "inherit", stderr: "inherit" });
    assert(await provider.exited === 0, "Provider contract checks failed");
    console.log("VECTOR SMOKE PASS: all 6 requested checks plus provider/backfill/disable/cleanup checks passed");
  }
} finally {
  db.close(true);
  const root = resolve(tmpdir()) + sep, target = resolve(directory);
  if (target.startsWith(root) && target.slice(root.length).startsWith("sabbia-vectors-") && !target.slice(root.length).includes(sep)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

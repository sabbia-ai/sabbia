import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "sabbia-map-"));
Object.assign(process.env, { SABBIA_DATA_DIR: directory, SABBIA_MOCK: "0", NVIDIA_API_KEY: Array.from({ length: 20 }, (_, i) => `offline-test-key-${i}`).join(","), NVIDIA_KEYS_FILE: "", SABBIA_LOG_LEVEL: "error", SABBIA_JUDGE_MAX_SEGMENTS: "10", SABBIA_JUDGE_CONCURRENCY: "2", SABBIA_DENSE_RETRIEVAL: "1", SABBIA_JUDGE_RETRIEVAL: "1", SABBIA_VERIFY_ANSWERS: "1" });
const { db, corpora, sources, chunks, threads, events, vectors, turns } = await import("../src/db");
const { requestContext } = await import("../src/context");
const { config } = await import("../src/config");
const { MODELS, modelRegistry } = await import("../src/models");
const { retrieve } = await import("../src/rag");
const { runTurn, judgeRetrieval, JUDGE_SYSTEM, VERIFY_SYSTEM } = await import("../src/agents");
import type { Message } from "../src/nvidia";
import type { Hit } from "../src/rag";
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
const originalFetch = globalThis.fetch;
const calls: { role: string; messages: Message[] }[] = [];
let keep = new Set([1, 3]), failedSegment = 0, judgeGarbage = false, verifier = "ok", active = 0, peak = 0;
const shipping = "Standard warehouse orders ship within three business days. Returns are accepted within thirty days with a receipt. Support runs Monday to Friday.";
globalThis.fetch = (async (_input: unknown, options?: RequestInit) => {
  const body = JSON.parse(String(options?.body)) as { model: string; messages: Message[]; temperature: number; max_tokens: number; stream: boolean };
  if ("input" in body) {
    const vector = Array<number>(2048).fill(0); vector[0] = 1;
    return Response.json({ data: [{ index: 0, embedding: vector }] });
  }
  const system = String(body.messages[0]?.content), user = String(body.messages.at(-1)?.content);
  const role = system === JUDGE_SYSTEM ? "judge" : system === VERIFY_SYSTEM ? "verify" : body.model === MODELS.guardMain.id ? "guard" : "answer";
  calls.push({ role, messages: body.messages });
  let content = "safe";
  if (role === "judge") {
    assert(body.temperature === 0 && body.max_tokens === 220, "Judge wire parameters changed");
    const segment = Number(user.match(/Passage: Shipping (\d+)/)?.[1] ?? 1);
    active++; peak = Math.max(peak, active); await Bun.sleep(8); active--;
    if (segment === failedSegment) throw new Error("Stub segment failure");
    const bridged = user.includes("Question: how long until it arrives") && user.includes(shipping) && system.includes("operational fact that determines it");
    content = judgeGarbage ? "garbage" : JSON.stringify({ relevant: bridged || keep.has(segment), confidence: 0.9, answerable: bridged ? shipping.split(".")[0] + "." : "", reason: "Stub verdict" });
  } else if (role === "verify") {
    assert(body.max_tokens === 400 && body.temperature === 0, "Verifier wire parameters changed");
    if (verifier === "throw") throw new Error("Stub verifier failure");
    content = verifier === "garbage" ? "garbage" : JSON.stringify({ supported: verifier !== "reject", unsupported: verifier === "reject" ? [2] : [], reason: "Stub verification" });
  } else if (role === "answer") {
    content = "Shipping takes three business days [S1].";
  }
  if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  return Response.json({ choices: [{ message: { content } }] });
}) as typeof fetch;
try {
  await requestContext.run({ visitor: "map-smoke", ip: "local", operator: true }, async () => {
    const corpus = corpora.create("Map fixtures"), source = sources.create(corpus.id, "Shipping", "text/plain", "fixture", 0, "fixture");
    for (let i = 1; i <= 4; i++) chunks.add(source.id, i, `Shipping ${i}`, `Shipping segment ${i}: standard orders ship in three business days. ${"Raw detail. ".repeat(80)}`);
    sources.update(source.id, "indexed", 4);
    const candidates = (await retrieve("shipping", corpus.id, 4)).hits;
    const setCount = (n: number) => { db.prepare("DELETE FROM chunks WHERE source_id=? AND ordinal>?").run(source.id, n); sources.update(source.id, "indexed", n); };
    const turn = async () => { calls.length = 0; return runTurn(threads.create("knowledge").id, "shipping", corpus.id); };
    // Three provider calls, each with precisely one entire raw passage.
    setCount(3);
    const mapped = await turn();
    const judges = calls.filter(c => c.role === "judge"), context = String(calls.find(c => c.role === "answer")?.messages.at(-1)?.content);
    assert(judges.length === 3 && peak === 2, "Map count or concurrency bound failed");
    for (const [i, call] of judges.entries()) assert(call.messages.length === 2 && call.messages[1].content === `Question: shipping\n\nPassage: ${candidates[i].heading}\n${candidates[i].content}`, "Judge did not read exactly one raw segment");
    assert(mapped.citations.length === 2 && context.includes(candidates[0].content) && context.includes(candidates[2].content) && !context.includes(candidates[1].content), "Rejected segment reached answer model");
    assert(calls.filter(c => c.role === "verify").every(c => String(c.messages[1].content).includes(candidates[0].content)), "Verifier missed raw sources");
    console.log("PASS per-segment map: 3 raw passages → 3 calls, concurrency 2, only relevant passages reach answer");

    const bridgeThread = threads.create("knowledge").id;
    const bridgeHit: Hit = { ...candidates[0], content: shipping };
    const bridge = await judgeRetrieval("how long until it arrives", [bridgeHit], bridgeThread, "bridge");
    assert(bridge.hits[0]?.answerable === "Standard warehouse orders ship within three business days.", "Bridged shipping paraphrase rejected");
    // Citation projection used by both persistence and SSE retains the optional field.
    const projected = bridge.hits.map(({ content: _content, ...hit }) => hit);
    assert(projected[0].answerable === bridge.hits[0].answerable, "Supporting sentence lost");
    const bridgeCorpus = corpora.create("Shipping bridge"), bridgeSource = sources.create(bridgeCorpus.id, "how long until it arrives", "text/plain", "bridge", 0, "bridge");
    chunks.add(bridgeSource.id, 1, "Shipping 1", shipping); sources.update(bridgeSource.id, "indexed", 1);
    const bridgeTurn = await runTurn(bridgeThread, "how long until it arrives", bridgeCorpus.id);
    const bridgeBlocks = JSON.parse(turns.get(bridgeTurn.turnId, bridgeThread)!.blocks_json) as { kind: string; citations?: Hit[] }[];
    const bridgeEvent = [...events.after(bridgeThread, 0)].find(e => e.kind === "citations.set");
    assert(bridgeBlocks.find(b => b.kind === "citations")?.citations?.[0].answerable === projected[0].answerable && (bridgeEvent?.citations as Hit[])[0].answerable === projected[0].answerable, "Supporting sentence lost in storage or SSE");
    console.log("PASS bridged paraphrase: relevant:true, exact shipping sentence carried on citation");

    keep = new Set([1]); failedSegment = 2;
    const failed = await turn();
    assert(failed.citations.some(h => h.chunkId === candidates[1].chunkId) && failed.reply.includes("[S1]"), "Judge exception dropped passage");
    failedSegment = 0; judgeGarbage = true;
    assert((await turn()).citations.length === 3, "Malformed judge response dropped passages");
    judgeGarbage = false;
    console.log("PASS fail-open judging: one thrown call retained; malformed JSON retains every passage");

    keep = new Set([2, 4]); calls.length = 0;
    const renumbered = await judgeRetrieval("shipping", candidates, threads.create("knowledge").id, "renumber");
    const { assembleContext } = await import("../src/rag");
    const numbered = assembleContext(renumbered.hits, true);
    assert(renumbered.hits.map(h => h.chunkId).join() === [candidates[1], candidates[3]].map(h => h.chunkId).join() && numbered.includes(`[S1] Shipping \u00b7 chunk 2 \u00b7 Shipping 2\n${candidates[1].content}`) && numbered.includes(`[S2] Shipping \u00b7 chunk 4 \u00b7 Shipping 4\n${candidates[3].content}`) && !numbered.includes("[S3]"), "Renumbering changed contents");
    chunks.add(source.id, 4, "Shipping 4", candidates[3].content); sources.update(source.id, "indexed", 4);
    await turn();
    assert(String(calls.find(c => c.role === "answer")?.messages.at(-1)?.content).includes(numbered), "Renumbered raw sources did not reach answer model");
    console.log("PASS renumbering: positions 2 and 4 reach answer as [S1] and [S2], correct full contents");

    verifier = "reject";
    const regenerated = await turn();
    assert(calls.filter(c => c.role === "answer").length === 2 && calls.filter(c => c.role === "verify").length === 2, "Verification retry loop was not bounded");
    assert(String(calls.filter(c => c.role === "answer")[1].messages.at(-1)?.content) === "The previous answer contained unsupported claims about [S2]. Answer again using only what the passages state.", "Regeneration instruction differs");
    const stored = JSON.parse(turns.get(regenerated.turnId, db.query<{ thread_id: string }, [string]>("SELECT thread_id FROM turns WHERE id=?").get(regenerated.turnId)!.thread_id)!.blocks_json) as { kind: string; text?: string }[];
    assert(stored.find(b => b.kind === "text")?.text === regenerated.reply && [...events.after(db.query<{ thread_id: string }, [string]>("SELECT thread_id FROM turns WHERE id=?").get(regenerated.turnId)!.thread_id, 0)].filter(e => e.tool === "verify_answer").length === 4, "Verification journal or storage missing");
    assert(modelRegistry().find(m => m.role === "verifyMain")?.capabilities.join() === "judge", "Verifier registry missing");
    console.log("PASS verification: unsupported [S2] → exactly 1 regeneration, 2 verifications, journal and registry");

    for (const failure of ["throw", "garbage"]) {
      verifier = failure;
      const result = await turn();
      assert(result.reply === "Shipping takes three business days [S1]." && calls.filter(c => c.role === "answer").length === 1, "Verifier failure changed answer");
    }
    verifier = "ok";
    console.log("PASS verifier failure: exception and garbage preserve answer bytes, no regeneration");

    keep = new Set([1, 2, 3, 4]);
    const mutable = config as { denseRetrieval: boolean; judgeRetrieval: boolean; verifyAnswers: boolean };
    mutable.denseRetrieval = false;
    const lexical = JSON.stringify(await retrieve("shipping", corpus.id)), lexicalAnswer = await turn();
    const vector = Array<number>(2048).fill(0); vector[0] = 1;
    for (const hit of candidates) vectors.add(hit.chunkId, corpus.id, MODELS.embedMain.id, vector);
    mutable.denseRetrieval = true;
    const withoutSimilarity = (value: unknown) => JSON.stringify(value, (key, entry: unknown) => key === "similarity" ? undefined : entry);
    assert(withoutSimilarity(await retrieve("shipping", corpus.id)) === lexical, "Auxiliary dense changed lexical results");
    const denseAnswer = await turn();
    assert(denseAnswer.reply === lexicalAnswer.reply && withoutSimilarity(denseAnswer.citations) === JSON.stringify(lexicalAnswer.citations), "Dense changed grounded answer/citation fields");
    const auxiliary = sources.create(corpus.id, "Astronomy", "text/plain", "auxiliary", 0, "auxiliary");
    chunks.add(auxiliary.id, 1, "Astronomy", "Stars produce light."); sources.update(auxiliary.id, "indexed", 1);
    const auxiliaryId = db.query<{ id: string }, [string]>("SELECT id FROM chunks WHERE source_id=?").get(auxiliary.id)!.id;
    vectors.add(auxiliaryId, corpus.id, MODELS.embedMain.id, vector);
    const weaker = [...vector]; weaker[0] = 0.2; weaker[1] = Math.sqrt(0.96);
    for (const hit of candidates) vectors.add(hit.chunkId, corpus.id, MODELS.embedMain.id, weaker);
    const assisted = await retrieve("shipping", corpus.id);
    assert(assisted.hits[0].chunkId === candidates[0].chunkId && assisted.hits.find(h => h.chunkId === auxiliaryId)?.score === 1, "Dense rank 1 overtook lexical rank 1 or lost cosine relevance");
    mutable.denseRetrieval = false; mutable.judgeRetrieval = false; mutable.verifyAnswers = false;
    const disabled = await turn();
    assert(!calls.some(c => c.role === "judge" || c.role === "verify") && disabled.reply === lexicalAnswer.reply, "Disabled switches changed lexical reply");
    console.log("PASS dense auxiliary: lexical scores, order, reply and citation fields preserved, cosine carried; all switches off skip judge/verify");
    console.log("MAP/VERIFY SMOKE PASS: all 7 requested checks passed");
  });
} finally {
  globalThis.fetch = originalFetch; db.close(true);
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}




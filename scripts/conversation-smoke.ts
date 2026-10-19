import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "sabbia-conversation-"));
process.env.SABBIA_DATA_DIR = directory;
process.env.SABBIA_MOCK = "0";
process.env.NVIDIA_API_KEY = "offline-conversation-key";
delete process.env.NVIDIA_KEYS_FILE;
process.env.SABBIA_DENSE_RETRIEVAL = "1";
process.env.SABBIA_JUDGE_RETRIEVAL = "1";
process.env.SABBIA_VERIFY_ANSWERS = "1";
process.env.SABBIA_LOG_LEVEL = "error";

const { classifyIntent } = await import("../src/intents");
const { db, corpora, sources, chunks, vectors, threads, events } = await import("../src/db");
const { MODELS } = await import("../src/models");
const { requestContext } = await import("../src/context");
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
const calls: Record<string, number> = {};
let retrievalQueries = 0, unsafeFallback = false;
const originalFetch = globalThis.fetch;
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
const { retrieve, denseCandidates } = await import("../src/rag");
const { runTurn, fallbackPrompt } = await import("../src/agents");
globalThis.fetch = (async (_input: unknown, options?: RequestInit) => {
  const body = JSON.parse(String(options?.body)) as { model: string; messages?: { role: string; content: string }[] };
  const role = body.messages?.[0]?.content.includes("A knowledge search was run for this message") ? "textFast" : Object.entries(MODELS).find(([, model]) => model.id === body.model)?.[0] ?? "unknown";
  calls[role] = (calls[role] ?? 0) + 1;
  if (role === "embedMain") {
    const vector = Array<number>(MODELS.embedMain.dim).fill(0); vector[1] = 1;
    return Response.json({ data: [{ index: 0, embedding: vector }] });
  }
  let content = "safe";
  if (role === "judgeMain") content = JSON.stringify({ relevant: false, confidence: 0.98, answerable: "", reason: "Unrelated question" });
  if (role === "textFast") {
    const prompt = body.messages?.[0]?.content;
    assert(prompt === fallbackPrompt(body.messages?.at(-1)?.content ?? ""), "Fallback did not use exact language-directed prompt");
    content = unsafeFallback ? 'corpus chunks closest heading upload a document try a focused search "why" [S1]' : "Could you tell me which part you want explained?";
  }
  return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 8 } });
}) as typeof fetch;

try {
  await requestContext.run({ visitor: "conversation-smoke", ip: "local", operator: true }, async () => {
    const corpus = corpora.create("Private diagnostic name"), source = sources.create(corpus.id, "Private heading", "text/plain", "conversation", 0, "conversation");
    chunks.add(source.id, 1, "Private heading", "What is shipping? Standard orders ship within three business days."); sources.update(source.id, "indexed", 1);
    const id = db.query<{ id: string }, [string]>("SELECT id FROM chunks WHERE source_id=?").get(source.id)!.id;
    const vector = Array<number>(MODELS.embedMain.dim).fill(0); vector[0] = 1;
    vectors.add(id, corpus.id, MODELS.embedMain.id, vector);
    const conversational = [
      "ok", "okay", "k", "yes", "yeah", "yep", "no", "nope", "sure", "cool", "nice", "great", "fine", "lol", "hmm", "umm", "got it", "understood", "alright", "right", "noted",
      "thanks", "thx", "thank you", "3q", "ty",
      "hello", "hi", "hey", "hi there", "hello there", "good morning", "good afternoon", "good evening", "howdy",
      "bye", "goodbye", "see you", "see ya", "later",
      "?", "...", "!!", "???", "  OKAY!!!  ", "x", "a a", "", "xx", "zzz", "hello there",
    ];
    for (const text of conversational) assert(classifyIntent(text) === "smalltalk", `Conversation classified as knowledge: ${text}`);
    console.log(`PASS conversational 3/7: all ${conversational.length} listed/normalized/symbol/tokenless inputs are smalltalk`);
    for (const text of ["what is the returns policy?", "how long until it arrives", "air conditioner", "hello, what is the returns policy?", "thanks, so how long until it arrives?", "what limits apply to the 14 units", "why do you output these", "what does this document cover"]) assert(classifyIntent(text) === "knowledge", `Real question classified as conversational: ${text}`);
    console.log("PASS conversational 4/7: all six required real questions plus two regressions remain knowledge");
    const localReplies = new Map<string, string>();
    calls.embedMain = 0; calls.judgeMain = 0; retrievalQueries = 0;
    for (const [index, text] of conversational.entries()) {
      const result = await runTurn(threads.create(["knowledge", "support", "voice"][index % 3]).id, text, corpus.id);
      localReplies.set(text, result.reply);
      assert(result.reply.length > 0 && !result.citations.length, `Empty/cited local reply: ${text}`);
    }
    assert(Object.values(calls).every(n => n === 0) && retrievalQueries === 0, `Wasted pipeline: ${JSON.stringify({ calls, retrievalQueries })}`);
    for (const text of conversational) {
      assert((await retrieve(text, corpus.id)).insufficient && !(await denseCandidates(text, corpus.id)).length, "Direct retrieval allowed tokenless input");
    }
    assert(calls.embedMain === 0 && calls.judgeMain === 0 && retrievalQueries === 0, "Direct retrieval wasted work");
    console.log("PASS conversational 5/7: stub provider counts embedding=0, judge=0, all models=0, retrieval queries=0 (including direct retrieval)");
    const replies = [localReplies.get("ok")!, localReplies.get("?")!];
    for (const text of ["why do you output these shipping notes", "what does a quantum computer cost?", "What is the price of a quantum computer?"]) {
      const thread = threads.create("knowledge").id, before = calls.textFast ?? 0;
      const result = await runTurn(thread, text, corpus.id); replies.push(result.reply);
      assert(calls.textFast === before + 1 && !result.citations.length, "Fallback did not use exactly one fast completion with no citations");
      const journal = [...events.after(thread, 0)];
      const diagnostics = journal.find(event => event.kind === "tool.result" && event.tool === "insufficient_diagnostics");
      assert(diagnostics?.corpusId === corpus.id && diagnostics.chunkCount === 1 && Array.isArray(diagnostics.tokens) && Array.isArray(diagnostics.verdicts), "Missing journal-only diagnostics");
      if (text === "why do you output these shipping notes") assert(retrievalQueries > 0 && calls.embedMain > 0 && calls.judgeMain > 0 && diagnostics.closestHeading === "Private heading" && (diagnostics.verdicts as unknown[]).length === 1, "Judge diagnostics missing");
      const chinese = /\p{Script=Han}/u.test(text);
      assert(chinese ? /\p{Script=Han}/u.test(result.reply) && !/[a-z]{2,}\s+[a-z]{2,}/i.test(result.reply) : /[a-z]/i.test(result.reply) && !/\p{Script=Han}/u.test(result.reply), `Wrong reply language: ${result.reply}`);
    }
    unsafeFallback = true;
    replies.push((await runTurn(threads.create("knowledge").id, "quantum computer price?", corpus.id)).reply);
    assert(replies.every(reply => reply.trim() && !/corpus|chunk|closest heading|upload a document|try a focused search|\[S/i.test(reply)), `Boilerplate escaped into chat: ${replies.join(" / ")}`);
    console.log("PASS conversational 1/7: four required cases and adversarial fallback have nonempty replies, no boilerplate or source markers");
    assert(/welcome/i.test(localReplies.get("thanks")!) && /goodbye/i.test(localReplies.get("bye")!) && /hello/i.test(localReplies.get("hello")!) && localReplies.get("ok") === "Okay. Is there anything else I can help with?", "Local subcase mismatch");
    console.log("PASS conversational 2/7: local subcases answer by kind, fallback stays nonempty");
  });
} finally {
  globalThis.fetch = originalFetch; db.query = originalQuery; db.prepare = originalPrepare; db.close(true);
  const root = resolve(tmpdir()) + sep, target = resolve(directory);
  if (target.startsWith(root) && target.slice(root.length).startsWith("sabbia-conversation-") && !target.slice(root.length).includes(sep)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

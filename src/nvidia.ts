import { config, log } from "./config";
import { MODELS, type ModelRole } from "./models";
import { keyAttemptLimit, keyFailure, keySuccess, takeKey } from "./keys";
import { modelCalls } from "./db";
import { mockReply, mockEmbedding } from "./mock";
import { HttpError } from "./http";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface Message { role: "system" | "user" | "assistant"; content: string | ContentPart[] }
export interface Usage { prompt_tokens: number; completion_tokens: number }
export interface Completion { content: string; usage: Usage; model: string; latency_ms: number }
interface WireResponse { choices?: { message?: { content?: string | null; reasoning_content?: string }; delta?: { content?: string }; finish_reason?: string }[]; usage?: Partial<Usage> }
const usageFrom = (u?: Partial<Usage>): Usage => ({ prompt_tokens: u?.prompt_tokens ?? 0, completion_tokens: u?.completion_tokens ?? 0 });
function safeError(status: number) { return `Provider returned HTTP ${status}`; }
function parseWire(text: string): WireResponse { try { return JSON.parse(text) as WireResponse; } catch { throw new Error("Provider returned invalid or empty JSON"); } }

async function providerCall(role: ModelRole, messages: Message[], thread: string | null, stream: boolean, maxTokens: number, delta?: (text: string) => void): Promise<Completion & { reasoningOnly: boolean }> {
  const model = MODELS[role], began = Date.now();
  if (config.mock) {
    if (role === "judgeMain" && process.env.SABBIA_MOCK_JUDGE_FAILURE === "timeout") {
      modelCalls.add(thread, role, model.id, 0, 0, model.timeoutMs, false, "Provider timed out");
      throw new HttpError(502, "Provider timed out");
    }
    const content = mockReply(role, messages), usage = { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4), completion_tokens: Math.ceil(content.length / 4) };
    if (delta) for (let i = 0; i < content.length; i += 24) { delta(content.slice(i, i + 24)); await Bun.sleep(2); }
    modelCalls.add(thread, role, model.id, usage.prompt_tokens, usage.completion_tokens, Date.now() - began, true, null);
    return { content, usage, model: model.id, latency_ms: Date.now() - began, reasoningOnly: false };
  }
  const excluded = new Set<number>();
  const attempts = role === "visionAlt" ? Math.min(1, keyAttemptLimit()) : keyAttemptLimit();
  for (let attempt = 0; attempt < attempts; attempt++) {
    let key: { index: number; secret: string };
    try { key = takeKey(excluded); } catch { throw new HttpError(503, "All provider keys are cooling down; retry shortly"); }
    excluded.add(key.index); const started = Date.now(); let emitted = false;
    const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), model.timeoutMs);
    let status = 0;
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST", signal: abort.signal,
        headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ model: model.id, messages, max_tokens: role === "visionMain" ? Math.max(1200, maxTokens) : maxTokens, temperature: role.startsWith("guard") || role === "textFast" || role === "judgeMain" || role === "verifyMain" ? 0 : 0.2, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }),
      });
      status = response.status;
      if (!response.ok) { await response.body?.cancel(); throw new Error(safeError(status)); }
      let content = "", reasoningOnly = false, usage = usageFrom();
      if (!stream) { const result = parseWire(await response.text()); const message = result.choices?.[0]?.message; content = message?.content ?? ""; reasoningOnly = !content.trim() && !!message?.reasoning_content; usage = usageFrom(result.usage); }
      else {
        if (!response.body) throw new Error("Provider returned no stream");
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", doneMarker = false;
        const line = (raw: string) => { if (!raw.startsWith("data:")) return; const data = raw.slice(5).trim(); if (data === "[DONE]") { doneMarker = true; return; } if (!data) return; const result = parseWire(data); const token = result.choices?.[0]?.delta?.content; if (token) { emitted = true; content += token; delta?.(token); } if (result.usage) usage = usageFrom(result.usage); };
        try { while (true) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true }); let end: number; while ((end = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, end).replace(/\r$/, "")); buffer = buffer.slice(end + 1); } } buffer += decoder.decode(); if (buffer.trim()) line(buffer.trim()); } finally { reader.releaseLock(); }
        if (!doneMarker) throw new Error("Provider stream ended before completion");
      }
      if (!content.trim() && !reasoningOnly) throw new Error("Provider returned empty message content");
      keySuccess(key.index); modelCalls.add(thread, role, model.id, usage.prompt_tokens, usage.completion_tokens, Date.now() - started, true, null);
      return { content, usage, model: model.id, latency_ms: Date.now() - began, reasoningOnly };
    } catch {
      const retryable = status === 0 || [429, 500, 502, 503].includes(status);
      const error = abort.signal.aborted ? "Provider timed out" : status && status !== 200 ? safeError(status) : "Provider network or response failure";
      keyFailure(key.index, error, retryable); modelCalls.add(thread, role, model.id, 0, 0, Date.now() - started, false, error);
      log("warn", error, { extra: { model: model.id, attempt: attempt + 1 } });
      if (!retryable || emitted || attempt + 1 >= attempts) throw new HttpError(502, `${error}${status === 404 ? "; this model may not be enabled for the account" : ""}`);
    } finally { clearTimeout(timeout); }
  }
  throw new HttpError(503, "No provider keys available");
}
export async function chat(role: ModelRole, messages: Message[], thread: string | null = null): Promise<Completion> {
  const model = MODELS[role];
  if (!("maxTokens" in model)) throw new HttpError(400, "This model role does not support chat");
  let result = await providerCall(role, messages, thread, false, model.maxTokens);
  // Reasoning stays private; only final message.content is ever consumed.
  if (role === "visionMain" && result.reasoningOnly) result = await providerCall(role, messages, thread, false, MODELS[role].maxTokens * 2);
  if (!result.content.trim()) throw new HttpError(502, "Vision model returned empty content after increasing max_tokens");
  return result;
}
export async function chatStream(role: ModelRole, messages: Message[], thread: string, delta: (text: string) => void) {
  const model = MODELS[role];
  if (!("maxTokens" in model)) throw new HttpError(400, "This model role does not support chat");
  return providerCall(role, messages, thread, true, model.maxTokens, delta);
}

export class EmbeddingError extends HttpError {
  constructor(message: string, readonly code: "invalid_response" | "unavailable" = "unavailable", status = 502) {
    super(status, message); this.name = "EmbeddingError";
  }
}
interface EmbeddingResponse { data?: { index?: number; embedding?: unknown }[]; usage?: Partial<Usage> }
export async function embed(role: ModelRole, inputs: string[], inputType: "query" | "passage"): Promise<number[][]> {
  const model = MODELS[role];
  if (!("dim" in model)) throw new EmbeddingError("This model role does not support embeddings");
  const vectors: number[][] = [];
  for (let offset = 0; offset < inputs.length; offset += 32) {
    const batch = inputs.slice(offset, offset + 32);
    if (config.mock) {
      const began = Date.now();
      if (process.env.SABBIA_MOCK_EMBED_FAILURE === "1") {
        modelCalls.add(null, role, model.id, 0, 0, Date.now() - began, false, "Provider network or response failure");
        throw new EmbeddingError("Provider network or response failure");
      }
      vectors.push(...batch.map(input => mockEmbedding(input, model.dim)));
      modelCalls.add(null, role, model.id, Math.ceil(batch.join("").length / 4), 0, Date.now() - began, true, null);
      continue;
    }
    const excluded = new Set<number>(), attempts = keyAttemptLimit();
    for (let attempt = 0; attempt < attempts; attempt++) {
      let key: { index: number; secret: string };
      try { key = takeKey(excluded); } catch { throw new EmbeddingError("All provider keys are cooling down; retry shortly", "unavailable", 503); }
      excluded.add(key.index);
      const started = Date.now(), abort = new AbortController(), timeout = setTimeout(() => abort.abort(), model.timeoutMs);
      let status = 0;
      try {
        const response = await fetch(`${config.baseUrl}/embeddings`, {
          method: "POST", signal: abort.signal,
          headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ model: model.id, input: batch, input_type: inputType, truncate: "END", encoding_format: "float" }),
        });
        status = response.status;
        if (!response.ok) { await response.body?.cancel(); throw new Error(safeError(status)); }
        let result: EmbeddingResponse;
        try { result = await response.json() as EmbeddingResponse; } catch { throw new EmbeddingError("Provider returned invalid embedding JSON", "invalid_response"); }
        if (!result || !Array.isArray(result.data) || result.data.length !== batch.length) throw new EmbeddingError("Provider returned no embedding array", "invalid_response");
        const ordered: number[][] = new Array(batch.length);
        for (const [position, item] of result.data.entries()) {
          const index = item?.index ?? position, vector = item?.embedding;
          if (!Number.isInteger(index) || index < 0 || index >= batch.length || ordered[index] || !Array.isArray(vector) || vector.length !== model.dim || !vector.every(v => typeof v === "number" && Number.isFinite(v))) {
            throw new EmbeddingError("Provider returned an invalid embedding array or dimension", "invalid_response");
          }
          ordered[index] = vector as number[];
        }
        keySuccess(key.index);
        modelCalls.add(null, role, model.id, usageFrom(result.usage).prompt_tokens, 0, Date.now() - started, true, null);
        vectors.push(...ordered); break;
      } catch (cause) {
        const retryable = status === 0 || [429, 500, 502, 503].includes(status);
        const error = abort.signal.aborted ? "Provider timed out" : status && status !== 200 ? safeError(status) : cause instanceof EmbeddingError ? cause.message : "Provider network or response failure";
        keyFailure(key.index, error, retryable);
        modelCalls.add(null, role, model.id, 0, 0, Date.now() - started, false, error);
        log("warn", error, { extra: { model: model.id, attempt: attempt + 1 } });
        if (!retryable || attempt + 1 >= attempts) throw new EmbeddingError(error, cause instanceof EmbeddingError ? cause.code : "unavailable");
      } finally { clearTimeout(timeout); }
    }
  }
  return vectors;
}
export async function visionCompletion(messages: Message[], thread: string | null = null, preferred: "visionMain" | "visionAlt" | "visionLean" = "visionMain"): Promise<Completion> {
  if (preferred !== "visionAlt") return chat(preferred, messages, thread);
  // Exactly one model-level retry, followed by the reasoning model fallback.
  for (let attempt = 0; attempt < 2; attempt++) { try { return await chat("visionAlt", messages, thread); } catch { /* Fallback below after one retry. */ } }
  return chat("visionMain", messages, thread);
}
export function extractJson(text: string): unknown {
  const start = text.indexOf("{"); if (start < 0) throw new Error("No JSON object in response");
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) { const c = text[i]; if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; } else if (c === '"') quoted = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as unknown; }
  throw new Error("Incomplete JSON object");
}

import { assets, visionRuns } from "./db";
import { objectFile, HttpError } from "./http";
import { extractJson, visionCompletion, type Message } from "./nvidia";

export type VisionTask = "describe" | "text" | "table" | "qa";
const prompts: Record<VisionTask, string> = {
  describe: "Describe the visible scene in detail: objects, layout, colors, and relationships. State uncertainty. Do not infer hidden facts.",
  text: "Transcribe all visible text, preserving line breaks and reading order. Do not add text that is not visible.",
  table: 'Extract the visible table. Reply with a single JSON object and nothing else: {"columns":["column"],"rows":[["cell"]]}. Use strings for all cells. Do not invent values.',
  qa: "Answer the following question strictly from the image. If it cannot be determined, say so. Question: ",
};
function parseTable(text: string): { columns: string[]; rows: string[][] } {
  const value = extractJson(text) as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(value.columns) || !value.columns.every(c => typeof c === "string") || !Array.isArray(value.rows) || !value.rows.every(r => Array.isArray(r) && r.length === (value.columns as unknown[]).length && r.every(c => typeof c === "string" || typeof c === "number"))) throw new Error("Invalid table response");
  return { columns: value.columns, rows: value.rows.map(r => (r as (string | number)[]).map(String)) };
}
export async function analyzeImage(assetId: string, task: VisionTask, question = "", thread: string | null = null) {
  const asset = assets.get(assetId); if (!asset) throw new HttpError(404, "Image asset not found");
  if (task === "qa" && !question) throw new HttpError(400, "A question is required for Q&A");
  const start = Date.now(), encoded = Buffer.from(await objectFile(asset.object_key).arrayBuffer()).toString("base64");
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompts[task] + (task === "qa" ? question : "") }, { type: "image_url", image_url: { url: `data:${asset.mime};base64,${encoded}` } }] }];
  let completion = await visionCompletion(messages, thread), result: unknown = completion.content;
  if (task === "table") {
    try { result = parseTable(completion.content); }
    catch {
      completion = await visionCompletion([...messages, { role: "assistant", content: completion.content }, { role: "user", content: 'Reply with a single JSON object and nothing else, containing "columns" and "rows" arrays. Use strings for cells.' }], thread);
      try { result = parseTable(completion.content); } catch { result = { text: completion.content, format: "plain_text" }; }
    }
  }
  const latency = Date.now() - start, id = visionRuns.add(assetId, thread, task, completion.model, result, latency);
  return { id, assetId, task, model: completion.model, result, latency_ms: latency };
}

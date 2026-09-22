import type { Message } from "./nvidia";
import type { ModelRole } from "./models";

export function mockReply(role: ModelRole, messages: Message[]): string {
  const text = messages.map(m => typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join("\n")).join("\n");
  const user = messages.filter(m => m.role === "user").at(-1)?.content;
  if (role.startsWith("guard")) return String(user).includes("BLOCKME") ? "unsafe" : "safe";
  if (role === "textFast") {
    if (text.includes("A knowledge search was run for this message") || text.includes("The knowledge search found no passage")) {
      if (process.env.SABBIA_MOCK_TEXT_FAST_REPLY !== undefined) return process.env.SABBIA_MOCK_TEXT_FAST_REPLY;
      return "The available information does not answer that. Could you be more specific?";
    }
    return JSON.stringify({ intent: /escalat|human|person|agent/i.test(String(user)) ? "escalation" : "knowledge", confidence: 0.93, needs_human: /escalat|human|person/i.test(String(user)) });
  }
  if (role === "judgeMain") {
    if (process.env.SABBIA_MOCK_JUDGE_REPLY !== undefined) return process.env.SABBIA_MOCK_JUDGE_REPLY;
    return JSON.stringify({ relevant: true, confidence: 0.9, answerable: "", reason: "Mock passage selection" });
  }
  if (role === "verifyMain") return JSON.stringify({ supported: true, unsupported: [], reason: "Mock grounding check" });
  if (role.startsWith("vision")) {
    if (/single JSON object/.test(text)) return JSON.stringify({ columns: ["item", "qty"], rows: [["bolt", "120"], ["nut", "340"]] });
    return "Mock image analysis: a clear sample image with a neutral background. This deterministic description exercises the image workflow offline.";
  }
  if (role === "textMain" && process.env.SABBIA_MOCK_TEXT_MAIN_REPLY !== undefined) return process.env.SABBIA_MOCK_TEXT_MAIN_REPLY;
  const context = text.match(/<context>([\s\S]*?)<\/context>/)?.[1] ?? "";
  const sections = [...context.matchAll(/\[(S\d+)\] ([^\n]+)\n([^]*?)(?=\n\[S\d+\]|$)/g)];
  if (sections.length) {
    const lines = sections.slice(0, 3).map(m => `The retrieved section ${m[2]} states: ${m[3].trim().replace(/\s+/g, " ").slice(0, 240)} [${m[1]}].`);
    while (lines.length < 3) lines.push(`The source heading is ${sections[0][2]} [S1].`);
    return lines.join(" ");
  }
  return "I can help you work through this request. Please share the relevant policy or product details. If you need a person, I can open an escalation.";
}

// Deterministic offline semantic fixtures; live retrieval always uses the provider.
export function mockEmbedding(text: string, dim: number): number[] {
  const vector = Array<number>(dim).fill(0);
  const concepts = [/\b(?:ship\w*|arriv\w*|warehouse|deliver\w*)\b/i, /\b(?:refund\w*|return\w*)\b/i, /\b(?:support|customer)\b/i];
  concepts.forEach((pattern, i) => { if (pattern.test(text)) vector[i] = 1; });
  const words = text.toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]{2}/gu) ?? [];
  for (const word of words) { let hash = 2166136261; for (const c of word) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619); vector[3 + (hash >>> 0) % (dim - 3)] += 0.1; }
  return vector;
}

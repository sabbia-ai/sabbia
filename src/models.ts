export const MODELS = {
  textMain: { id: "openai/gpt-oss-20b", timeoutMs: 60_000, maxTokens: 900 },
  embedMain: { id: "nvidia/nemotron-3.5-embed-1b", timeoutMs: 20_000, dim: 2048 },
  judgeMain: { id: "nvidia/nemotron-3.5-bolt-e4b", timeoutMs: 20_000, maxTokens: 220 },
  verifyMain: { id: "nvidia/nemotron-3.5-bolt-e4b", timeoutMs: 25_000, maxTokens: 400 },
  textFast: { id: "nvidia/nemotron-3.5-bolt-e4b", timeoutMs: 30_000, maxTokens: 400 },
  textBig: { id: "nvidia/nemotron-3-ultra-550b-a55b", timeoutMs: 120_000, maxTokens: 1200 },
  visionMain: { id: "nvidia/nemotron-3.5-super-vl-120b-a12b", timeoutMs: 90_000, maxTokens: 1400, reasoning: true },
  visionAlt: { id: "meta/llama-3.2-11b-vision-instruct", timeoutMs: 15_000, maxTokens: 600, retries: 1 },
  visionLean: { id: "meta/muse-glimmer-30b", timeoutMs: 60_000, maxTokens: 600 },
  guardMain: { id: "meta/llama-guard-4-12b", timeoutMs: 20_000, maxTokens: 64 },
  guardAlt: { id: "nvidia/nemotron-3.5-content-safety", timeoutMs: 20_000, maxTokens: 64 },
  guardJson: { id: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", timeoutMs: 20_000, maxTokens: 128 },
  codeFast: { id: "poolside/laguna-xs-2.1", timeoutMs: 60_000, maxTokens: 900 },
} as const;
export type ModelRole = keyof typeof MODELS;
export function modelRegistry() {
  return Object.entries(MODELS).map(([role, model]) => ({ id: model.id, role, capabilities: [role === "embedMain" ? "embedding" : role === "judgeMain" || role === "verifyMain" ? "judge" : role.startsWith("vision") ? "vision" : role.startsWith("guard") ? "guard" : "text"], timeoutMs: model.timeoutMs, ...("maxTokens" in model ? { maxTokens: model.maxTokens } : {}), ...("dim" in model ? { dim: model.dim } : {}) }));
}

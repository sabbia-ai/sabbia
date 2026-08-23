import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
function countEnv(name: string, fallback: number, max = 1000000) {
  const value = numberEnv(name, fallback, 1, max);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
const level = process.env.SABBIA_LOG_LEVEL ?? "info";
if (!["debug", "info", "warn", "error"].includes(level)) throw new Error("Invalid SABBIA_LOG_LEVEL");
if (process.env.SABBIA_MOCK && !["0", "1"].includes(process.env.SABBIA_MOCK)) throw new Error("SABBIA_MOCK must be 0 or 1");
for (const name of ["SABBIA_DENSE_RETRIEVAL", "SABBIA_JUDGE_RETRIEVAL", "SABBIA_VERIFY_ANSWERS"]) {
  if (process.env[name] && !["0", "1"].includes(process.env[name]!)) throw new Error(`${name} must be 0 or 1`);
}
const baseUrl = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
if (!["http:", "https:"].includes(new URL(baseUrl).protocol)) throw new Error("Invalid NVIDIA_BASE_URL");
export const config = {
  port: numberEnv("PORT", 3000, 1, 65535), host: process.env.HOST ?? "0.0.0.0",
  dataDir: resolve(process.env.SABBIA_DATA_DIR ?? "./data"), mock: process.env.SABBIA_MOCK === "1",
  baseUrl: baseUrl.replace(/\/$/, ""), maxUploadBytes: numberEnv("SABBIA_MAX_UPLOAD_MB", 25, 0.001, 1024) * 1024 * 1024,
  maxDatabaseBytes: numberEnv("SABBIA_MAX_DATABASE_MB", 512, 1, 1000000) * 1048576,
  authToken: process.env.SABBIA_AUTH_TOKEN ?? "",
  ratePerMin: countEnv("SABBIA_RATE_LIMIT_PER_MIN", 120, 1000000),
  modelPerMin: countEnv("SABBIA_MODEL_RATE_LIMIT_PER_MIN", 6, 1000000),
  modelGlobalPerMin: countEnv("SABBIA_MODEL_RATE_LIMIT_GLOBAL_PER_MIN", 60, 1000000),
  modelBudgetPerDay: countEnv("SABBIA_MODEL_BUDGET_PER_DAY", 1500, 10000000),
  uploadPerHour: countEnv("SABBIA_UPLOAD_RATE_PER_HOUR", 10, 1000000),
  maxStreams: countEnv("SABBIA_MAX_CONCURRENT_STREAMS", 40, 100000),
  maxStreamsPerIp: countEnv("SABBIA_MAX_CONCURRENT_STREAMS_PER_IP", 3, 100000),
  maxUploadTotalBytes: numberEnv("SABBIA_MAX_UPLOAD_TOTAL_MB", 500, 0.000001, 1000000) * 1048576,
  maxSources: countEnv("SABBIA_MAX_SOURCES", 50, 100000),
  retentionDays: numberEnv("SABBIA_RETENTION_DAYS", 14, 0.000001, 36500),
  maxJsonBytes: numberEnv("SABBIA_MAX_JSON_KB", 256, 1, 10240) * 1024,
  retrievalMinScore: numberEnv("SABBIA_RETRIEVAL_MIN_SCORE", 0.18, 0, 1), logLevel: level,
  denseRetrieval: process.env.SABBIA_DENSE_RETRIEVAL !== "0",
  judgeRetrieval: process.env.SABBIA_JUDGE_RETRIEVAL !== "0",
  judgeMaxSegments: countEnv("SABBIA_JUDGE_MAX_SEGMENTS", 10, 100),
  judgeConcurrency: countEnv("SABBIA_JUDGE_CONCURRENCY", 5, 20),
  verifyAnswers: process.env.SABBIA_VERIFY_ANSWERS !== "0",
  denseMinScore: numberEnv("SABBIA_DENSE_MIN_SCORE", 0.15, -1, 1),
} as const;
if (!Number.isInteger(config.port)) throw new Error("PORT must be an integer");
mkdirSync(`${config.dataDir}/uploads`, { recursive: true });
export function publicConfig() {
  return { dataDirConfigured: true, maxUploadMB: config.maxUploadBytes / 1048576, retrievalMinScore: config.retrievalMinScore, mock: config.mock };
}
const levels = ["debug", "info", "warn", "error"];
export function log(level: "debug" | "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  if (levels.indexOf(level) >= levels.indexOf(config.logLevel)) console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

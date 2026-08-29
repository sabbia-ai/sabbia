import { config, log } from "./config";

interface KeyState { secret: string; requests: number; failures: number; streak: number; cooldownUntil: number; lastError: string | null }
let fileKeys = "";
if (process.env.NVIDIA_KEYS_FILE) {
  try { fileKeys = await Bun.file(process.env.NVIDIA_KEYS_FILE).text(); }
  catch { throw new Error("NVIDIA_KEYS_FILE cannot be read"); }
}
const secrets = [...new Set([...(process.env.NVIDIA_API_KEY ?? "").split(","), ...fileKeys.split(/\r?\n/)].map(s => s.trim()).filter(Boolean))];
const pool: KeyState[] = secrets.map(secret => ({ secret, requests: 0, failures: 0, streak: 0, cooldownUntil: 0, lastError: null }));
if (!config.mock && !pool.length) throw new Error("Missing NVIDIA credentials: set NVIDIA_API_KEY or NVIDIA_KEYS_FILE, or SABBIA_MOCK=1");
let cursor = 0;
let lastWarning = 0;
export function keyHealth() {
  const now = Date.now();
  const available = pool.filter(k => k.cooldownUntil <= now).length;
  if (pool.length && available / pool.length < 0.2 && now - lastWarning > 5000) {
    lastWarning = now; log("warn", "Fewer than 20% of provider keys are usable", { extra: { total: pool.length, available } });
  }
  return { total: pool.length, available, requests: pool.reduce((s, k) => s + k.requests, 0), failures: pool.reduce((s, k) => s + k.failures, 0), cooling: pool.length - available };
}
export function takeKey(excluded: Set<number> = new Set()): { index: number; secret: string } {
  for (let n = 0; n < pool.length; n++) {
    const index = cursor++ % pool.length, key = pool[index];
    if (!excluded.has(index) && key.cooldownUntil <= Date.now()) { key.requests++; return { index, secret: key.secret }; }
  }
  keyHealth(); throw new Error("No provider keys are currently available; retry after cooldown");
}
export function keySuccess(index: number) { pool[index].streak = 0; pool[index].lastError = null; }
export function keyFailure(index: number, error: string, cooldown: boolean) {
  const key = pool[index]; key.failures++; key.lastError = error;
  if (cooldown) { key.cooldownUntil = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(key.streak++, 10)); keyHealth(); }
}
export const keyAttemptLimit = () => Math.min(pool.length, 5);

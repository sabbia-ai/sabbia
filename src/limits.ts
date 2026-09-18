import { config } from "./config";
import { db } from "./db";
import { HttpError } from "./http";
import { requestContext } from "./context";

interface Bucket { tokens: number; at: number }
// A full bucket can be discarded safely. Never evict a depleted bucket: reject
// new identities at capacity so rotating forged IPs cannot reset existing limits.
class Buckets {
  private entries = new Map<string, Bucket>();
  constructor(private capacity: number, private windowMs: number, private label: string) {}
  check(key: string, time = Date.now()) {
    if (this.entries.size >= 10000) this.clean(time);
    const old = this.entries.get(key);
    if (!old && this.entries.size >= 10000) rejectLimit(`${this.label} identity capacity`, 60);
    const bucket = old ?? { tokens: this.capacity, at: time };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (time - bucket.at) * this.capacity / this.windowMs); bucket.at = time;
    this.entries.set(key, bucket);
    if (bucket.tokens < 1) rejectLimit(this.label, (1 - bucket.tokens) * this.windowMs / this.capacity / 1000);
    return () => { bucket.tokens--; };
  }
  clean(time = Date.now()) { for (const [key, b] of this.entries) if (time - b.at >= this.windowMs) this.entries.delete(key); }
}
export function rejectLimit(label: string, seconds: number): never {
  const retry = Math.max(1, Math.ceil(seconds));
  throw new HttpError(429, `${label}; next available at ${new Date(Date.now() + retry * 1000).toISOString()}. Wait ${retry} seconds.`, retry);
}
const requests = new Buckets(config.ratePerMin, 60000, "Per-IP request limit");
const models = new Buckets(config.modelPerMin, 60000, "Per-IP model limit");
const globalModels = new Buckets(config.modelGlobalPerMin, 60000, "Global model limit");
const uploads = new Buckets(config.uploadPerHour, 3600000, "Per-IP upload limit");
export function requestLimit(ip: string) { requests.check(ip)(); }
export function uploadLimit(ip: string) { uploads.check(ip)(); }
const day = () => new Date().toISOString().slice(0, 10);
export function modelRemaining() { return Math.max(0, config.modelBudgetPerDay - (db.query<{ used: number }, [string]>("SELECT used FROM demo_budget WHERE day=?").get(day())?.used ?? 0)); }
export function modelLimit(ip: string) {
  if (modelRemaining() < 1) rejectLimit("The public demo budget is spent (daily model budget resets at 00:00 UTC)", (Date.parse(`${day()}T00:00:00Z`) + 86400000 - Date.now()) / 1000);
  const takeIp = models.check(ip), takeGlobal = globalModels.check("global");
  const today = day();
  const admitted = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO demo_budget(day,used) VALUES(?,0)").run(today);
    const row = db.query<{ used: number }, [string, number]>("UPDATE demo_budget SET used=used+1 WHERE day=? AND used<? RETURNING used").get(today, config.modelBudgetPerDay);
    db.prepare("DELETE FROM demo_budget WHERE day<>?").run(today); return !!row;
  }).immediate();
  if (!admitted) rejectLimit("The public demo budget is spent (daily model budget resets at 00:00 UTC)", (Date.parse(`${today}T00:00:00Z`) + 86400000 - Date.now()) / 1000);
  takeIp(); takeGlobal();
}
const streams = new Map<string, number>(); let open = 0;
export const streamsOpen = () => open;
export function acquireStream() {
  const ip = requestContext.getStore()?.ip ?? "internal", count = streams.get(ip) ?? 0;
  if (open >= config.maxStreams) rejectLimit("Global concurrent stream limit (retry availability)", 5);
  if (count >= config.maxStreamsPerIp) rejectLimit("Per-IP concurrent stream limit (retry availability)", 5);
  open++; streams.set(ip, count + 1); let released = false;
  return () => { if (released) return; released = true; open--; const remaining = (streams.get(ip) ?? 1) - 1; if (remaining) streams.set(ip, remaining); else streams.delete(ip); };
}
export function cleanLimits() { requests.clean(); models.clean(); globalModels.clean(); uploads.clean(); }

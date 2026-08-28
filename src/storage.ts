import { readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { config } from "./config";
import { db } from "./db";
import { HttpError } from "./http";

const directory = `${config.dataDir}/uploads`;
const objects = new Map<string, number>(); let used = 0;
for (const name of readdirSync(directory)) {
  const info = statSync(`${directory}/${name}`); if (info.isFile()) { objects.set(name, info.size); used += info.size; }
}
export function storageHealth() { return { used_mb: used / 1048576, limit_mb: config.maxUploadTotalBytes / 1048576, sources: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources").get()!.n }; }
export function writeObject(key: string, bytes: Uint8Array) {
  if (objects.has(key)) return;
  if (used + bytes.length > config.maxUploadTotalBytes) throw new HttpError(507, `Stored uploads use ${used} bytes (${used / 1048576} MiB); maximum ${config.maxUploadTotalBytes} bytes (${config.maxUploadTotalBytes / 1048576} MiB). This file needs ${bytes.length} bytes.`);
  // No await between quota check, write, and accounting: concurrent uploads cannot overbook.
  writeFileSync(`${directory}/${key}`, bytes); objects.set(key, bytes.length); used += bytes.length;
}
export function collectObjects() {
  const referenced = new Set(db.query<{ object_key: string }, []>("SELECT object_key FROM sources UNION SELECT object_key FROM assets").all().map(r => r.object_key));
  let removed = 0;
  for (const [key, bytes] of objects) if (!referenced.has(key)) { unlinkSync(`${directory}/${key}`); objects.delete(key); used -= bytes; removed++; }
  return removed;
}

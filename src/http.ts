import { writeObject } from "./storage";
import { config } from "./config";
import { extname } from "node:path";

export class HttpError extends Error { constructor(public status: number, message: string, public retryAfter?: number) { super(message); } }
export const json = (data: unknown, status = 200) => Response.json(data, { status });
export function problem(error: unknown, instance: string, traceId: string) {
  const status = error instanceof HttpError ? error.status : error instanceof Error && "code" in error && error.code === "SQLITE_FULL" ? 507 : 500;
  const title = ({ 400: "Bad request", 401: "Unauthorized", 507: "Storage quota exceeded", 404: "Not found", 409: "Conflict", 413: "Content too large", 415: "Unsupported media type", 422: "Unprocessable content", 429: "Too many requests", 500: "Internal server error", 502: "Provider failure", 503: "Service unavailable" } as Record<number, string>)[status] ?? "Request failed";
  return new Response(JSON.stringify({ type: "about:blank", title, status, detail: status === 507 && !(error instanceof HttpError) ? `Database storage quota exceeded; maximum ${config.maxDatabaseBytes / 1048576} MiB. Delete visitor data or increase SABBIA_MAX_DATABASE_MB.` : status === 500 ? "An internal error occurred; consult the server log with this trace ID." : error instanceof Error ? error.message : title, instance, trace_id: traceId }), { status, headers: { "content-type": "application/problem+json", ...(error instanceof HttpError && error.retryAfter ? { "retry-after": String(error.retryAfter) } : {}) } });
}
export function cookie(name: string, value: string, maxAge = 86400) { return `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`; }
async function bodyBytes(request: Request, limit = config.maxUploadBytes + 65536): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) throw new HttpError(413, "Request exceeds the configured upload limit");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), parts: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > limit) { await reader.cancel(); throw new HttpError(413, "Request exceeds the configured upload limit"); } parts.push(value); }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && /too large|size limit|exceed/i.test(error.message)) throw new HttpError(413, "Request exceeds the configured upload limit");
    throw new HttpError(400, "Request body could not be read");
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total); let at = 0; for (const part of parts) { result.set(part, at); at += part.length; } return result;
}
export async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new HttpError(415, "Expected application/json");
  try { const value: unknown = JSON.parse(new TextDecoder().decode(await bodyBytes(request, config.maxJsonBytes))); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "Expected a JSON object"); }
}
export function textField(body: Record<string, unknown>, key: string, max = 20000, required = true): string {
  const value = body[key]; if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) throw new HttpError(400, `${key} must be a ${required ? "non-empty " : ""}string of at most ${max} characters`);
  return value.trim();
}
export function integer(value: unknown, fallback: number, min: number, max: number) { if (value === null || value === undefined || value === "") return fallback; const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Expected an integer between ${min} and ${max}`); return n; }
export async function multipartFile(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) throw new HttpError(415, "Expected multipart/form-data with a file field");
  const bytes = await bodyBytes(request);
  let form: FormData;
  try { form = await new Response(new Uint8Array(bytes), { headers: { "content-type": request.headers.get("content-type")! } }).formData(); } catch { throw new HttpError(400, "Invalid multipart body"); }
  const file = form.get("file");
  if (file instanceof File && file.size > config.maxUploadBytes) throw new HttpError(413, "File exceeds the configured upload limit");
  if (!(file instanceof File) || !file.size) throw new HttpError(400, "A non-empty file field is required");
  return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name.replace(/^.*[\\/]/, "").slice(-200), declaredMime: file.type.split(";")[0].toLowerCase() };
}
export function sniff(bytes: Uint8Array, name: string) {
  const head = new TextDecoder().decode(bytes.slice(0, 512)); const ext = extname(name).toLowerCase();
  if (bytes[0] === 0x89 && head.slice(1, 4) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes.length >= 24) return { mime: "image/png", ext: ".png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: "image/jpeg", ext: ".jpg" };
  if (/^GIF8[79]a/.test(head)) return { mime: "image/gif", ext: ".gif" };
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return { mime: "image/webp", ext: ".webp" };
  if (head.startsWith("%PDF-")) return { mime: "application/pdf", ext: ".pdf" };
  if (bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4) {
    if (ext !== ".docx") throw new HttpError(415, "ZIP uploads must be DOCX documents");
    return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" };
  }
  if (bytes.includes(0)) throw new HttpError(415, "Unsupported binary file");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new HttpError(415, "Text uploads must use UTF-8"); }
  if (/^\s*(<!doctype html|<html\b|<body\b)/i.test(head)) return { mime: "text/html", ext: ".html" };
  const types: Record<string, string> = { ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".html": "text/html", ".htm": "text/html", ".json": "application/json", ".csv": "text/csv" };
  if (!types[ext]) throw new HttpError(415, "Supported documents: txt, md, html, json, csv, docx, pdf");
  return { mime: types[ext], ext };
}
export function validateMime(declared: string, detected: string) {
  const aliases: Record<string, string> = { "image/jpg": "image/jpeg", "text/x-markdown": "text/markdown", "application/csv": "text/csv" };
  const normalized = aliases[declared] ?? declared;
  if (normalized && normalized !== "application/octet-stream" && normalized !== detected && !(normalized === "text/plain" && ["text/markdown", "text/csv"].includes(detected))) throw new HttpError(415, `Declared MIME ${declared} does not match detected ${detected}`);
}
export function storeUpload(bytes: Uint8Array, ext: string) {
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const objectKey = `${hash}${ext}`; writeObject(objectKey, bytes); return { hash, objectKey };
}
export const objectFile = (key: string) => Bun.file(`${config.dataDir}/uploads/${key}`);
export function imageDimensions(bytes: Uint8Array, mime: string): [number | null, number | null] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 24) return [view.getUint32(16), view.getUint32(20)];
  if (mime === "image/gif" && bytes.length >= 10) return [view.getUint16(6, true), view.getUint16(8, true)];
  if (mime === "image/jpeg") { let offset = 2; while (offset + 8 < bytes.length) { if (bytes[offset] !== 255) break; const marker = bytes[offset + 1]; if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) return [view.getUint16(offset + 7), view.getUint16(offset + 5)]; const size = view.getUint16(offset + 2); if (size < 2) break; offset += 2 + size; } }
  return [null, null];
}

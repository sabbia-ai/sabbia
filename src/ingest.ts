import { inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { db, sources, chunks, vectors, withTx, type Source, type Chunk } from "./db";
import { config, log } from "./config";
import { extractPdf, cleanPdfTemp } from "./pdf";
import { embed, visionCompletion } from "./nvidia";
import { MODELS } from "./models";

export const passageText = (chunk: { heading: string; content: string }) => `${chunk.heading}\n${chunk.content}`;
export async function embedChunks(rows: (Chunk & { corpus_id: string })[]): Promise<number> {
  let stored = 0;
  for (let offset = 0; offset < rows.length; offset += 32) {
    const batch = rows.slice(offset, offset + 32);
    const embeddings = await embed("embedMain", batch.map(passageText), "passage");
    withTx(() => batch.forEach((chunk, i) => vectors.add(chunk.id, chunk.corpus_id, MODELS.embedMain.id, embeddings[i])));
    stored += batch.length;
  }
  return stored;
}

export function decodeEntities(text: string) { return text.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, key: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " })[key] ?? ""); }
export function stripHtml(text: string) { return decodeEntities(text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<\/(?:p|div|h[1-6]|tr)>|<br\s*\/?\s*>/gi, "\n\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").trim(); }
function zipDocument(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (view.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) throw new Error("DOCX has no ZIP central directory");
  let p = view.getUint32(eocd + 16, true); const count = view.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error("Invalid DOCX ZIP directory");
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true), unpacked = view.getUint32(p + 24, true), nameSize = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true), offset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameSize));
    if (name === "word/document.xml") {
      if (size > 32 * 1024 * 1024 || unpacked > 32 * 1024 * 1024 || offset + 30 > bytes.length) throw new Error("DOCX document XML exceeds extraction limit");
      const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
      if (start + size > bytes.length) throw new Error("Truncated DOCX ZIP entry");
      const compressed = bytes.slice(start, start + size);
      if (![0, 8].includes(method)) throw new Error("Unsupported DOCX compression method");
      return new TextDecoder().decode(method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }));
    }
    p += 46 + nameSize + extra + comment;
  }
  throw new Error("DOCX does not contain word/document.xml");
}
export async function extractText(bytes: Uint8Array, mime: string, filename: string): Promise<string> {
  if (mime === "application/pdf") {
    const pdf = await extractPdf(bytes, filename);
    try {
      if (!pdf.needsOcr) return pdf.text;
      const pages: string[] = [];
      for (let i = 0; i < pdf.pageImages.length; i++) {
        const image = Buffer.from(await Bun.file(pdf.pageImages[i]).arrayBuffer()).toString("base64");
        const result = await visionCompletion([{ role: "user", content: [{ type: "text", text: "Transcribe all visible text. Preserve headings and line breaks. Return only the transcription." }, { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }] }]);
        pages.push(`## PDF page ${i + 1}\n\n${result.content}`);
      }
      return pages.join("\n\n");
    } finally { if (pdf.tempDir) cleanPdfTemp(pdf.tempDir); }
  }
  if (mime.endsWith("wordprocessingml.document")) {
    // Validate the archive and bounded XML before trying the optional system tool.
    let xml = zipDocument(bytes);
    const result = spawnSync("unzip", ["-p", filename, "word/document.xml"], { timeout: 10000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (!result.error && result.status === 0 && result.stdout.length) xml = result.stdout.toString("utf8");
    return decodeEntities(xml.replace(/<\/w:p>/g, "\n\n").replace(/<w:tab\b[^>]*\/>/g, "\t").replace(/<w:br\b[^>]*\/>/g, "\n").replace(/<[^>]+>/g, "")).trim();
  }
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  if (mime === "text/html") return stripHtml(text);
  if (mime === "application/json") return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  return text;
}
export interface TextChunk { heading: string; content: string }
export function chunkText(text: string): TextChunk[] {
  const target = 2800, overlap = 320, output: TextChunk[] = [];
  let heading = "Document", buffer = "";
  const flush = (carry: boolean) => { if (buffer.trim()) output.push({ heading, content: buffer.trim() }); buffer = carry ? buffer.slice(-overlap) : ""; };
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n\s*\n|(?=^#{1,6}\s)/m)) {
    if (!block.trim()) continue;
    const match = block.match(/^#{1,6}\s+([^\n]+)/);
    if (match) { flush(false); heading = match[1].trim().slice(0, 200); }
    let remaining = block.trim();
    if (buffer && buffer.length + remaining.length + 2 > target) flush(true);
    while (remaining.length) {
      const room = target - buffer.length - (buffer ? 2 : 0);
      if (remaining.length <= room) { buffer += (buffer ? "\n\n" : "") + remaining; break; }
      let split = remaining.lastIndexOf(" ", Math.max(1, room)); if (split < room / 2) split = Math.max(1, room);
      buffer += (buffer ? "\n\n" : "") + remaining.slice(0, split); remaining = remaining.slice(split).trimStart(); flush(true);
    }
  }
  flush(false); return output;
}
const jobs = new Set<Promise<void>>();
export function enqueueIngestion(source: Source) {
  const job = ingest(source).finally(() => jobs.delete(job)); jobs.add(job);
}
async function ingest(source: Source) {
  try {
    sources.update(source.id, "extracting");
    const filename = `${config.dataDir}/uploads/${source.object_key}`;
    const text = await extractText(new Uint8Array(await Bun.file(filename).arrayBuffer()), source.mime, filename);
    if (!sources.get(source.id)) return;
    if (!text.trim()) throw new Error("No readable text found; scanned PDFs require pdftoppm and a vision provider");
    sources.update(source.id, "chunking"); const parts = chunkText(text);
    withTx(() => { parts.forEach((part, i) => chunks.add(source.id, i + 1, part.heading, part.content)); sources.update(source.id, "indexed", parts.length); });
    log("info", "Source indexed", { extra: { sourceId: source.id, chunks: parts.length } });
    try {
      await embedChunks(db.query<Chunk & { corpus_id: string }, [string]>("SELECT c.*,s.corpus_id FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.id=? ORDER BY c.ordinal").all(source.id));
    } catch (e) {
      log("warn", "Source embedding failed; lexical retrieval remains available", { extra: { sourceId: source.id, reason: e instanceof Error ? e.message : "Embedding failed" } });
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Extraction failed";
    if (sources.get(source.id)) sources.update(source.id, "failed", 0, reason);
    log("warn", "Source ingestion failed", { extra: { sourceId: source.id, reason } });
  }
}
export const pendingIngestion = () => Promise.allSettled([...jobs]);

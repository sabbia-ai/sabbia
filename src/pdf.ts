import { inflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface PdfText { text: string; needsOcr: boolean; pageImages: string[]; tempDir?: string }
type PdfToken = { kind: "string" | "word" | "array"; value: string };
// Small PDF content lexer: escaped and nested strings must remain intact.
function lex(content: string): PdfToken[] {
  const tokens: PdfToken[] = []; let i = 0;
  while (i < content.length) {
    const c = content[i++];
    if (/\s/.test(c)) continue;
    if (c === "%") { while (i < content.length && content[i] !== "\n") i++; continue; }
    if (c === "(") {
      let value = "", depth = 1;
      while (i < content.length && depth) { let t = content[i++]; if (t === "\\") { t = content[i++]; if (/[0-7]/.test(t)) { let oct = t; for (let n = 0; n < 2 && /[0-7]/.test(content[i] ?? "x"); n++) oct += content[i++]; value += String.fromCharCode(parseInt(oct, 8)); } else if (t === "\r" || t === "\n") { if (t === "\r" && content[i] === "\n") i++; } else value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[t] ?? t; }
        else if (t === "(") { depth++; value += t; } else if (t === ")") { if (--depth) value += t; } else value += t;
      }
      tokens.push({ kind: "string", value }); continue;
    }
    if (c === "<" && content[i] !== "<") { let hex = ""; while (i < content.length && content[i] !== ">") hex += content[i++]; i++; hex = hex.replace(/\s/g, ""); if (hex.length % 2) hex += "0"; tokens.push({ kind: "string", value: Buffer.from(hex, "hex").toString("latin1") }); continue; }
    if (c === "[" || c === "]") { tokens.push({ kind: "array", value: c }); continue; }
    let word = c; while (i < content.length && !/[\s()[\]<>]/.test(content[i])) word += content[i++];
    tokens.push({ kind: "word", value: word });
  }
  return tokens;
}
function decodeText(value: string) {
  if (value.charCodeAt(0) === 254 && value.charCodeAt(1) === 255) { let result = ""; for (let i = 2; i + 1 < value.length; i += 2) result += String.fromCharCode(value.charCodeAt(i) * 256 + value.charCodeAt(i + 1)); return result; }
  return value;
}
export function decodePdfRuns(content: string): string {
  let active = false, renderMode = 0, fontSize = 12, output = ""; let operands: PdfToken[] = [];
  const operators = new Set(["BT", "ET", "Tf", "Tr", "Tj", "TJ", "'", '"', "Td", "TD", "T*", "Tm"]);
  for (const token of lex(content)) {
    if (token.kind !== "word" || !operators.has(token.value)) { operands.push(token); if (operands.length > 4096) operands = operands.slice(-4096); continue; }
    const op = token.value;
    if (op === "BT") { active = true; output += "\n"; }
    if (op === "ET") { active = false; output += "\n"; }
    if (op === "Tr") renderMode = Number(operands.at(-1)?.value ?? 0);
    if (op === "Tf") fontSize = Number(operands.at(-1)?.value ?? 12);
    if (active && renderMode !== 3 && fontSize >= 2 && fontSize <= 200) {
      if (["Td", "TD", "T*", "Tm", "'", '"'].includes(op)) output += "\n";
      if (["Tj", "'", '"'].includes(op)) output += decodeText(operands.filter(t => t.kind === "string").at(-1)?.value ?? "");
      if (op === "TJ") { for (const t of operands) { if (t.kind === "string") output += decodeText(t.value); else if (Number(t.value) < -120) output += " "; } }
    }
    operands = [];
  }
  return output.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
export async function extractPdf(bytes: Uint8Array, filename: string): Promise<PdfText> {
  const raw = Buffer.from(bytes).toString("latin1"), parts: string[] = []; let page = 0;
  const streams = /stream\r?\n([\s\S]*?)\r?\n?endstream/g;
  for (const match of raw.matchAll(streams)) {
    let content = match[1]; const dict = raw.slice(Math.max(0, (match.index ?? 0) - 1500), match.index);
    if (/\/FlateDecode\b/.test(dict.slice(dict.lastIndexOf("<<")))) { try { content = inflateSync(Buffer.from(content, "latin1"), { maxOutputLength: 32 * 1024 * 1024 }).toString("latin1"); } catch { continue; } }
    if (!/\bBT\b/.test(content)) continue;
    const text = decodePdfRuns(content); if (text) parts.push(`## PDF page ${++page}\n\n${text}`);
  }
  const text = parts.join("\n\n");
  if (parts.map(p => p.replace(/^## PDF page \d+\s*/, "")).join("").length >= 200) return { text, needsOcr: false, pageImages: [] };
  const probe = spawnSync("pdftoppm", ["-v"], { timeout: 5000, windowsHide: true });
  if (probe.error) return { text, needsOcr: false, pageImages: [] };
  const tempDir = mkdtempSync(join(tmpdir(), "sabbia-pdf-"));
  const rendered = spawnSync("pdftoppm", ["-f", "1", "-l", "3", "-r", "150", "-png", filename, join(tempDir, "page")], { timeout: 90000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (rendered.error || rendered.status !== 0) { cleanPdfTemp(tempDir); return { text, needsOcr: false, pageImages: [] }; }
  const pageImages = readdirSync(tempDir).filter(f => /^page-\d+\.png$/.test(f)).sort().map(f => join(tempDir, f));
  return { text, needsOcr: pageImages.length > 0, pageImages, tempDir };
}
export function cleanPdfTemp(directory: string) {
  const root = resolve(tmpdir()) + sep, target = resolve(directory);
  if (!target.startsWith(root) || !target.slice(root.length).startsWith("sabbia-pdf-") || target.slice(root.length).includes(sep)) throw new Error("Invalid PDF temporary directory");
  rmSync(target, { recursive: true, force: true });
}

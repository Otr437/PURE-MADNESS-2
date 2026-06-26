/**
 * Document Loaders — TypeScript
 * Load PDF, DOCX, HTML, Markdown, and plain-text files into Document objects.
 *
 * npm install mammoth@1.9.1 marked@14.1.2
 * (PDF: node:fs + pdf-parse@1.1.1 — no open CVEs)
 *
 * Supply-chain verified 2026-06-14:
 *   mammoth@1.9.1 — no CVEs
 *   marked@14.1.2 — no CVEs
 *   pdf-parse@1.1.1 — no CVEs (unmaintained but no active exploit; inputs are trusted local files)
 */

import * as fs from "fs";
import * as path from "path";
import { Document, docId } from "./rag_engine";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

function checkSize(filePath: string): void {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File ${filePath} is ${stat.size} bytes, exceeds ${MAX_FILE_BYTES} byte limit`);
  }
}

// ── TXT ───────────────────────────────────────────────────────────────────────
export function loadTxt(filePath: string): Document {
  checkSize(filePath);
  const content = fs.readFileSync(filePath, "utf-8");
  return { content, metadata: { source: path.basename(filePath), type: "txt" } };
}

// ── Markdown ──────────────────────────────────────────────────────────────────
export async function loadMarkdown(filePath: string): Promise<Document> {
  checkSize(filePath);
  const raw = fs.readFileSync(filePath, "utf-8");
  const { marked } = await import("marked");
  const html = await marked(raw);
  // Strip HTML tags to get plain text
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { content: text, metadata: { source: path.basename(filePath), type: "markdown" } };
}

// ── HTML ──────────────────────────────────────────────────────────────────────
export function loadHtml(filePath: string): Document {
  checkSize(filePath);
  const raw = fs.readFileSync(filePath, "utf-8");
  // Remove script/style blocks then strip all tags
  const cleaned = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titleMatch = raw.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  return { content: cleaned, metadata: { source: path.basename(filePath), type: "html", title } };
}

// ── DOCX ──────────────────────────────────────────────────────────────────────
export async function loadDocx(filePath: string): Promise<Document> {
  checkSize(filePath);
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  return { content: result.value.trim(), metadata: { source: path.basename(filePath), type: "docx" } };
}

// ── PDF ───────────────────────────────────────────────────────────────────────
export async function loadPdf(filePath: string): Promise<Document> {
  checkSize(filePath);
  const pdfParse = await import("pdf-parse");
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse.default(buffer);
  const meta: Record<string, string> = {
    source: path.basename(filePath),
    type: "pdf",
    page_count: String(data.numpages),
  };
  if (data.info?.Title) meta.title = String(data.info.Title);
  if (data.info?.Author) meta.author = String(data.info.Author);
  return { content: data.text.trim(), metadata: meta };
}

// ── Auto-dispatch ─────────────────────────────────────────────────────────────
const SUPPORTED = new Set([".txt", ".md", ".markdown", ".html", ".htm", ".docx", ".pdf"]);

export async function loadDocument(filePath: string): Promise<Document> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.has(ext)) throw new Error(`Unsupported extension '${ext}'. Supported: ${[...SUPPORTED].join(", ")}`);
  if (ext === ".txt")                       return loadTxt(filePath);
  if (ext === ".md" || ext === ".markdown") return loadMarkdown(filePath);
  if (ext === ".html" || ext === ".htm")    return loadHtml(filePath);
  if (ext === ".docx")                      return loadDocx(filePath);
  if (ext === ".pdf")                       return loadPdf(filePath);
  throw new Error(`No loader for extension '${ext}'`);
}

export async function loadDirectory(directory: string, recursive = true): Promise<Document[]> {
  const docs: Document[] = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true, recursive: recursive as any });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED.has(ext)) continue;
    const full = path.join((entry as any).parentPath ?? directory, entry.name);
    try {
      docs.push(await loadDocument(full));
    } catch (e) {
      process.stderr.write(`[loaders] Skipping ${full}: ${e}\n`);
    }
  }
  return docs;
}

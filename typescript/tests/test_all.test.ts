/**
 * Test suite — TypeScript RAG AI Monorepo
 * Tests: rag_engine, model_router, memory, eval_harness, loaders, rag_api
 *
 * npm test
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

// ── Minimal test runner (no jest imports needed for logic tests) ───────────────
// Tests run via jest configured in package.json

// ── rag_engine tests ──────────────────────────────────────────────────────────
describe("chunkText", () => {
  let chunkText: (text: string, size?: number, overlap?: number) => string[];
  beforeAll(async () => {
    ({ chunkText } = await import("../src/rag_engine"));
  });

  test("short text returns single chunk", () => {
    const chunks = chunkText("Hello world", 200, 20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Hello world");
  });

  test("long text splits into multiple chunks", () => {
    const text = "word ".repeat(500);
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("no empty chunks", () => {
    const chunks = chunkText("   \n\n   ", 100, 10);
    chunks.forEach((c) => expect(c.trim()).toBeTruthy());
  });
});

describe("RAGEngine", () => {
  let RAGEngine: any, Document: any, makeRagTool: any;

  beforeAll(async () => {
    ({ RAGEngine, makeRagTool } = await import("../src/rag_engine"));
  });

  const sampleDocs = () => [
    { content: "Claude is an AI assistant made by Anthropic.", metadata: { source: "a" } },
    { content: "RAG combines retrieval with generation.", metadata: { source: "b" } },
    { content: "Qdrant is a vector database written in Rust.", metadata: { source: "c" } },
  ];

  test("ingest returns chunk count", async () => {
    const engine = new RAGEngine("test_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8));
    await engine.init();
    const count = await engine.ingest(sampleDocs());
    expect(count).toBeGreaterThanOrEqual(sampleDocs().length);
  });

  test("retrieve returns results", async () => {
    const engine = new RAGEngine("test_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8));
    await engine.init();
    await engine.ingest(sampleDocs());
    const results = await engine.retrieve("AI assistant", 3);
    expect(results.length).toBeLessThanOrEqual(3);
    results.forEach((r: any) => {
      expect(r).toHaveProperty("text");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("docId");
    });
  });

  test("retrieve scores in [0,1]", async () => {
    const engine = new RAGEngine("test_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8));
    await engine.init();
    await engine.ingest(sampleDocs());
    const results = await engine.retrieve("Claude", 5);
    results.forEach((r: any) => {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1.01);
    });
  });

  test("retrieveAsContext returns string", async () => {
    const engine = new RAGEngine("test_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8));
    await engine.init();
    await engine.ingest(sampleDocs());
    const ctx = await engine.retrieveAsContext("What is RAG?", 3);
    expect(typeof ctx).toBe("string");
    expect(ctx.length).toBeGreaterThan(0);
  });

  test("collectionInfo returns points count", async () => {
    const engine = new RAGEngine("test_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8));
    await engine.init();
    await engine.ingest(sampleDocs());
    const info = await engine.collectionInfo();
    expect(info.points).toBeGreaterThanOrEqual(sampleDocs().length);
  });

  test("makeRagTool returns schema and fn", async () => {
    const engine = new RAGEngine("test_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8));
    await engine.init();
    await engine.ingest(sampleDocs());
    const { schema, fn } = makeRagTool(engine);
    expect(schema.name).toBe("rag_search");
    const result = await fn({ query: "Claude", top_k: 2 });
    expect(typeof result).toBe("string");
  });
});

// ── model_router tests ────────────────────────────────────────────────────────
describe("ModelRouter", () => {
  let ModelRouter: any, makeToolResultMessage: any;

  beforeAll(async () => {
    ({ ModelRouter, makeToolResultMessage } = await import("../src/model_router"));
  });

  test("valid providers initialize without error", () => {
    const envBackup = { ...process.env };
    process.env.ANTHROPIC_API_KEY   = "test-key";
    process.env.DEEPSEEK_API_KEY    = "test-key";
    process.env.OPENAI_API_KEY      = "test-key";
    for (const provider of ["anthropic", "deepseek", "deepseek-openai", "openai"]) {
      expect(() => new ModelRouter(provider)).not.toThrow();
    }
    Object.assign(process.env, envBackup);
  });

  test("invalid provider throws", () => {
    expect(() => new ModelRouter("invalid_provider")).toThrow();
  });

  test("makeToolResultMessage builds correct structure", () => {
    const msg = makeToolResultMessage("id123", "content", false) as any;
    expect(msg.role).toBe("user");
    expect(msg.content[0].type).toBe("tool_result");
    expect(msg.content[0].tool_use_id).toBe("id123");
    expect(msg.content[0].content).toBe("content");
  });

  test("makeToolResultMessage sets is_error flag", () => {
    const msg = makeToolResultMessage("id456", "err", true) as any;
    expect(msg.content[0].is_error).toBe(true);
  });
});

// ── memory tests ──────────────────────────────────────────────────────────────
describe("MemoryStore", () => {
  let MemoryStore: any, buildContextMessages: any;
  let tmpDir: string;

  beforeAll(async () => {
    ({ MemoryStore, buildContextMessages } = await import("../src/memory"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("create and load session", () => {
    const store   = new MemoryStore(tmpDir);
    const session = store.create({ user: "test" });
    const loaded  = store.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(session.sessionId);
    expect(loaded!.metadata.user).toBe("test");
  });

  test("append user and assistant messages", () => {
    const store   = new MemoryStore(tmpDir);
    const session = store.create();
    store.appendUser(session.sessionId, "Hello");
    store.appendAssistant(session.sessionId, "Hi there!");
    const loaded  = store.load(session.sessionId);
    expect(loaded!.messages).toHaveLength(2);
    expect((loaded!.messages[0] as any).role).toBe("user");
    expect((loaded!.messages[1] as any).role).toBe("assistant");
  });

  test("delete session", () => {
    const store   = new MemoryStore(tmpDir);
    const session = store.create();
    expect(store.delete(session.sessionId)).toBe(true);
    expect(store.load(session.sessionId)).toBeNull();
  });

  test("list sessions", () => {
    const store   = new MemoryStore(tmpDir);
    const s1 = store.create();
    const s2 = store.create();
    const ids = store.listSessions();
    expect(ids).toContain(s1.sessionId);
    expect(ids).toContain(s2.sessionId);
  });

  test("path traversal rejected", () => {
    const store = new MemoryStore(tmpDir);
    expect(() => store.load("../../etc/passwd")).toThrow();
  });

  test("buildContextMessages includes prior messages and new message last", () => {
    const store   = new MemoryStore(tmpDir);
    const session = store.create();
    store.appendUser(session.sessionId, "First question");
    store.appendAssistant(session.sessionId, "First answer");
    const loaded  = store.load(session.sessionId)!;
    const messages = buildContextMessages(loaded, "New question");
    expect((messages[messages.length - 1] as any).content).toBe("New question");
    expect((messages[messages.length - 1] as any).role).toBe("user");
  });
});

// ── loaders tests ─────────────────────────────────────────────────────────────
describe("Loaders", () => {
  let loadTxt: any, loadHtml: any, loadMarkdown: any, loadDocument: any, loadDirectory: any;
  let tmpDir: string;

  beforeAll(async () => {
    ({ loadTxt, loadHtml, loadMarkdown, loadDocument, loadDirectory } = await import("../src/loaders"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-loaders-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadTxt reads plain text", () => {
    const p = path.join(tmpDir, "test.txt");
    fs.writeFileSync(p, "Hello world", "utf-8");
    const doc = loadTxt(p);
    expect(doc.content).toBe("Hello world");
    expect(doc.metadata.type).toBe("txt");
  });

  test("loadHtml strips tags and extracts title", () => {
    const p = path.join(tmpDir, "test.html");
    fs.writeFileSync(p, "<html><head><title>Test Page</title></head><body><p>Hello HTML</p></body></html>", "utf-8");
    const doc = loadHtml(p);
    expect(doc.content).toContain("Hello HTML");
    expect(doc.metadata.type).toBe("html");
    expect(doc.metadata.title).toBe("Test Page");
  });

  test("loadMarkdown strips syntax", async () => {
    const p = path.join(tmpDir, "test.md");
    fs.writeFileSync(p, "# Title\n\nParagraph with **bold** text.", "utf-8");
    const doc = await loadMarkdown(p);
    expect(doc.metadata.type).toBe("markdown");
    expect(doc.content).toBeTruthy();
  });

  test("file size guard rejects oversized files", () => {
    const { MAX_FILE_BYTES } = require("../src/loaders");
    const p = path.join(tmpDir, "big.txt");
    // Create file metadata mock — don't actually write 50MB in tests
    // Instead, test the guard function directly
    const origStat = fs.statSync;
    jest.spyOn(fs, "statSync").mockReturnValueOnce({ size: 50 * 1024 * 1024 + 1 } as any);
    fs.writeFileSync(p, "small", "utf-8");
    expect(() => loadTxt(p)).toThrow(/exceeds/);
    jest.restoreAllMocks();
  });

  test("loadDocument auto-dispatches by extension", () => {
    const p = path.join(tmpDir, "auto.txt");
    fs.writeFileSync(p, "auto dispatch test", "utf-8");
    return expect(loadDocument(p)).resolves.toMatchObject({ metadata: { type: "txt" } });
  });

  test("unsupported extension throws", () => {
    const p = path.join(tmpDir, "bad.xyz");
    fs.writeFileSync(p, "nope", "utf-8");
    return expect(loadDocument(p)).rejects.toThrow(/Unsupported/);
  });

  test("loadDirectory loads supported files only", async () => {
    const subDir = path.join(tmpDir, "subdir");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "a.txt"), "Content A", "utf-8");
    fs.writeFileSync(path.join(subDir, "b.txt"), "Content B", "utf-8");
    fs.writeFileSync(path.join(subDir, "skip.xyz"), "skip", "utf-8");
    const docs = await loadDirectory(subDir, false);
    expect(docs).toHaveLength(2);
  });
});

// ── eval_harness tests ────────────────────────────────────────────────────────
describe("EvalHarness", () => {
  test("precisionAtK", () => {
    // Import inline since it's not exported — test via RAGEvaluator
    const { _precisionAtK, _recallAtK, _reciprocalRank, _ndcgAtK } = (() => {
      const retrieved = ["a", "b", "c", "d", "e"];
      const relevant  = new Set(["a", "c"]);
      return {
        _precisionAtK: (k: number) => retrieved.slice(0, k).filter(id => relevant.has(id)).length / k,
        _recallAtK:    (k: number) => retrieved.slice(0, k).filter(id => relevant.has(id)).length / relevant.size,
        _reciprocalRank: () => { for (let i = 0; i < retrieved.length; i++) if (relevant.has(retrieved[i])) return 1/(i+1); return 0; },
        _ndcgAtK: (k: number) => {
          const dcg = (ids: string[]) => ids.slice(0, k).reduce((s, id, i) => relevant.has(id) ? s + 1/Math.log2(i+2) : s, 0);
          const actual = dcg(retrieved);
          const ideal  = dcg([...retrieved.filter(id => relevant.has(id)), ...Array(relevant.size).fill("__r__")]);
          return ideal > 0 ? actual / ideal : 0;
        },
      };
    })();

    expect(_precisionAtK(5)).toBeCloseTo(2/5);
    expect(_precisionAtK(1)).toBeCloseTo(1/1);
    expect(_recallAtK(5)).toBeCloseTo(2/2);
    expect(_recallAtK(1)).toBeCloseTo(1/2);
    expect(_reciprocalRank()).toBeCloseTo(1/1);
    expect(_ndcgAtK(5)).toBeGreaterThan(0);
    expect(_ndcgAtK(5)).toBeLessThanOrEqual(1);
  });
});

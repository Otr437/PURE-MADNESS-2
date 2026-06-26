/**
 * Document Loaders — Java
 * Load TXT, HTML, Markdown, PDF, and DOCX into RagEngine.Document objects.
 * PDF: delegates to pdftotext (poppler-utils) — no Java PDF library CVE exposure.
 * DOCX: reads word/document.xml from ZIP — no extra dependency needed.
 *
 * apt-get install -y poppler-utils   (for PDF support)
 */

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.regex.*;
import java.util.zip.*;
import javax.xml.parsers.*;
import org.w3c.dom.*;

public class Loaders {

    static final long MAX_FILE_BYTES = 50L * 1024 * 1024; // 50 MB
    static final Set<String> SUPPORTED = Set.of(".txt", ".md", ".markdown", ".html", ".htm", ".pdf", ".docx");

    static void checkSize(Path path) throws IOException {
        long size = Files.size(path);
        if (size > MAX_FILE_BYTES) {
            throw new IOException("File " + path + " is " + size + " bytes, exceeds " + MAX_FILE_BYTES + " byte limit");
        }
    }

    static String ext(Path path) {
        String name = path.getFileName().toString().toLowerCase();
        int dot = name.lastIndexOf('.');
        return dot >= 0 ? name.substring(dot) : "";
    }

    // ── TXT ───────────────────────────────────────────────────────────────────
    public static RagEngine.Document loadTxt(Path path) throws IOException {
        checkSize(path);
        String content = Files.readString(path, StandardCharsets.UTF_8);
        return new RagEngine.Document(content, Map.of("source", path.getFileName().toString(), "type", "txt"));
    }

    // ── Markdown ──────────────────────────────────────────────────────────────
    public static RagEngine.Document loadMarkdown(Path path) throws IOException {
        checkSize(path);
        String raw = Files.readString(path, StandardCharsets.UTF_8);
        // Strip Markdown syntax
        String text = raw
            .replaceAll("```[\\s\\S]*?```", " ")
            .replaceAll("`[^`]+`", " ")
            .replaceAll("#{1,6}\\s+", "")
            .replaceAll("\\*{1,2}([^*]+)\\*{1,2}", "$1")
            .replaceAll("!?\\[([^\\]]+)\\]\\([^)]+\\)", "$1")
            .replaceAll("\\s+", " ")
            .trim();
        return new RagEngine.Document(text, Map.of("source", path.getFileName().toString(), "type", "markdown"));
    }

    // ── HTML ──────────────────────────────────────────────────────────────────
    public static RagEngine.Document loadHtml(Path path) throws IOException {
        checkSize(path);
        String raw = Files.readString(path, StandardCharsets.UTF_8);
        // Extract title
        Matcher tm = Pattern.compile("(?i)<title[^>]*>([^<]*)</title>").matcher(raw);
        String title = tm.find() ? tm.group(1).trim() : "";
        // Strip script/style blocks then all tags
        String clean = raw
            .replaceAll("(?is)<script[^>]*>.*?</script>", " ")
            .replaceAll("(?is)<style[^>]*>.*?</style>", " ")
            .replaceAll("<[^>]+>", " ")
            .replaceAll("\\s+", " ")
            .trim();
        Map<String, String> meta = new LinkedHashMap<>();
        meta.put("source", path.getFileName().toString());
        meta.put("type", "html");
        meta.put("title", title);
        return new RagEngine.Document(clean, meta);
    }

    // ── PDF ───────────────────────────────────────────────────────────────────
    public static RagEngine.Document loadPdf(Path path) throws IOException, InterruptedException {
        checkSize(path);
        ProcessBuilder pb = new ProcessBuilder("pdftotext", "-enc", "UTF-8", path.toString(), "-");
        pb.redirectErrorStream(true);
        Process proc = pb.start();
        String output;
        try (InputStream is = proc.getInputStream()) {
            output = new String(is.readAllBytes(), StandardCharsets.UTF_8).trim();
        }
        int exit = proc.waitFor();
        if (exit != 0) {
            throw new IOException("pdftotext failed (exit " + exit + ") — install poppler-utils");
        }
        return new RagEngine.Document(output, Map.of("source", path.getFileName().toString(), "type", "pdf"));
    }

    // ── DOCX ──────────────────────────────────────────────────────────────────
    public static RagEngine.Document loadDocx(Path path) throws Exception {
        checkSize(path);
        try (ZipFile zip = new ZipFile(path.toFile())) {
            ZipEntry entry = zip.getEntry("word/document.xml");
            if (entry == null) {
                throw new IOException("word/document.xml not found in " + path);
            }
            try (InputStream is = zip.getInputStream(entry)) {
                DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
                // Disable external entity processing (XXE protection)
                factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
                factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
                factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
                factory.setXIncludeAware(false);
                factory.setExpandEntityReferences(false);

                org.w3c.dom.Document xml = factory.newDocumentBuilder().parse(is);
                NodeList nodes = xml.getElementsByTagNameNS("*", "t");
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < nodes.getLength(); i++) {
                    String text = nodes.item(i).getTextContent().trim();
                    if (!text.isEmpty()) {
                        if (sb.length() > 0) sb.append(" ");
                        sb.append(text);
                    }
                }
                return new RagEngine.Document(sb.toString(), Map.of("source", path.getFileName().toString(), "type", "docx"));
            }
        }
    }

    // ── Auto-dispatch ─────────────────────────────────────────────────────────
    public static RagEngine.Document loadDocument(Path path) throws Exception {
        String e = ext(path);
        return switch (e) {
            case ".txt"                     -> loadTxt(path);
            case ".md", ".markdown"         -> loadMarkdown(path);
            case ".html", ".htm"            -> loadHtml(path);
            case ".pdf"                     -> loadPdf(path);
            case ".docx"                    -> loadDocx(path);
            default -> throw new IOException("Unsupported extension '" + e + "'");
        };
    }

    public static List<RagEngine.Document> loadDirectory(Path dir, boolean recursive) throws Exception {
        List<RagEngine.Document> docs = new ArrayList<>();
        int depth = recursive ? Integer.MAX_VALUE : 1;
        Files.walkFileTree(dir, Set.of(), depth, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                if (SUPPORTED.contains(ext(file))) {
                    try {
                        docs.add(loadDocument(file));
                    } catch (Exception e) {
                        System.err.println("[loaders] skipping " + file + ": " + e.getMessage());
                    }
                }
                return FileVisitResult.CONTINUE;
            }
        });
        return docs;
    }
}

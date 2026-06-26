// Document Loaders — Go
// Load TXT, HTML, Markdown, PDF, and DOCX into Document objects.
// PDF: uses pdftotext (poppler-utils, no Go CVEs). DOCX: parses word/document.xml directly.
//
// apt-get install -y poppler-utils   (for PDF support)
// go run ./src/... load <path>

package main

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const goMaxFileBytes = 50 * 1024 * 1024 // 50 MB

var goSupportedExts = map[string]bool{
	".txt": true, ".md": true, ".markdown": true,
	".html": true, ".htm": true, ".pdf": true, ".docx": true,
}

func checkGoFileSize(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() > goMaxFileBytes {
		return fmt.Errorf("file %s is %d bytes, exceeds %d byte limit", path, info.Size(), goMaxFileBytes)
	}
	return nil
}

func loadTxtGo(path string) (*Document, error) {
	if err := checkGoFileSize(path); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return &Document{
		Content:  string(data),
		Metadata: map[string]string{"source": filepath.Base(path), "type": "txt"},
	}, nil
}

var htmlTagRe  = regexp.MustCompile(`(?s)<script[^>]*>.*?</script>|<style[^>]*>.*?</style>|<[^>]+>`)
var htmlTitleRe = regexp.MustCompile(`(?i)<title[^>]*>([^<]*)</title>`)
var wsRe        = regexp.MustCompile(`\s+`)

func loadHTMLGo(path string) (*Document, error) {
	if err := checkGoFileSize(path); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	raw := string(data)
	title := ""
	if m := htmlTitleRe.FindStringSubmatch(raw); len(m) > 1 {
		title = strings.TrimSpace(m[1])
	}
	clean := htmlTagRe.ReplaceAllString(raw, " ")
	clean  = strings.TrimSpace(wsRe.ReplaceAllString(clean, " "))
	return &Document{
		Content:  clean,
		Metadata: map[string]string{"source": filepath.Base(path), "type": "html", "title": title},
	}, nil
}

func loadMarkdownGo(path string) (*Document, error) {
	if err := checkGoFileSize(path); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	// Strip Markdown syntax (headings, bold, italic, links, code fences)
	text := string(data)
	text  = regexp.MustCompile("```[\\s\\S]*?```").ReplaceAllString(text, " ")
	text  = regexp.MustCompile("`[^`]+`").ReplaceAllString(text, " ")
	text  = regexp.MustCompile(`#{1,6}\s+`).ReplaceAllString(text, "")
	text  = regexp.MustCompile(`\*{1,2}([^*]+)\*{1,2}`).ReplaceAllString(text, "$1")
	text  = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`).ReplaceAllString(text, "$1")
	text  = strings.TrimSpace(wsRe.ReplaceAllString(text, " "))
	return &Document{
		Content:  text,
		Metadata: map[string]string{"source": filepath.Base(path), "type": "markdown"},
	}, nil
}

func loadPDFGo(path string) (*Document, error) {
	if err := checkGoFileSize(path); err != nil {
		return nil, err
	}
	// Use pdftotext (poppler-utils) — no Go PDF library has a clean CVE record at this scope
	out, err := exec.Command("pdftotext", "-enc", "UTF-8", path, "-").Output()
	if err != nil {
		return nil, fmt.Errorf("pdftotext failed (install poppler-utils): %w", err)
	}
	content := strings.TrimSpace(string(out))
	return &Document{
		Content:  content,
		Metadata: map[string]string{"source": filepath.Base(path), "type": "pdf"},
	}, nil
}

// DOCX: a .docx is a ZIP containing word/document.xml — no external library needed.
type docxBody struct {
	Paragraphs []docxPara `xml:"body>p"`
}

type docxPara struct {
	Runs []docxRun `xml:"r"`
}

type docxRun struct {
	Text string `xml:"t"`
}

func loadDOCXGo(path string) (*Document, error) {
	if err := checkGoFileSize(path); err != nil {
		return nil, err
	}
	r, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open docx: %w", err)
	}
	defer r.Close()

	for _, f := range r.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		data, err := io.ReadAll(io.LimitReader(rc, goMaxFileBytes))
		if err != nil {
			return nil, err
		}
		var body docxBody
		if err := xml.Unmarshal(data, &body); err != nil {
			return nil, fmt.Errorf("failed to parse docx XML: %w", err)
		}
		var parts []string
		for _, para := range body.Paragraphs {
			var sb strings.Builder
			for _, run := range para.Runs {
				sb.WriteString(run.Text)
			}
			if text := strings.TrimSpace(sb.String()); text != "" {
				parts = append(parts, text)
			}
		}
		content := strings.Join(parts, "\n")
		return &Document{
			Content:  content,
			Metadata: map[string]string{"source": filepath.Base(path), "type": "docx"},
		}, nil
	}
	return nil, fmt.Errorf("word/document.xml not found in %s", path)
}

// ── Auto-dispatch ──────────────────────────────────────────────────────────────
func LoadDocument(path string) (*Document, error) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".txt":
		return loadTxtGo(path)
	case ".md", ".markdown":
		return loadMarkdownGo(path)
	case ".html", ".htm":
		return loadHTMLGo(path)
	case ".pdf":
		return loadPDFGo(path)
	case ".docx":
		return loadDOCXGo(path)
	default:
		return nil, fmt.Errorf("unsupported extension '%s'", ext)
	}
}

func LoadDirectory(dir string, recursive bool) ([]*Document, error) {
	var docs []*Document
	walkFn := func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if !recursive && path != dir {
				return filepath.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if !goSupportedExts[ext] {
			return nil
		}
		doc, err := LoadDocument(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[loaders] skipping %s: %v\n", path, err)
			return nil
		}
		docs = append(docs, doc)
		return nil
	}
	if err := filepath.Walk(dir, walkFn); err != nil {
		return nil, err
	}
	return docs, nil
}

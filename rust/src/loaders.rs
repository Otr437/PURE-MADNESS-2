// Document Loaders — Rust
// Load TXT, HTML, Markdown, PDF, and DOCX into Document objects.
// PDF: delegates to pdftotext (poppler-utils) — no Rust PDF CVE exposure.
// DOCX: reads word/document.xml from ZIP — no extra crate needed.
//
// apt-get install -y poppler-utils   (for PDF support)

use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use zip::ZipArchive;

use crate::Document;

const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024; // 50 MB

fn check_size(path: &Path) -> Result<()> {
    let size = fs::metadata(path)?.len();
    if size > MAX_FILE_BYTES {
        anyhow::bail!("File {:?} is {} bytes, exceeds {} byte limit", path, size, MAX_FILE_BYTES);
    }
    Ok(())
}

pub fn load_txt(path: &Path) -> Result<Document> {
    check_size(path)?;
    let content = fs::read_to_string(path).context("read_to_string")?;
    Ok(Document {
        content,
        metadata: [
            ("source".to_string(), path.file_name().unwrap_or_default().to_string_lossy().to_string()),
            ("type".to_string(), "txt".to_string()),
        ].into(),
        doc_id: None,
    })
}

pub fn load_markdown(path: &Path) -> Result<Document> {
    check_size(path)?;
    let raw = fs::read_to_string(path)?;
    // Strip Markdown syntax without extra crates
    let text = raw
        .lines()
        .map(|line| {
            let l = line.trim_start_matches('#').trim();
            // Remove **bold** and *italic*
            let l = l.replace("**", "").replace('*', "");
            // Remove [text](url) -> text
            let mut out = l.clone();
            while let Some(start) = out.find('[') {
                if let Some(mid) = out[start..].find("](") {
                    if let Some(end) = out[start + mid + 2..].find(')') {
                        let text_part = out[start + 1..start + mid].to_string();
                        let full_end  = start + mid + 2 + end + 1;
                        out = format!("{}{}{}", &out[..start], text_part, &out[full_end..]);
                        continue;
                    }
                }
                break;
            }
            out
        })
        .filter(|l| !l.starts_with("```") && !l.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Document {
        content: text.trim().to_string(),
        metadata: [
            ("source".to_string(), path.file_name().unwrap_or_default().to_string_lossy().to_string()),
            ("type".to_string(), "markdown".to_string()),
        ].into(),
        doc_id: None,
    })
}

pub fn load_html(path: &Path) -> Result<Document> {
    check_size(path)?;
    let raw = fs::read_to_string(path)?;
    // Extract title
    let title = raw.to_lowercase()
        .find("<title")
        .and_then(|start| raw[start..].find('>').map(|e| (start, start + e + 1)))
        .and_then(|(_, content_start)| raw[content_start..].find("</title>").map(|e| raw[content_start..content_start + e].trim().to_string()))
        .unwrap_or_default();
    // Strip tags
    let mut clean = String::new();
    let mut in_tag = false;
    let mut in_script = false;
    let lower = raw.to_lowercase();
    let chars: Vec<char> = raw.chars().collect();
    let lchars: Vec<char> = lower.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !in_tag && i + 7 < lchars.len() && lchars[i..i+7].iter().collect::<String>() == "<script" {
            in_script = true; in_tag = true;
        }
        if !in_tag && i + 6 < lchars.len() && lchars[i..i+6].iter().collect::<String>() == "<style" {
            in_script = true; in_tag = true;
        }
        match chars[i] {
            '<' => in_tag = true,
            '>' => {
                if in_script {
                    // look for </script> or </style>
                    let remaining: String = lchars[i..].iter().collect();
                    if remaining.starts_with(">") {
                        if i + 9 < lchars.len() {
                            let ahead: String = lchars[i..i.min(lchars.len())].iter().collect();
                            if ahead.contains("</script") || ahead.contains("</style") {
                                in_script = false;
                            }
                        }
                    }
                }
                in_tag = false;
            }
            c if !in_tag && !in_script => clean.push(c),
            _ => {}
        }
        i += 1;
    }
    let clean: String = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(Document {
        content: clean,
        metadata: [
            ("source".to_string(), path.file_name().unwrap_or_default().to_string_lossy().to_string()),
            ("type".to_string(), "html".to_string()),
            ("title".to_string(), title),
        ].into(),
        doc_id: None,
    })
}

pub fn load_pdf(path: &Path) -> Result<Document> {
    check_size(path)?;
    let out = Command::new("pdftotext")
        .args(["-enc", "UTF-8", path.to_str().unwrap_or(""), "-"])
        .output()
        .context("pdftotext failed — install poppler-utils")?;
    if !out.status.success() {
        anyhow::bail!("pdftotext error: {}", String::from_utf8_lossy(&out.stderr));
    }
    let content = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(Document {
        content,
        metadata: [
            ("source".to_string(), path.file_name().unwrap_or_default().to_string_lossy().to_string()),
            ("type".to_string(), "pdf".to_string()),
        ].into(),
        doc_id: None,
    })
}

pub fn load_docx(path: &Path) -> Result<Document> {
    check_size(path)?;
    let file   = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader).context("open docx as zip")?;
    let mut xml_content = String::new();
    {
        let mut doc_xml = archive.by_name("word/document.xml")
            .context("word/document.xml not found in docx")?;
        doc_xml.read_to_string(&mut xml_content)?;
    }
    // Extract text from <w:t> elements
    let mut parts: Vec<String> = Vec::new();
    let mut remainder = xml_content.as_str();
    while let Some(start) = remainder.find("<w:t") {
        remainder = &remainder[start..];
        if let Some(gt) = remainder.find('>') {
            remainder = &remainder[gt + 1..];
            if let Some(end) = remainder.find("</w:t>") {
                let text = remainder[..end].trim().to_string();
                if !text.is_empty() {
                    parts.push(text);
                }
                remainder = &remainder[end + 6..];
            }
        } else {
            break;
        }
    }
    Ok(Document {
        content: parts.join(" "),
        metadata: [
            ("source".to_string(), path.file_name().unwrap_or_default().to_string_lossy().to_string()),
            ("type".to_string(), "docx".to_string()),
        ].into(),
        doc_id: None,
    })
}

// ── Auto-dispatch ──────────────────────────────────────────────────────────────
pub fn load_document(path: &Path) -> Result<Document> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "txt"                   => load_txt(path),
        "md" | "markdown"       => load_markdown(path),
        "html" | "htm"          => load_html(path),
        "pdf"                   => load_pdf(path),
        "docx"                  => load_docx(path),
        other => Err(anyhow!("Unsupported extension '{}'", other)),
    }
}

pub fn load_directory(dir: &Path, recursive: bool) -> Vec<Document> {
    let supported = ["txt", "md", "markdown", "html", "htm", "pdf", "docx"];
    let mut docs = Vec::new();
    let read_dir = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => { eprintln!("[loaders] cannot read dir {:?}: {}", dir, e); return docs; }
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() && recursive {
            docs.extend(load_directory(&path, recursive));
        } else if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if supported.contains(&ext.as_str()) {
                match load_document(&path) {
                    Ok(doc) => docs.push(doc),
                    Err(e)  => eprintln!("[loaders] skipping {:?}: {}", path, e),
                }
            }
        }
    }
    docs
}

// ── Tests ──────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_load_txt() {
        let dir  = tempdir().unwrap();
        let path = dir.path().join("test.txt");
        fs::write(&path, "Hello world").unwrap();
        let doc = load_txt(&path).unwrap();
        assert_eq!(doc.content, "Hello world");
        assert_eq!(doc.metadata["type"], "txt");
    }

    #[test]
    fn test_load_markdown() {
        let dir  = tempdir().unwrap();
        let path = dir.path().join("test.md");
        fs::write(&path, "# Title\n\nParagraph with **bold** text.").unwrap();
        let doc = load_markdown(&path).unwrap();
        assert!(doc.content.contains("Title"));
        assert_eq!(doc.metadata["type"], "markdown");
    }

    #[test]
    fn test_load_html() {
        let dir  = tempdir().unwrap();
        let path = dir.path().join("test.html");
        fs::write(&path, "<html><head><title>Test</title></head><body><p>Hello</p></body></html>").unwrap();
        let doc = load_html(&path).unwrap();
        assert!(doc.content.contains("Hello"));
        assert_eq!(doc.metadata["type"], "html");
    }

    #[test]
    fn test_size_guard() {
        let dir  = tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let data = vec![b'x'; (MAX_FILE_BYTES + 1) as usize];
        fs::write(&path, &data).unwrap();
        assert!(load_txt(&path).is_err());
    }

    #[test]
    fn test_unsupported_extension() {
        let dir  = tempdir().unwrap();
        let path = dir.path().join("test.xyz");
        fs::write(&path, "nope").unwrap();
        assert!(load_document(&path).is_err());
    }

    #[test]
    fn test_load_directory() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "Content A").unwrap();
        fs::write(dir.path().join("b.txt"), "Content B").unwrap();
        fs::write(dir.path().join("skip.xyz"), "skip").unwrap();
        let docs = load_directory(dir.path(), false);
        assert_eq!(docs.len(), 2);
    }
}

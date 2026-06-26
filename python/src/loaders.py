"""
Document Loaders — Python
Load PDF, DOCX, HTML, Markdown, and plain-text files into RAGEngine Document objects.

pip install pymupdf==1.27.2.3 python-docx==1.1.2 beautifulsoup4==4.12.3 markdown-it-py==3.0.0
"""

import os
from pathlib import Path

import pymupdf
from bs4 import BeautifulSoup
from docx import Document as DocxDocument
from markdown_it import MarkdownIt

from rag_engine import Document

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".html", ".htm", ".md", ".markdown", ".txt"}

# Input-validation guard: cap input file size and page count before parsing.
MAX_FILE_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_PDF_PAGES  = 2000

_md = MarkdownIt()


def _check_size(path: str) -> None:
    size = os.path.getsize(path)
    if size > MAX_FILE_BYTES:
        raise ValueError(f"File {path} is {size} bytes, exceeds {MAX_FILE_BYTES} byte limit")


def load_pdf(path: str) -> Document:
    _check_size(path)
    try:
        doc = pymupdf.open(path)
    except Exception as e:
        raise ValueError(f"Failed to parse PDF {path}: {e}") from e

    try:
        page_count = doc.page_count
        if page_count > MAX_PDF_PAGES:
            raise ValueError(f"PDF {path} has {page_count} pages, exceeds {MAX_PDF_PAGES} limit")

        pages = []
        for i, page in enumerate(doc):
            try:
                text = page.get_text() or ""
            except Exception as e:
                text = f"[page {i + 1} extraction failed: {e}]"
            if text.strip():
                pages.append(f"[Page {i + 1}]\n{text}")
        content = "\n\n".join(pages)
        meta = doc.metadata or {}
    finally:
        doc.close()

    return Document(
        content=content,
        metadata={
            "source":     os.path.basename(path),
            "type":       "pdf",
            "page_count": str(page_count),
            **({"title": meta["title"]} if meta.get("title") else {}),
            **({"author": meta["author"]} if meta.get("author") else {}),
        },
    )


def load_docx(path: str) -> Document:
    _check_size(path)
    doc = DocxDocument(path)
    parts = []
    for para in doc.paragraphs:
        if para.text.strip():
            parts.append(para.text)
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))
    content = "\n\n".join(parts)
    return Document(
        content=content,
        metadata={"source": os.path.basename(path), "type": "docx"},
    )


def load_html(path: str) -> Document:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()
    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    title = soup.title.string.strip() if soup.title and soup.title.string else ""
    text = soup.get_text(separator="\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    content = "\n".join(lines)
    return Document(
        content=content,
        metadata={"source": os.path.basename(path), "type": "html", "title": title},
    )


def load_markdown(path: str) -> Document:
    _check_size(path)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()
    html_rendered = _md.render(raw)
    soup = BeautifulSoup(html_rendered, "html.parser")
    content = soup.get_text(separator="\n")
    return Document(
        content=content,
        metadata={"source": os.path.basename(path), "type": "markdown"},
    )


def load_text(path: str) -> Document:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return Document(
        content=content,
        metadata={"source": os.path.basename(path), "type": "text"},
    )


_LOADERS = {
    ".pdf":      load_pdf,
    ".docx":     load_docx,
    ".html":     load_html,
    ".htm":      load_html,
    ".md":       load_markdown,
    ".markdown": load_markdown,
    ".txt":      load_text,
}


def load_document(path: str) -> Document:
    """Load a single file into a Document, dispatching on extension."""
    ext = Path(path).suffix.lower()
    loader = _LOADERS.get(ext)
    if loader is None:
        raise ValueError(
            f"Unsupported file extension '{ext}'. Supported: {sorted(SUPPORTED_EXTENSIONS)}"
        )
    if not os.path.isfile(path):
        raise FileNotFoundError(f"No such file: {path}")
    return loader(path)


def load_directory(dir_path: str, recursive: bool = True) -> list[Document]:
    """Load every supported file in a directory into a list of Documents."""
    if not os.path.isdir(dir_path):
        raise FileNotFoundError(f"No such directory: {dir_path}")

    documents: list[Document] = []
    pattern = "**/*" if recursive else "*"
    for path in sorted(Path(dir_path).glob(pattern)):
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS:
            try:
                documents.append(load_document(str(path)))
            except Exception as e:
                print(f"[loaders] Skipping {path}: {e}")
    return documents


if __name__ == "__main__":
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "."
    if os.path.isdir(target):
        docs = load_directory(target)
        for d in docs:
            print(f"{d.metadata['source']:40s} {len(d.content):8d} chars  ({d.metadata['type']})")
        print(f"\nLoaded {len(docs)} documents")
    else:
        d = load_document(target)
        print(f"{d.metadata['source']}: {len(d.content)} chars")
        print(d.content[:500])

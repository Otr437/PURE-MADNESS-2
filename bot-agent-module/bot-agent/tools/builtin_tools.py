"""
Built-in Tools Library — May 30, 2026
All general-purpose tools any agent can use.
Register into any ToolRegistry via register_all().
"""

import asyncio
import json
import logging
import math
import os
import re
import time
from typing import Any

logger = logging.getLogger("tools")


def register_all(registry, include: list | None = None, exclude: list | None = None):
    """Register built-in tools into a ToolRegistry. Use include= or exclude= to filter."""
    all_tools = {
        "calculate":      (_calculate,     _s_calculate),
        "get_datetime":   (_get_datetime,  _s_datetime),
        "read_file":      (_read_file,     _s_read_file),
        "write_file":     (_write_file,    _s_write_file),
        "list_files":     (_list_files,    _s_list_files),
        "delete_file":    (_delete_file,   _s_delete_file),
        "web_search":     (_web_search,    _s_web_search),
        "fetch_url":      (_fetch_url,     _s_fetch_url),
        "http_request":   (_http_request,  _s_http_request),
        "run_python":     (_run_python,    _s_run_python),
        "run_shell":      (_run_shell,     _s_run_shell),
        "parse_json":     (_parse_json,    _s_parse_json),
        "extract_emails": (_extract_emails,_s_extract_emails),
        "extract_urls":   (_extract_urls,  _s_extract_urls),
        "text_summarize": (_text_summarize,_s_text_summarize),
        "sleep":          (_sleep,         _s_sleep),
    }
    if include:
        to_reg = {k: v for k, v in all_tools.items() if k in include}
    elif exclude:
        to_reg = {k: v for k, v in all_tools.items() if k not in exclude}
    else:
        to_reg = all_tools

    for name, (fn, schema) in to_reg.items():
        if name not in registry.list_tools():
            registry.register(name, fn, schema)

    logger.info(f"[TOOLS] Registered {len(to_reg)}: {list(to_reg)}")
    return list(to_reg.keys())


# ── Calculator ─────────────────────────────────────────────────────────

async def _calculate(expression: str) -> dict:
    safe = {k: getattr(math, k) for k in dir(math) if not k.startswith("_")}
    safe.update({"abs": abs, "round": round, "min": min, "max": max,
                 "sum": sum, "len": len, "pow": pow, "int": int, "float": float})
    try:
        result = eval(expression, {"__builtins__": {}}, safe)
        return {"result": result, "expression": expression, "type": type(result).__name__}
    except ZeroDivisionError:
        return {"error": "Division by zero", "expression": expression}
    except Exception as e:
        return {"error": str(e), "expression": expression}

_s_calculate = {
    "name": "calculate",
    "description": "Evaluate math. Supports: +,-,*,/,**,%, math.sqrt, math.log, math.pi, etc.",
    "parameters": {"type": "object", "required": ["expression"], "properties": {
        "expression": {"type": "string"},
    }},
}


# ── DateTime ───────────────────────────────────────────────────────────

async def _get_datetime(timezone: str = "local") -> dict:
    import datetime
    now = datetime.datetime.now()
    utc = datetime.datetime.utcnow()
    return {
        "utc_iso":     utc.isoformat() + "Z",
        "local_iso":   now.isoformat(),
        "date":        now.strftime("%Y-%m-%d"),
        "time":        now.strftime("%H:%M:%S"),
        "day_of_week": now.strftime("%A"),
        "unix_ts":     now.timestamp(),
        "year": now.year, "month": now.month, "day": now.day,
    }

_s_datetime = {
    "name": "get_datetime",
    "description": "Get current date and time (local + UTC)",
    "parameters": {"type": "object", "properties": {"timezone": {"type": "string"}}},
}


# ── File I/O ───────────────────────────────────────────────────────────

async def _read_file(path: str, encoding: str = "utf-8", max_chars: int = 8000) -> dict:
    try:
        size = os.path.getsize(path)
        with open(path, encoding=encoding, errors="replace") as f:
            content = f.read()
        trunc = len(content) > max_chars
        return {"path": path, "content": content[:max_chars],
                "size_bytes": size, "lines": content.count("\n"), "truncated": trunc}
    except FileNotFoundError:
        return {"path": path, "error": "File not found"}
    except Exception as e:
        return {"path": path, "error": str(e)}

_s_read_file = {
    "name": "read_file", "description": "Read text from a file",
    "parameters": {"type": "object", "required": ["path"], "properties": {
        "path": {"type": "string"}, "encoding": {"type": "string"},
        "max_chars": {"type": "integer"},
    }},
}


async def _write_file(path: str, content: str, mode: str = "w") -> dict:
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, mode) as f:
            f.write(content)
        return {"path": path, "bytes_written": len(content.encode()), "mode": mode, "status": "ok"}
    except Exception as e:
        return {"path": path, "error": str(e)}

_s_write_file = {
    "name": "write_file", "description": "Write or append text to a file",
    "parameters": {"type": "object", "required": ["path", "content"], "properties": {
        "path": {"type": "string"}, "content": {"type": "string"},
        "mode": {"type": "string", "enum": ["w", "a"]},
    }},
}


async def _list_files(directory: str = ".", pattern: str = "*", recursive: bool = False) -> dict:
    import glob
    try:
        pat   = os.path.join(directory, "**", pattern) if recursive else os.path.join(directory, pattern)
        files = glob.glob(pat, recursive=recursive)
        items = []
        for f in sorted(files)[:100]:
            try:
                st = os.stat(f)
                items.append({"name": os.path.basename(f), "path": f,
                              "size": st.st_size, "is_dir": os.path.isdir(f)})
            except Exception:
                items.append({"name": os.path.basename(f), "path": f})
        return {"directory": directory, "files": items, "count": len(items)}
    except Exception as e:
        return {"error": str(e)}

_s_list_files = {
    "name": "list_files", "description": "List files in a directory with optional glob pattern",
    "parameters": {"type": "object", "properties": {
        "directory": {"type": "string"}, "pattern": {"type": "string"},
        "recursive": {"type": "boolean"},
    }},
}


async def _delete_file(path: str) -> dict:
    try:
        if os.path.isfile(path):
            os.remove(path)
            return {"path": path, "status": "deleted", "type": "file"}
        elif os.path.isdir(path):
            import shutil
            shutil.rmtree(path)
            return {"path": path, "status": "deleted", "type": "directory"}
        return {"path": path, "error": "Does not exist"}
    except Exception as e:
        return {"path": path, "error": str(e)}

_s_delete_file = {
    "name": "delete_file", "description": "Delete a file or directory",
    "parameters": {"type": "object", "required": ["path"], "properties": {
        "path": {"type": "string"},
    }},
}


# ── Web Search ─────────────────────────────────────────────────────────

async def _web_search(query: str, num_results: int = 5, source: str = "auto") -> dict:
    serper = os.environ.get("SERPER_API_KEY", "")
    brave  = os.environ.get("BRAVE_SEARCH_API_KEY", "")
    try:
        import aiohttp
    except ImportError:
        return {"query": query, "error": "pip install aiohttp", "results": []}

    if serper and source in ("auto", "serper"):
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(
                    "https://google.serper.dev/search",
                    headers={"X-API-KEY": serper, "Content-Type": "application/json"},
                    json={"q": query, "num": num_results},
                    timeout=aiohttp.ClientTimeout(total=12),
                ) as r:
                    data = await r.json()
                    results = [{"title": i.get("title",""), "snippet": i.get("snippet",""),
                                "url": i.get("link","")}
                               for i in data.get("organic", [])[:num_results]]
                    return {"query": query, "source": "serper", "results": results}
        except Exception as e:
            logger.warning(f"[SEARCH] Serper: {e}")

    if brave and source in ("auto", "brave"):
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    headers={"Accept": "application/json", "X-Subscription-Token": brave},
                    params={"q": query, "count": num_results},
                    timeout=aiohttp.ClientTimeout(total=12),
                ) as r:
                    data = await r.json()
                    results = [{"title": i.get("title",""), "snippet": i.get("description",""),
                                "url": i.get("url","")}
                               for i in data.get("web",{}).get("results",[])[:num_results]]
                    return {"query": query, "source": "brave", "results": results}
        except Exception as e:
            logger.warning(f"[SEARCH] Brave: {e}")

    return {
        "query": query, "source": "mock",
        "results": [{"title": f"Result {i+1}: {query}",
                     "snippet": f"Content about {query}",
                     "url": f"https://example.com/{i+1}"}
                    for i in range(min(num_results, 3))],
        "_note": "Set SERPER_API_KEY or BRAVE_SEARCH_API_KEY for real results",
    }

_s_web_search = {
    "name": "web_search",
    "description": "Search the web. Set SERPER_API_KEY or BRAVE_SEARCH_API_KEY env vars for live results.",
    "parameters": {"type": "object", "required": ["query"], "properties": {
        "query":       {"type": "string"},
        "num_results": {"type": "integer"},
        "source":      {"type": "string", "enum": ["auto","serper","brave"]},
    }},
}


# ── Fetch URL ──────────────────────────────────────────────────────────

async def _fetch_url(url: str, extract_text: bool = True, max_chars: int = 5000) -> dict:
    try:
        import aiohttp
        headers = {"User-Agent": "Mozilla/5.0 (compatible; BotAgent/2.0)"}
        async with aiohttp.ClientSession() as s:
            async with s.get(url, headers=headers,
                             timeout=aiohttp.ClientTimeout(total=15), ssl=False) as resp:
                html = await resp.text(errors="replace")
                if extract_text:
                    text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
                    text = re.sub(r'<style[^>]*>.*?</style>',  '', text,  flags=re.DOTALL)
                    text = re.sub(r'<[^>]+>', ' ', text)
                    text = re.sub(r'\s+', ' ', text).strip()
                    return {"url": url, "status": resp.status, "text": text[:max_chars],
                            "chars": len(text), "truncated": len(text) > max_chars}
                return {"url": url, "status": resp.status, "html": html[:max_chars]}
    except ImportError:
        return {"url": url, "error": "pip install aiohttp"}
    except Exception as e:
        return {"url": url, "error": str(e)}

_s_fetch_url = {
    "name": "fetch_url", "description": "Fetch a URL and return extracted text or raw HTML",
    "parameters": {"type": "object", "required": ["url"], "properties": {
        "url": {"type": "string"}, "extract_text": {"type": "boolean"},
        "max_chars": {"type": "integer"},
    }},
}


# ── HTTP Request ───────────────────────────────────────────────────────

async def _http_request(url: str, method: str = "GET", headers: dict | None = None,
                        body: str = "", timeout_s: float = 15.0) -> dict:
    try:
        import aiohttp
        async with aiohttp.ClientSession() as s:
            kw: dict = dict(headers=headers or {}, ssl=False,
                           timeout=aiohttp.ClientTimeout(total=timeout_s))
            if body:
                kw["data"] = body
            async with s.request(method.upper(), url, **kw) as resp:
                text = await resp.text(errors="replace")
                return {"status": resp.status, "body": text[:5000],
                        "url": str(resp.url), "success": 200 <= resp.status < 300}
    except ImportError:
        return {"error": "pip install aiohttp"}
    except Exception as e:
        return {"error": str(e), "success": False}

_s_http_request = {
    "name": "http_request", "description": "Make an HTTP request",
    "parameters": {"type": "object", "required": ["url"], "properties": {
        "url":       {"type": "string"},
        "method":    {"type": "string", "enum": ["GET","POST","PUT","DELETE","PATCH"]},
        "headers":   {"type": "object"},
        "body":      {"type": "string"},
        "timeout_s": {"type": "number"},
    }},
}


# ── Code Execution ─────────────────────────────────────────────────────

async def _run_python(code: str, timeout_s: float = 15.0) -> dict:
    import sys, tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(code)
        fname = f.name
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, fname,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        return {"returncode": proc.returncode, "success": proc.returncode == 0,
                "stdout": out.decode(errors="replace")[:3000],
                "stderr": err.decode(errors="replace")[:500]}
    except asyncio.TimeoutError:
        return {"returncode": -1, "error": f"Timeout after {timeout_s}s", "success": False}
    except Exception as e:
        return {"returncode": -1, "error": str(e), "success": False}
    finally:
        try: os.unlink(fname)
        except Exception: pass

_s_run_python = {
    "name": "run_python", "description": "Execute Python code in an isolated subprocess",
    "parameters": {"type": "object", "required": ["code"], "properties": {
        "code": {"type": "string"}, "timeout_s": {"type": "number"},
    }},
}


_BLOCKED = ["rm -rf", "rmdir /s", "mkfs", "dd if=", "> /dev/",
            ":(){:|:&};:", "wget -O- | sh", "curl | sh", "curl | bash"]

async def _run_shell(command: str, timeout_s: float = 10.0) -> dict:
    for pat in _BLOCKED:
        if pat in command.lower():
            return {"returncode": -1, "error": f"Blocked: '{pat}'", "success": False}
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        return {"returncode": proc.returncode, "success": proc.returncode == 0,
                "stdout": out.decode(errors="replace")[:3000],
                "stderr": err.decode(errors="replace")[:500]}
    except asyncio.TimeoutError:
        return {"returncode": -1, "error": f"Timeout after {timeout_s}s", "success": False}
    except Exception as e:
        return {"returncode": -1, "error": str(e), "success": False}

_s_run_shell = {
    "name": "run_shell", "description": "Run a shell command (dangerous patterns blocked)",
    "parameters": {"type": "object", "required": ["command"], "properties": {
        "command": {"type": "string"}, "timeout_s": {"type": "number"},
    }},
}


# ── Text Utilities ─────────────────────────────────────────────────────

async def _parse_json(text: str, extract_first: bool = True) -> dict:
    clean = text.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
    try:
        return {"result": json.loads(clean), "success": True}
    except Exception:
        pass
    if extract_first:
        for pattern in (r'\{.*\}', r'\[.*\]'):
            m = re.search(pattern, clean, re.DOTALL)
            if m:
                try:
                    return {"result": json.loads(m.group()), "success": True, "extracted": True}
                except Exception:
                    pass
    return {"result": None, "success": False, "raw": text[:500]}

_s_parse_json = {
    "name": "parse_json", "description": "Parse JSON from a string, stripping markdown fences",
    "parameters": {"type": "object", "required": ["text"], "properties": {
        "text": {"type": "string"}, "extract_first": {"type": "boolean"},
    }},
}


async def _extract_emails(text: str) -> dict:
    emails = sorted(set(re.findall(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}', text)))
    return {"emails": emails, "count": len(emails)}

_s_extract_emails = {
    "name": "extract_emails", "description": "Extract email addresses from text",
    "parameters": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
}


async def _extract_urls(text: str, include_params: bool = True) -> dict:
    urls = list(set(re.findall(r'https?://[^\s<>"\'{}|\\^`\[\]]+', text)))
    if not include_params:
        urls = list(set(u.split("?")[0] for u in urls))
    return {"urls": sorted(urls), "count": len(urls)}

_s_extract_urls = {
    "name": "extract_urls", "description": "Extract URLs from text",
    "parameters": {"type": "object", "required": ["text"], "properties": {
        "text": {"type": "string"}, "include_params": {"type": "boolean"},
    }},
}


async def _text_summarize(text: str, max_sentences: int = 5, focus: str = "") -> dict:
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    if len(sentences) <= max_sentences:
        return {"summary": text, "sentences": len(sentences), "method": "passthrough"}
    words = re.findall(r'\b\w+\b', text.lower())
    freq: dict = {}
    for w in words:
        if len(w) > 3:
            freq[w] = freq.get(w, 0) + 1
    focus_words = set(focus.lower().split()) if focus else set()
    scored = []
    for i, sent in enumerate(sentences):
        sw    = re.findall(r'\b\w+\b', sent.lower())
        score = sum(freq.get(w, 0) for w in sw)
        if focus_words:
            score += sum(10 for w in sw if w in focus_words)
        scored.append((score, i, sent))
    scored.sort(reverse=True)
    top     = sorted(scored[:max_sentences], key=lambda x: x[1])
    summary = " ".join(s for _, _, s in top)
    return {"summary": summary, "sentences": len(top),
            "original_sentences": len(sentences), "method": "extractive"}

_s_text_summarize = {
    "name": "text_summarize", "description": "Fast extractive text summarizer (no LLM cost)",
    "parameters": {"type": "object", "required": ["text"], "properties": {
        "text": {"type": "string"}, "max_sentences": {"type": "integer"},
        "focus": {"type": "string"},
    }},
}


async def _sleep(seconds: float) -> dict:
    await asyncio.sleep(min(float(seconds), 30.0))
    return {"slept_s": seconds, "status": "done"}

_s_sleep = {
    "name": "sleep", "description": "Wait N seconds (max 30)",
    "parameters": {"type": "object", "required": ["seconds"], "properties": {
        "seconds": {"type": "number"},
    }},
}

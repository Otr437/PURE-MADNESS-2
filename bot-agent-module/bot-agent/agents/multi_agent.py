"""
Hierarchical Multi-Agent Coordinator — May 30, 2026
Supervisor → Worker pattern with capability-aware routing.
Async task queue, worker pool, result streaming, retry logic.
Max 4 workers (2026 coordination research).
"""

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

logger = logging.getLogger("multi_agent")


class WorkerRole(str, Enum):
    BROWSER    = "browser"
    RESEARCHER = "researcher"
    EXTRACTOR  = "extractor"
    CODER      = "coder"
    PLANNER    = "planner"
    VERIFIER   = "verifier"
    WRITER     = "writer"
    ANALYST    = "analyst"


ROLE_MODELS = {
    WorkerRole.BROWSER:    "claude",
    WorkerRole.RESEARCHER: "claude",
    WorkerRole.EXTRACTOR:  "fast",
    WorkerRole.CODER:      "claude",
    WorkerRole.PLANNER:    "claude",
    WorkerRole.VERIFIER:   "fast",
    WorkerRole.WRITER:     "claude",
    WorkerRole.ANALYST:    "claude",
}

ROLE_TOKEN_LIMITS = {
    WorkerRole.BROWSER:    80_000,
    WorkerRole.RESEARCHER: 60_000,
    WorkerRole.EXTRACTOR:  30_000,
    WorkerRole.CODER:      50_000,
    WorkerRole.PLANNER:    20_000,
    WorkerRole.VERIFIER:   20_000,
    WorkerRole.WRITER:     60_000,
    WorkerRole.ANALYST:    50_000,
}


@dataclass
class WorkerTask:
    task_id:     str        = field(default_factory=lambda: str(uuid.uuid4())[:8])
    role:        WorkerRole = WorkerRole.RESEARCHER
    instruction: str        = ""
    context:     dict       = field(default_factory=dict)
    dependencies:list[str]  = field(default_factory=list)  # task_ids that must finish first
    result:      Any        = None
    status:      str        = "pending"   # pending|queued|running|done|failed|skipped
    error:       str        = ""
    started_at:  float      = 0.0
    ended_at:    float      = 0.0
    tokens_used: int        = 0
    retries:     int        = 0
    max_retries: int        = 1

    def duration_s(self) -> float:
        if self.ended_at and self.started_at:
            return round(self.ended_at - self.started_at, 2)
        return 0.0

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id, "role": self.role.value,
            "instruction": self.instruction[:120],
            "status": self.status, "error": self.error,
            "duration_s": self.duration_s(), "tokens_used": self.tokens_used,
            "result_preview": str(self.result)[:200] if self.result else None,
        }


@dataclass
class SupervisorPlan:
    goal:     str
    tasks:    list[WorkerTask] = field(default_factory=list)
    parallel: bool = False
    created:  float = field(default_factory=time.time)

    def execution_order(self) -> list[list[WorkerTask]]:
        """
        Topological sort based on dependencies.
        Returns list of batches — tasks in same batch can run in parallel.
        """
        completed = set()
        batches   = []
        remaining = list(self.tasks)

        while remaining:
            # Tasks whose dependencies are all satisfied
            ready = [
                t for t in remaining
                if all(dep in completed for dep in t.dependencies)
            ]
            if not ready:
                # Break circular dependency by forcing first remaining task
                ready = [remaining[0]]
                logger.warning("[PLAN] Circular dependency detected — forcing execution")
            batches.append(ready)
            for t in ready:
                completed.add(t.task_id)
                remaining.remove(t)

        return batches


class WorkerAgent:
    """Single-purpose specialist worker."""

    def __init__(self, role: WorkerRole):
        self.role  = role
        self.busy  = False
        self._model = ROLE_MODELS.get(role, "claude")
        self._token_limit = ROLE_TOKEN_LIMITS.get(role, 50_000)

    async def execute(
        self, task: WorkerTask, on_update: Callable | None = None
    ) -> WorkerTask:
        self.busy       = True
        task.status     = "running"
        task.started_at = time.time()

        await _emit(on_update, {
            "event": "worker_start", "task_id": task.task_id,
            "role": self.role.value, "instruction": task.instruction[:100],
        })

        for attempt in range(task.max_retries + 1):
            try:
                task.result     = await self._run(task)
                task.status     = "done"
                task.error      = ""
                break
            except Exception as e:
                task.retries = attempt + 1
                task.error   = f"{type(e).__name__}: {e}"
                logger.warning(f"[WORKER:{self.role.value}] Attempt {attempt+1} failed: {e}")
                if attempt < task.max_retries:
                    await asyncio.sleep(2 ** attempt)
                else:
                    task.status = "failed"

        task.ended_at = time.time()
        self.busy     = False

        await _emit(on_update, {
            "event":    "worker_done", "task_id": task.task_id,
            "role":     self.role.value, "status": task.status,
            "duration": task.duration_s(), "tokens": task.tokens_used,
            "error":    task.error,
        })
        return task

    async def _run(self, task: WorkerTask) -> Any:
        from core.agent_engine import (
            LLMProvider, ToolRegistry, BudgetState, ReActEngine
        )

        provider = LLMProvider(self._model)
        registry = ToolRegistry()
        budget   = BudgetState(
            session_limit   = self._token_limit,
            iteration_limit = 12,
        )

        self._register_role_tools(registry, task)

        engine  = ReActEngine(registry=registry, provider=provider, budget=budget)
        session = await engine.run(
            task.instruction,
            context  = task.context,
            tags     = [self.role.value],
            metadata = {"task_id": task.task_id},
        )
        task.tokens_used = session.budget.total_used
        return session.final_result

    def _register_role_tools(self, registry, task: WorkerTask):
        from core.agent_engine import ToolRegistry

        if self.role == WorkerRole.RESEARCHER:
            self._register_search_tools(registry)

        elif self.role == WorkerRole.EXTRACTOR:
            self._register_extraction_tools(registry)

        elif self.role == WorkerRole.CODER:
            self._register_code_tools(registry)

        elif self.role == WorkerRole.ANALYST:
            self._register_analysis_tools(registry)

        elif self.role == WorkerRole.WRITER:
            self._register_writer_tools(registry)

        elif self.role == WorkerRole.VERIFIER:
            self._register_verifier_tools(registry)

        # All workers get file I/O and calculator
        self._register_common_tools(registry)

    def _register_search_tools(self, registry):
        async def web_search(query: str, num_results: int = 5) -> dict:
            """
            Multi-source web search.
            Wire to Serper, Brave Search, or SerpAPI via env keys.
            Falls back to DuckDuckGo-style mock.
            """
            import os, aiohttp
            serper_key = os.environ.get("SERPER_API_KEY", "")
            brave_key  = os.environ.get("BRAVE_SEARCH_API_KEY", "")

            if serper_key:
                try:
                    async with aiohttp.ClientSession() as s:
                        async with s.post(
                            "https://google.serper.dev/search",
                            headers={"X-API-KEY": serper_key, "Content-Type": "application/json"},
                            json={"q": query, "num": num_results},
                            timeout=aiohttp.ClientTimeout(total=10),
                        ) as resp:
                            data = await resp.json()
                            results = [
                                {"title": r.get("title",""), "snippet": r.get("snippet",""), "url": r.get("link","")}
                                for r in data.get("organic", [])[:num_results]
                            ]
                            return {"query": query, "source": "serper", "results": results}
                except Exception as e:
                    logger.warning(f"[SEARCH] Serper error: {e}")

            if brave_key:
                try:
                    async with aiohttp.ClientSession() as s:
                        async with s.get(
                            "https://api.search.brave.com/res/v1/web/search",
                            headers={"Accept": "application/json", "X-Subscription-Token": brave_key},
                            params={"q": query, "count": num_results},
                            timeout=aiohttp.ClientTimeout(total=10),
                        ) as resp:
                            data = await resp.json()
                            results = [
                                {"title": r.get("title",""), "snippet": r.get("description",""), "url": r.get("url","")}
                                for r in data.get("web", {}).get("results", [])[:num_results]
                            ]
                            return {"query": query, "source": "brave", "results": results}
                except Exception as e:
                    logger.warning(f"[SEARCH] Brave error: {e}")

            # Mock fallback
            return {
                "query": query, "source": "mock",
                "results": [
                    {"title": f"Result {i+1} for: {query}", "snippet": f"Relevant info about {query}", "url": f"https://example.com/{i}"}
                    for i in range(min(num_results, 3))
                ],
                "_note": "Set SERPER_API_KEY or BRAVE_SEARCH_API_KEY for real results",
            }

        async def fetch_url(url: str, extract_text: bool = True) -> dict:
            """Fetch a URL and return content."""
            try:
                import aiohttp
                async with aiohttp.ClientSession() as s:
                    async with s.get(
                        url,
                        headers={"User-Agent": "Mozilla/5.0 (compatible; BotAgent/1.0)"},
                        timeout=aiohttp.ClientTimeout(total=15),
                        ssl=False,
                    ) as resp:
                        html = await resp.text(errors="replace")
                        if extract_text:
                            # Strip HTML tags
                            import re
                            text = re.sub(r'<[^>]+>', ' ', html)
                            text = re.sub(r'\s+', ' ', text).strip()[:3000]
                            return {"url": url, "status": resp.status, "text": text}
                        return {"url": url, "status": resp.status, "html": html[:5000]}
            except Exception as e:
                return {"url": url, "error": str(e)}

        registry.register("web_search", web_search, {
            "name": "web_search",
            "description": "Search the web. Set SERPER_API_KEY or BRAVE_SEARCH_API_KEY for real results.",
            "parameters": {"type": "object", "required": ["query"], "properties": {
                "query":       {"type": "string"},
                "num_results": {"type": "integer"},
            }},
        }, timeout_s=15.0)

        registry.register("fetch_url", fetch_url, {
            "name": "fetch_url",
            "description": "Fetch and extract text from a URL",
            "parameters": {"type": "object", "required": ["url"], "properties": {
                "url":          {"type": "string"},
                "extract_text": {"type": "boolean"},
            }},
        }, timeout_s=20.0)

    def _register_extraction_tools(self, registry):
        async def parse_structured(text: str, schema: dict) -> dict:
            import re, json
            m = re.search(r'\{.*\}', text, re.DOTALL)
            if m:
                try:
                    return json.loads(m.group())
                except Exception:
                    pass
            from core.agent_engine import LLMProvider
            provider = LLMProvider("fast")
            prompt   = f"Extract this schema from the text:\nSchema: {json.dumps(schema)}\nText: {text[:2000]}\nReturn only JSON."
            raw, _   = await provider.complete(
                messages=[{"role": "user", "content": prompt}],
                system="Extract structured data. Return only JSON.",
                max_tokens=800,
            )
            try:
                return json.loads(raw.strip().lstrip("```json").rstrip("```").strip())
            except Exception:
                return {"_raw": raw}

        async def extract_emails(text: str) -> dict:
            import re
            emails = list(set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text)))
            return {"emails": emails, "count": len(emails)}

        async def extract_urls(text: str) -> dict:
            import re
            urls = list(set(re.findall(r'https?://[^\s<>"{}|\\^`\[\]]+', text)))
            return {"urls": urls, "count": len(urls)}

        registry.register("parse_structured", parse_structured, {
            "name": "parse_structured",
            "description": "Extract structured JSON from raw text using a schema",
            "parameters": {"type": "object", "required": ["text","schema"], "properties": {
                "text":   {"type": "string"},
                "schema": {"type": "object"},
            }},
        })
        registry.register("extract_emails", extract_emails, {
            "name": "extract_emails", "description": "Extract email addresses from text",
            "parameters": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
        })
        registry.register("extract_urls", extract_urls, {
            "name": "extract_urls", "description": "Extract URLs from text",
            "parameters": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
        })

    def _register_code_tools(self, registry):
        async def run_python(code: str, timeout_s: float = 10.0) -> dict:
            """Execute Python in a subprocess sandbox."""
            import subprocess, sys, tempfile, os
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
                f.write(code)
                fname = f.name
            try:
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, fname,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
                return {
                    "returncode": proc.returncode,
                    "stdout":     stdout.decode()[:2000],
                    "stderr":     stderr.decode()[:500],
                }
            except asyncio.TimeoutError:
                return {"returncode": -1, "error": f"Timeout after {timeout_s}s"}
            except Exception as e:
                return {"returncode": -1, "error": str(e)}
            finally:
                try:
                    os.unlink(fname)
                except Exception:
                    pass

        async def run_shell(command: str, timeout_s: float = 10.0) -> dict:
            """Run a shell command (read-only operations only)."""
            import subprocess
            # Basic safety: block destructive commands
            blocked = ["rm ", "rmdir", "mkfs", "dd ", "chmod", "chown", "> /",
                       "sudo", "su ", "wget", "curl -o", "pip install"]
            for b in blocked:
                if b in command.lower():
                    return {"error": f"Command blocked for safety: '{b}' detected"}
            try:
                proc = await asyncio.create_subprocess_shell(
                    command,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
                return {
                    "returncode": proc.returncode,
                    "stdout":     stdout.decode()[:2000],
                    "stderr":     stderr.decode()[:300],
                }
            except asyncio.TimeoutError:
                return {"returncode": -1, "error": f"Timeout after {timeout_s}s"}
            except Exception as e:
                return {"returncode": -1, "error": str(e)}

        registry.register("run_python", run_python, {
            "name": "run_python", "description": "Execute Python code in a sandbox subprocess",
            "parameters": {"type": "object", "required": ["code"], "properties": {
                "code":      {"type": "string"},
                "timeout_s": {"type": "number"},
            }},
        }, timeout_s=30.0)

        registry.register("run_shell", run_shell, {
            "name": "run_shell", "description": "Run safe read-only shell commands",
            "parameters": {"type": "object", "required": ["command"], "properties": {
                "command":   {"type": "string"},
                "timeout_s": {"type": "number"},
            }},
        }, timeout_s=15.0)

    def _register_analysis_tools(self, registry):
        async def calculate(expression: str) -> dict:
            import math
            safe_globals = {k: getattr(math, k) for k in dir(math) if not k.startswith("_")}
            safe_globals.update({"abs": abs, "round": round, "min": min, "max": max,
                                  "sum": sum, "len": len, "pow": pow})
            try:
                result = eval(expression, {"__builtins__": {}}, safe_globals)
                return {"result": result, "expression": expression}
            except Exception as e:
                return {"error": str(e), "expression": expression}

        async def summarize_data(data: list | dict, focus: str = "") -> dict:
            from core.agent_engine import LLMProvider
            provider = LLMProvider("fast")
            prompt   = f"Summarize this data{' focusing on: '+focus if focus else ''}:\n{json.dumps(data, default=str)[:3000]}"
            raw, _   = await provider.complete(
                messages=[{"role": "user", "content": prompt}],
                system="You are a data analyst. Be concise and precise.",
                max_tokens=500,
            )
            return {"summary": raw, "items_analyzed": len(data) if isinstance(data, list) else 1}

        registry.register("calculate", calculate, {
            "name": "calculate", "description": "Evaluate math expressions safely (supports math module)",
            "parameters": {"type": "object", "required": ["expression"], "properties": {
                "expression": {"type": "string"},
            }},
        })
        registry.register("summarize_data", summarize_data, {
            "name": "summarize_data", "description": "Summarize a list or dict of data",
            "parameters": {"type": "object", "required": ["data"], "properties": {
                "data":  {},
                "focus": {"type": "string"},
            }},
        })

    def _register_writer_tools(self, registry):
        async def format_output(content: str, format_type: str = "markdown") -> dict:
            if format_type == "markdown":
                return {"formatted": content, "format": "markdown"}
            if format_type == "json":
                try:
                    return {"formatted": json.loads(content), "format": "json"}
                except Exception:
                    return {"formatted": content, "format": "raw", "error": "not valid json"}
            return {"formatted": content, "format": format_type}

        registry.register("format_output", format_output, {
            "name": "format_output", "description": "Format output as markdown, JSON, etc.",
            "parameters": {"type": "object", "required": ["content"], "properties": {
                "content":     {"type": "string"},
                "format_type": {"type": "string", "enum": ["markdown","json","plain","html"]},
            }},
        })

    def _register_verifier_tools(self, registry):
        async def verify_output(output: Any, criteria: list[str]) -> dict:
            from core.agent_engine import LLMProvider
            provider = LLMProvider("fast")
            prompt   = (
                f"Verify this output meets each criterion.\n"
                f"Output: {json.dumps(output, default=str)[:1500]}\n"
                f"Criteria: {json.dumps(criteria)}\n"
                "Return JSON: {\"passed\": true|false, \"checks\": {\"criterion\": true|false}, \"notes\": \"...\"}"
            )
            raw, _ = await provider.complete(
                messages=[{"role": "user", "content": prompt}],
                system="You verify outputs against criteria. Return only JSON.",
                max_tokens=400,
            )
            try:
                return json.loads(raw.strip().lstrip("```json").rstrip("```").strip())
            except Exception:
                return {"passed": False, "error": "parse_failed", "raw": raw}

        registry.register("verify_output", verify_output, {
            "name": "verify_output", "description": "Verify output meets quality criteria",
            "parameters": {"type": "object", "required": ["output","criteria"], "properties": {
                "output":   {},
                "criteria": {"type": "array", "items": {"type": "string"}},
            }},
        })

    def _register_common_tools(self, registry):
        async def read_file(path: str, encoding: str = "utf-8") -> dict:
            try:
                with open(path, encoding=encoding) as f:
                    content = f.read()
                return {"path": path, "content": content[:5000],
                        "size_chars": len(content), "truncated": len(content) > 5000}
            except Exception as e:
                return {"path": path, "error": str(e)}

        async def write_file(path: str, content: str, mode: str = "w") -> dict:
            try:
                import os
                os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
                with open(path, mode) as f:
                    f.write(content)
                return {"path": path, "bytes_written": len(content.encode()), "status": "ok"}
            except Exception as e:
                return {"path": path, "error": str(e)}

        async def list_files(directory: str = ".", pattern: str = "*") -> dict:
            import glob, os
            try:
                files = glob.glob(os.path.join(directory, pattern))
                return {
                    "directory": directory,
                    "files": [{"name": os.path.basename(f), "size": os.path.getsize(f),
                               "path": f} for f in files[:50]],
                    "count": len(files),
                }
            except Exception as e:
                return {"error": str(e)}

        async def get_datetime() -> dict:
            import datetime
            now = datetime.datetime.now()
            return {
                "iso":       now.isoformat(),
                "date":      now.strftime("%Y-%m-%d"),
                "time":      now.strftime("%H:%M:%S"),
                "day":       now.strftime("%A"),
                "timestamp": now.timestamp(),
            }

        registry.register("read_file", read_file, {
            "name": "read_file", "description": "Read a file from disk",
            "parameters": {"type": "object", "required": ["path"], "properties": {
                "path":     {"type": "string"},
                "encoding": {"type": "string"},
            }},
        })
        registry.register("write_file", write_file, {
            "name": "write_file", "description": "Write content to a file",
            "parameters": {"type": "object", "required": ["path","content"], "properties": {
                "path":    {"type": "string"},
                "content": {"type": "string"},
                "mode":    {"type": "string", "enum": ["w","a"]},
            }},
        })
        registry.register("list_files", list_files, {
            "name": "list_files", "description": "List files in a directory",
            "parameters": {"type": "object", "properties": {
                "directory": {"type": "string"},
                "pattern":   {"type": "string"},
            }},
        })
        registry.register("get_datetime", get_datetime, {
            "name": "get_datetime", "description": "Get current date and time",
            "parameters": {"type": "object", "properties": {}},
        })

        # Only register calculate if not already present
        if "calculate" not in registry.list_tools():
            async def calculate(expression: str) -> dict:
                import math
                safe = {k: getattr(math, k) for k in dir(math) if not k.startswith("_")}
                safe.update({"abs": abs, "round": round, "min": min, "max": max})
                try:
                    return {"result": eval(expression, {"__builtins__": {}}, safe), "expression": expression}
                except Exception as e:
                    return {"error": str(e)}
            registry.register("calculate", calculate, {
                "name": "calculate", "description": "Math expression evaluator",
                "parameters": {"type": "object", "required": ["expression"], "properties": {
                    "expression": {"type": "string"},
                }},
            })


# ─────────────────────────────────────────────
# Async Task Queue
# ─────────────────────────────────────────────

class TaskQueue:
    """Async queue for dispatching tasks to available workers."""

    def __init__(self, workers: dict[WorkerRole, WorkerAgent], on_update: Callable | None = None):
        self._workers   = workers
        self._queue:    asyncio.Queue = asyncio.Queue()
        self._results:  dict[str, WorkerTask] = {}
        self._on_update = on_update

    async def run_batch(self, tasks: list[WorkerTask]) -> list[WorkerTask]:
        """Run a batch of tasks concurrently using worker pool."""
        coros = []
        for task in tasks:
            worker = self._workers.get(task.role)
            if not worker:
                # Fallback to first available worker
                worker = next(iter(self._workers.values()))
                logger.warning(f"[QUEUE] No worker for role {task.role} — using {worker.role}")
            coros.append(worker.execute(task, on_update=self._on_update))

        completed = await asyncio.gather(*coros, return_exceptions=True)
        results   = []
        for i, res in enumerate(completed):
            if isinstance(res, Exception):
                tasks[i].status = "failed"
                tasks[i].error  = str(res)
                results.append(tasks[i])
            else:
                results.append(res)
        return results

    async def run_sequential(
        self, tasks: list[WorkerTask], pass_context: bool = True
    ) -> list[WorkerTask]:
        accumulated = {}
        completed   = []
        for task in tasks:
            if pass_context and accumulated:
                task.context.update({"prior_results": accumulated})
            worker = self._workers.get(task.role) or next(iter(self._workers.values()))
            result = await worker.execute(task, on_update=self._on_update)
            completed.append(result)
            if result.status == "done" and isinstance(result.result, (dict, str)):
                accumulated[result.task_id] = result.result
        return completed


# ─────────────────────────────────────────────
# Supervisor Agent
# ─────────────────────────────────────────────

class SupervisorAgent:
    """
    Orchestrates workers via dependency-aware topological scheduling.
    Decomposes goals, routes tasks, aggregates results.
    Supports parallel and sequential execution modes.
    """

    MAX_WORKERS = 4

    def __init__(
        self,
        available_roles: list[WorkerRole] | None = None,
        model_alias:     str = "claude",
        on_update:       Callable | None = None,
    ):
        roles = (available_roles or [
            WorkerRole.RESEARCHER,
            WorkerRole.EXTRACTOR,
            WorkerRole.ANALYST,
            WorkerRole.VERIFIER,
        ])[:self.MAX_WORKERS]

        self.workers   = {r: WorkerAgent(r) for r in roles}
        self.model     = model_alias
        self.on_update = on_update
        self._queue    = TaskQueue(self.workers, on_update)

    async def run(self, goal: str, context: dict | None = None) -> dict:
        run_id = str(uuid.uuid4())[:8]
        start  = time.time()
        logger.info(f"[SUPERVISOR:{run_id}] Goal: {goal[:100]}")

        plan = await self._plan(goal, context or {})

        await _emit(self.on_update, {
            "event":  "plan_ready", "run_id": run_id,
            "goal":   goal,
            "tasks":  [{"id": t.task_id, "role": t.role.value,
                         "instruction": t.instruction[:100],
                         "deps": t.dependencies}
                       for t in plan.tasks],
            "parallel": plan.parallel,
        })

        # Execute using dependency-aware batching
        all_completed = []
        batches = plan.execution_order()

        for batch_idx, batch in enumerate(batches):
            logger.info(f"[SUPERVISOR:{run_id}] Batch {batch_idx+1}/{len(batches)}: "
                        f"{len(batch)} task(s) → {[t.role.value for t in batch]}")

            await _emit(self.on_update, {
                "event": "batch_start", "run_id": run_id,
                "batch": batch_idx+1, "total_batches": len(batches),
                "tasks": [t.task_id for t in batch],
            })

            # Inject prior results as context
            prior = {t.task_id: t.result for t in all_completed if t.status == "done"}
            for task in batch:
                if prior:
                    task.context["prior_results"] = prior

            if len(batch) > 1:
                completed_batch = await self._queue.run_batch(batch)
            else:
                completed_batch = await self._queue.run_sequential(batch, pass_context=False)

            all_completed.extend(completed_batch)

        result = await self._aggregate(goal, all_completed)

        summary = {
            "run_id":        run_id,
            "goal":          goal,
            "tasks_total":   len(all_completed),
            "tasks_done":    sum(1 for t in all_completed if t.status == "done"),
            "tasks_failed":  sum(1 for t in all_completed if t.status == "failed"),
            "tokens_total":  sum(t.tokens_used for t in all_completed),
            "duration_s":    round(time.time() - start, 2),
            "result":        result,
            "task_details":  [t.to_dict() for t in all_completed],
        }

        await _emit(self.on_update, {"event": "supervisor_done", **{
            k: v for k, v in summary.items() if k != "task_details"
        }})
        return summary

    async def _plan(self, goal: str, context: dict) -> SupervisorPlan:
        from core.agent_engine import LLMProvider
        provider = LLMProvider(self.model)
        available = [r.value for r in self.workers]

        prompt = (
            f"Decompose this goal into sub-tasks for specialist workers.\n"
            f"Goal: {goal}\n"
            f"Available roles: {available}\n"
            f"Context: {json.dumps(context, default=str)[:400]}\n\n"
            "Rules:\n"
            "- 2-4 tasks max\n"
            "- Each task must have a specific, actionable instruction\n"
            "- Use 'dependencies' field (list of task_ids that must finish first)\n"
            "- Use the role best suited for each sub-task\n\n"
            "Return ONLY JSON:\n"
            '{"parallel": false, "tasks": [{"role": "<role>", "instruction": "<specific instruction>", "dependencies": []}]}'
        )
        raw, _ = await provider.complete(
            messages=[{"role": "user", "content": prompt}],
            system="You decompose goals into specialist sub-tasks. Return only JSON.",
            max_tokens=700,
        )
        try:
            data  = json.loads(raw.strip().lstrip("```json").rstrip("```").strip())
            tasks = []
            for i, t in enumerate(data.get("tasks", [])[:4]):
                role_str = t.get("role", "researcher")
                try:
                    role = WorkerRole(role_str)
                    if role not in self.workers:
                        role = list(self.workers.keys())[0]
                except ValueError:
                    role = list(self.workers.keys())[0]
                task = WorkerTask(
                    role         = role,
                    instruction  = t.get("instruction", goal),
                    context      = {**context, **t.get("context", {})},
                    dependencies = t.get("dependencies", []),
                )
                tasks.append(task)
            return SupervisorPlan(goal=goal, tasks=tasks, parallel=data.get("parallel", False))
        except Exception as e:
            logger.warning(f"[SUPERVISOR] Plan parse error: {e} — using single task")
            role = list(self.workers.keys())[0]
            return SupervisorPlan(goal=goal, tasks=[
                WorkerTask(role=role, instruction=goal, context=context)
            ])

    async def _aggregate(self, goal: str, tasks: list[WorkerTask]) -> str:
        from core.agent_engine import LLMProvider
        provider = LLMProvider(self.model)

        results_str = json.dumps([t.to_dict() for t in tasks], indent=2)[:2500]
        prompt = (
            f"Original goal: {goal}\n\n"
            f"Worker results:\n{results_str}\n\n"
            "Synthesize a final, complete, well-structured answer. "
            "If any tasks failed, note what's missing."
        )
        raw, _ = await provider.complete(
            messages=[{"role": "user", "content": prompt}],
            system="You synthesize multi-agent results into a clear final answer.",
            max_tokens=1200,
        )
        return raw


# ─────────────────────────────────────────────
# Utility
# ─────────────────────────────────────────────

async def _emit(fn: Callable | None, payload: dict):
    if not fn:
        return
    try:
        if asyncio.iscoroutinefunction(fn):
            await fn(payload)
        else:
            fn(payload)
    except Exception as e:
        logger.warning(f"[EMIT] Callback error: {e}")

"""
Bot Agent Module — Main Entry Point
May 30, 2026

Single facade for all agent capabilities:
  BotAgent.browse()  — browser bot (Chrome/Edge/Brave/Arc, headless or live)
  BotAgent.react()   — pure ReAct loop (no browser)
  BotAgent.multi()   — hierarchical multi-agent supervisor
  BotAgent.research()— researcher agent with web search
  BotAgent.code()    — coder agent with Python/shell execution
"""

import asyncio
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from core.config       import get_config, AppConfig
from core.health       import setup_logging, MetricsCollector, SessionRegistry, GracefulShutdown
from core.memory       import AgentMemory
from core.agent_engine import (
    ReActEngine, ToolRegistry, LLMProvider, BudgetState, AgentPhase
)
from browser.browser_bot  import BrowserBotAgent, BrowserConfig, BrowserMode
from agents.multi_agent   import SupervisorAgent, WorkerAgent, WorkerRole
from budget.budget_manager import BudgetGateway, BudgetPolicy, get_gateway
from tools.builtin_tools   import register_all as register_builtin_tools


class BotAgent:
    """
    Unified entry point.

    Models : "claude" | "openai" | "gemini" | "fast" | "opus"
    Browsers: "headless" | "live_chrome" | "live_edge" | "live_brave" | "browserbase" | "steel"

    Quick start:
        agent = BotAgent()
        result = asyncio.run(agent.browse("https://example.com", "Extract all headlines"))
        result = asyncio.run(agent.react("Solve: compound interest $5k at 8% for 10 years"))
        result = asyncio.run(agent.multi("Research the top 3 AI coding assistants in 2026"))
        result = asyncio.run(agent.research("What happened at Google I/O 2026?"))
        result = asyncio.run(agent.code("Write and run a Python script to generate a Fibonacci sequence"))
    """

    def __init__(
        self,
        model:           str   = "claude",
        browser_mode:    str   = "headless",
        cdp_url:         str   = "http://localhost:9222",
        headless:        bool  = True,
        token_limit:     int   = 200_000,
        iteration_limit: int   = 25,
        monthly_usd_cap: float = 100.0,
        daily_usd_cap:   float = 20.0,
        save_sessions:   bool  = False,
        memory_dir:      str   = "./agent_memory",
        verbose:         bool  = True,
        log_level:       str   = "INFO",
        config_file:     str   = "",
    ):
        # Load config (.env + overrides)
        self.cfg = get_config(config_file=config_file)

        # Setup logging
        setup_logging(level=log_level)
        self.logger = logging.getLogger("bot_agent")

        self.model        = model
        self.save_sessions= save_sessions
        self.verbose      = verbose

        # Budget gateway
        self.gateway = get_gateway(BudgetPolicy(
            session_token_limit  = token_limit,
            iteration_hard_cap   = iteration_limit,
            monthly_usd_limit    = monthly_usd_cap,
            daily_usd_limit      = daily_usd_cap,
            persist_log          = save_sessions,
        ))

        # Memory
        self.memory = AgentMemory(storage_dir=memory_dir)

        # Metrics + session registry
        self.metrics  = MetricsCollector()
        self.registry = SessionRegistry()

        # Browser config
        mode_map = {
            "headless":    BrowserMode.LOCAL_HEADLESS,
            "live_chrome": BrowserMode.LOCAL_CHROME,
            "live_edge":   BrowserMode.LOCAL_CHROME,
            "live_brave":  BrowserMode.LOCAL_CHROME,
            "browserbase": BrowserMode.BROWSERBASE,
            "steel":       BrowserMode.STEEL,
        }
        self._browser_cfg = BrowserConfig(
            mode        = mode_map.get(browser_mode, BrowserMode.LOCAL_HEADLESS),
            headless    = headless,
            cdp_url     = cdp_url,
            stealth     = True,
            downloads_dir = "./downloads",
            browserbase_api_key = self.cfg.keys.browserbase,
            steel_api_key       = self.cfg.keys.steel,
        )
        self._token_limit = token_limit
        self._iter_limit  = iteration_limit

    # ── Step callback ────────────────────────────────────────────────────

    def _on_step(self, payload: dict):
        self.metrics.inc("agent.steps")
        self.metrics.inc(f"agent.phase.{payload.get('phase','unknown')}")
        if not self.verbose:
            return
        it     = payload.get("iteration", "?")
        phase  = payload.get("phase", "").upper().ljust(8)
        thought= payload.get("thought", "")[:110]
        budget = payload.get("budget", {})
        tools  = payload.get("tools", [])
        print(f"\n{'─'*62}")
        print(f"  [{it:>2}] {phase}  conf={payload.get('confidence',0):.2f}")
        print(f"  💭 {thought}")
        if tools:
            for t in tools:
                icon = "✅" if t["status"] == "success" else "❌"
                print(f"  {icon} {t['name']:<20} {t.get('duration_ms',0):.0f}ms")
        obs = payload.get("observation","")
        if obs:
            print(f"  👁  {obs[:100]}")
        print(f"  📊 tokens={budget.get('tokens_used',0):,}  "
              f"left={budget.get('tokens_left',0):,}  "
              f"iter={budget.get('iterations','?')}  "
              f"cost=${budget.get('cost_usd',0):.5f}  "
              f"errs={budget.get('error_streak',0)}")

    def _on_multi_update(self, payload: dict):
        event = payload.get("event", "")
        if event == "plan_ready":
            print(f"\n📋 PLAN  ({len(payload.get('tasks',[]))} tasks | "
                  f"parallel={payload.get('parallel')})")
            for t in payload.get("tasks", []):
                print(f"   [{t['role'].upper():<12}] {t['instruction'][:80]}")
        elif event == "batch_start":
            b, total = payload.get("batch"), payload.get("total_batches")
            print(f"\n▶  Batch {b}/{total}  tasks={payload.get('tasks')}")
        elif event == "worker_start":
            print(f"   ⚙  {payload['role'].upper()} starting task {payload['task_id']}")
        elif event == "worker_done":
            icon = "✅" if payload["status"] == "done" else "❌"
            print(f"   {icon} {payload['role'].upper()} done "
                  f"({payload['duration']}s | {payload.get('tokens',0):,} tokens)")
        elif event == "supervisor_done":
            print(f"\n✨ Supervisor done: "
                  f"{payload.get('tasks_done')}/{payload.get('tasks_total')} tasks | "
                  f"{payload.get('tokens_total',0):,} tokens | "
                  f"{payload.get('duration_s',0)}s")

    # ── Public API ────────────────────────────────────────────────────────

    async def browse(self, url: str, task: str, *, save: bool | None = None) -> dict:
        """
        Run a browser bot on a URL + task.
        Supports: scraping, form filling, login flows, multi-tab, file download,
                  screenshot, JS execution, network intercept.

        Attach to live Chrome/Edge/Brave:
            BotAgent(browser_mode="live_chrome", headless=False)
        """
        save = save if save is not None else self.save_sessions
        self._print_header("BROWSER AGENT", url=url, task=task)
        self.registry.register(f"browse_{id(task)}", task, self.model, tags=["browser"])
        self.metrics.inc("sessions.browser")

        # Inject relevant memory context
        mem_ctx = self.memory.inject_context(task, top_k=2)
        if mem_ctx and self.verbose:
            print(f"\n🧠 Memory context injected:\n{mem_ctx[:200]}\n")

        bot = BrowserBotAgent(
            browser_config      = self._browser_cfg,
            model_alias         = self.model,
            session_token_limit = self._token_limit,
            iteration_limit     = self._iter_limit,
            on_step             = self._on_step,
        )
        result = await bot.run(task, start_url=url, save_session=save)
        self._persist_memory(task, result)
        self._print_result(result)
        self.metrics.observe("session.duration_s", result.get("duration_s", 0))
        return result

    async def react(self, task: str, tools: dict | None = None, *,
                    save: bool | None = None) -> dict:
        """
        Pure ReAct loop. No browser. All built-in tools available.
        Pass custom tools as: {"tool_name": (async_fn, schema_dict)}
        """
        save = save if save is not None else self.save_sessions
        self._print_header("REACT AGENT", task=task)
        self.metrics.inc("sessions.react")

        reg      = ToolRegistry()
        provider = LLMProvider(self.model)
        budget   = BudgetState(
            session_limit   = self._token_limit,
            iteration_limit = self._iter_limit,
        )

        # Register all built-in tools
        register_builtin_tools(reg)

        # Register any caller-supplied tools
        if tools:
            for name, (fn, schema) in tools.items():
                reg.register(name, fn, schema)

        # Inject memory context
        mem_ctx = self.memory.inject_context(task, top_k=2)
        context = {"memory": mem_ctx} if mem_ctx else {}

        engine  = ReActEngine(reg, provider, budget, on_step=self._on_step)
        session = await engine.run(
            task, context=context, tags=["react"],
            save_session=save,
        )
        result = {
            "session_id":  session.session_id,
            "status":      session.phase.value,
            "result":      session.final_result,
            "steps":       len(session.steps),
            "tokens_used": session.budget.total_used,
            "cost_usd":    session.budget.cost_usd,
            "duration_s":  session.duration_s(),
            "model":       provider.model,
        }
        self._persist_memory(task, result)
        self._print_result(result)
        return result

    async def multi(self, goal: str, roles: list | None = None, *,
                    save: bool | None = None) -> dict:
        """
        Hierarchical multi-agent: Supervisor → Workers.
        Automatic task decomposition, dependency-aware scheduling,
        parallel execution, result aggregation.

        Default roles: RESEARCHER, EXTRACTOR, ANALYST, VERIFIER
        Available: browser, researcher, extractor, coder, analyst, writer, verifier, planner
        """
        self._print_header("MULTI-AGENT SUPERVISOR", task=goal)
        self.metrics.inc("sessions.multi")

        role_map = {
            "browser":    WorkerRole.BROWSER,
            "researcher": WorkerRole.RESEARCHER,
            "extractor":  WorkerRole.EXTRACTOR,
            "coder":      WorkerRole.CODER,
            "analyst":    WorkerRole.ANALYST,
            "writer":     WorkerRole.WRITER,
            "verifier":   WorkerRole.VERIFIER,
            "planner":    WorkerRole.PLANNER,
        }
        worker_roles = [role_map[r] for r in (roles or []) if r in role_map] or None

        supervisor = SupervisorAgent(
            available_roles = worker_roles,
            model_alias     = self.model,
            on_update       = self._on_multi_update if self.verbose else None,
        )
        result = await supervisor.run(goal)
        self._print_result(result)
        self.metrics.observe("session.duration_s", result.get("duration_s", 0))
        return result

    async def research(self, query: str, *, save: bool | None = None) -> dict:
        """
        Focused research agent. Uses web_search + fetch_url + summarize.
        """
        self._print_header("RESEARCH AGENT", task=query)
        self.metrics.inc("sessions.research")
        return await self.react(
            f"Research this thoroughly using web_search and fetch_url tools: {query}\n"
            "Provide a comprehensive, well-structured answer with sources.",
            save=save,
        )

    async def code(self, task: str, *, save: bool | None = None) -> dict:
        """
        Coder agent. Writes and executes Python code via run_python tool.
        """
        self._print_header("CODER AGENT", task=task)
        self.metrics.inc("sessions.code")
        return await self.react(
            f"Complete this coding task using run_python to write and test code: {task}\n"
            "Show working code and its output.",
            save=save,
        )

    async def extract(self, url: str, schema: dict, *, save: bool | None = None) -> dict:
        """
        Fast structured data extraction from a URL.
        schema: {"field": "description", ...}
        """
        task = (
            f"Navigate to {url}, then extract structured data matching this schema: "
            f"{json.dumps(schema)}. Use the extract tool. Return the data as JSON."
        )
        self._print_header("EXTRACT AGENT", url=url, task=f"Extract {list(schema.keys())}")
        return await self.browse(url, task, save=save)

    # ── Status & Utils ────────────────────────────────────────────────────

    def budget_status(self) -> dict:
        return self.gateway.global_summary()

    def memory_stats(self) -> dict:
        return self.memory.stats()

    def metrics_snapshot(self) -> dict:
        return self.metrics.snapshot()

    def config_status(self):
        self.cfg.print_status()

    # ── Internals ────────────────────────────────────────────────────────

    def _persist_memory(self, task: str, result: dict):
        result_str = str(result.get("result", ""))
        if result_str and result.get("status") == "complete":
            self.memory.save_session(
                session_id = result.get("session_id", "unknown"),
                task       = task,
                result     = result_str[:500],
                tags       = [result.get("model", "unknown")],
                metadata   = {"cost_usd": result.get("cost_usd", 0),
                              "steps": result.get("steps", 0)},
            )

    def _print_header(self, mode: str, task: str = "", url: str = ""):
        if not self.verbose:
            return
        print(f"\n{'═'*62}")
        print(f"  {mode}")
        if url:
            print(f"  URL:   {url}")
        print(f"  TASK:  {task[:75]}")
        print(f"  MODEL: {self.model} | ITER LIMIT: {self._iter_limit} | "
              f"TOKEN LIMIT: {self._token_limit:,}")
        print('═'*62)

    @staticmethod
    def _print_result(result: dict):
        print(f"\n{'═'*62}")
        print("  RESULT")
        print('─'*62)
        r = result.get("result") or result.get("final_result", "")
        if isinstance(r, str):
            print(f"  {r[:600]}")
        elif r:
            print(f"  {json.dumps(r, default=str)[:500]}")
        print(f"\n  STATUS:   {result.get('status','?')}")
        steps = result.get("steps") or result.get("tasks_total","?")
        print(f"  STEPS:    {steps}")
        if "tokens_used" in result:
            print(f"  TOKENS:   {result['tokens_used']:,}")
        if "cost_usd" in result:
            print(f"  COST:     ${result['cost_usd']:.5f}")
        if "duration_s" in result:
            print(f"  DURATION: {result['duration_s']}s")
        print('═'*62)


# ─────────────────────────────────────────────
# CLI demo
# ─────────────────────────────────────────────

async def demo():
    agent = BotAgent(model="claude", verbose=True)

    print("\n" + "█"*62)
    print("  BOT AGENT MODULE — May 30, 2026")
    print("  ReAct · Browser · Multi-Agent · Token Budget · Memory")
    print("█"*62)

    agent.config_status()

    # Demo 1: Pure ReAct with math
    print("\n\n── DEMO 1: ReAct Agent ────────────────────────────────────")
    await agent.react(
        "What is the compound annual growth rate if an investment "
        "grows from $12,000 to $31,500 over 9 years? Use calculate tool."
    )

    # Demo 2: Research (needs SERPER_API_KEY or BRAVE_SEARCH_API_KEY)
    # print("\n\n── DEMO 2: Research Agent ─────────────────────────────────")
    # await agent.research("What are the top 3 open-source browser automation tools in 2026?")

    # Demo 3: Browser (needs playwright)
    # print("\n\n── DEMO 3: Browser Agent ──────────────────────────────────")
    # await agent.browse("https://news.ycombinator.com",
    #     "Find the top 3 trending posts and give me title + score for each")

    # Demo 4: Multi-agent
    # print("\n\n── DEMO 4: Multi-Agent ────────────────────────────────────")
    # await agent.multi("Research and compare Playwright vs Puppeteer vs Selenium in 2026",
    #                   roles=["researcher","extractor","analyst","verifier"])

    print("\n\n── BUDGET STATUS ──────────────────────────────────────────")
    print(json.dumps(agent.budget_status(), indent=2))

    print("\n── MEMORY STATS ───────────────────────────────────────────")
    print(json.dumps(agent.memory_stats(), indent=2))

    print("\n── METRICS ────────────────────────────────────────────────")
    print(json.dumps(agent.metrics_snapshot(), indent=2))


if __name__ == "__main__":
    asyncio.run(demo())

"""
Browser Bot Agent — May 30, 2026
CDP-native. Chrome / Edge / Brave / Arc (any Chromium).
Multi-model: Claude, OpenAI, Gemini.
Full vision act, network intercept, file download, multi-tab, cookies/auth.
"""

import asyncio
import base64
import json
import logging
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

logger = logging.getLogger("browser_bot")


class BrowserMode(str, Enum):
    LOCAL_CHROME   = "local_chrome"    # attach to live Chrome/Edge/Brave via CDP
    LOCAL_HEADLESS = "local_headless"  # launch headless Chromium
    BROWSERBASE    = "browserbase"     # managed cloud
    STEEL          = "steel"           # self-hosted cloud


@dataclass
class BrowserConfig:
    mode:               BrowserMode = BrowserMode.LOCAL_HEADLESS
    cdp_url:            str   = "http://localhost:9222"
    headless:           bool  = True
    browser_executable: str   = ""
    browserbase_api_key:str   = ""
    steel_api_key:      str   = ""
    viewport_width:     int   = 1280
    viewport_height:    int   = 900
    user_agent:         str   = ""
    stealth:            bool  = True
    slow_mo_ms:         int   = 0
    screenshot_on_fail: bool  = True
    action_timeout_ms:  int   = 12_000
    nav_timeout_ms:     int   = 30_000
    downloads_dir:      str   = "./downloads"
    intercept_requests: bool  = False   # log/block network requests
    block_resources:    list  = field(default_factory=lambda: [])  # e.g. ["image","font"]
    proxy:              str   = ""      # e.g. "http://user:pass@proxy:8080"
    record_video:       bool  = False
    video_dir:          str   = "./videos"


@dataclass
class PageState:
    url:           str   = ""
    title:         str   = ""
    dom_snapshot:  str   = ""
    screenshot_b64:str   = ""
    interactive:   list  = field(default_factory=list)
    network_log:   list  = field(default_factory=list)
    timestamp:     float = field(default_factory=time.time)

    def to_context(self, include_screenshot: bool = False) -> str:
        els = json.dumps(self.interactive[:35], indent=2)
        base = (
            f"URL: {self.url}\n"
            f"TITLE: {self.title}\n"
            f"INTERACTIVE ELEMENTS (top 35):\n{els}\n"
            f"DOM:\n{self.dom_snapshot[:1800]}"
        )
        if include_screenshot and self.screenshot_b64:
            base += f"\n[screenshot available: {len(self.screenshot_b64)} chars b64]"
        return base


class BrowserSession:
    """
    Full Chromium session via Playwright/CDP.
    Supports: navigate, act (DOM + vision), extract, scroll, type,
              multi-tab, file download, network intercept, cookies,
              hover, drag, keyboard, select, iframe, shadow DOM.
    """

    def __init__(self, config: BrowserConfig):
        self.config        = config
        self._pw           = None
        self._browser      = None
        self._context      = None
        self._page         = None
        self._pages: list  = []          # multi-tab support
        self._mock         = False
        self._sel_cache: dict[str, str] = {}   # instruction → selector
        self._net_log: list[dict]       = []

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def start(self):
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            logger.warning("[BROWSER] playwright not installed → MOCK mode")
            self._mock = True
            return

        self._pw = await async_playwright().start()

        if self.config.mode == BrowserMode.LOCAL_CHROME:
            self._browser = await self._pw.chromium.connect_over_cdp(self.config.cdp_url)
            ctx = self._browser.contexts
            self._context = ctx[0] if ctx else await self._browser.new_context()
            pgs = self._context.pages
            self._page = pgs[0] if pgs else await self._context.new_page()
            logger.info(f"[BROWSER] Attached to live browser @ {self.config.cdp_url}")

        elif self.config.mode == BrowserMode.BROWSERBASE:
            ws = f"wss://connect.browserbase.com?apiKey={self.config.browserbase_api_key}"
            self._browser = await self._pw.chromium.connect_over_cdp(ws)
            self._context = self._browser.contexts[0]
            self._page    = self._context.pages[0]
            logger.info("[BROWSER] Connected to Browserbase cloud")

        elif self.config.mode == BrowserMode.STEEL:
            ws = f"wss://connect.steel.dev?apiKey={self.config.steel_api_key}"
            self._browser = await self._pw.chromium.connect_over_cdp(ws)
            self._context = self._browser.contexts[0]
            self._page    = self._context.pages[0]
            logger.info("[BROWSER] Connected to Steel cloud")

        else:
            args = [
                "--no-sandbox", "--disable-dev-shm-usage",
                "--disable-gpu", "--window-size=1280,900",
            ]
            if self.config.stealth:
                args += [
                    "--disable-blink-features=AutomationControlled",
                    "--disable-automation",
                    "--exclude-switches=enable-automation",
                ]
            launch_kw: dict = dict(
                headless=self.config.headless,
                args=args,
                slow_mo=self.config.slow_mo_ms,
            )
            if self.config.browser_executable:
                launch_kw["executable_path"] = self.config.browser_executable
            if self.config.proxy:
                launch_kw["proxy"] = {"server": self.config.proxy}

            self._browser = await self._pw.chromium.launch(**launch_kw)

            ctx_kw: dict = dict(
                viewport={"width": self.config.viewport_width,
                          "height": self.config.viewport_height},
                accept_downloads=True,
            )
            if self.config.user_agent:
                ctx_kw["user_agent"] = self.config.user_agent
            if self.config.record_video:
                os.makedirs(self.config.video_dir, exist_ok=True)
                ctx_kw["record_video_dir"] = self.config.video_dir

            self._context = await self._browser.new_context(**ctx_kw)

            if self.config.stealth:
                await self._context.add_init_script("""
                    Object.defineProperty(navigator,'webdriver',{get:()=>false});
                    Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
                    Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
                    window.chrome={runtime:{}};
                """)

            self._page = await self._context.new_page()
            self._page.set_default_timeout(self.config.action_timeout_ms)
            self._page.set_default_navigation_timeout(self.config.nav_timeout_ms)

            if self.config.intercept_requests or self.config.block_resources:
                await self._setup_network_intercept()

            logger.info("[BROWSER] Launched headless Chromium")

        self._pages = [self._page]

    async def stop(self):
        if self._mock:
            return
        try:
            if self._browser:
                await self._browser.close()
            if self._pw:
                await self._pw.stop()
        except Exception as e:
            logger.warning(f"[BROWSER] Stop error: {e}")

    # ── Navigation ────────────────────────────────────────────────────────

    async def navigate(self, url: str, wait_until: str = "domcontentloaded") -> dict:
        if self._mock:
            return {"status": 200, "url": url, "title": "Mock Page", "elements_found": 5}
        try:
            resp = await self._page.goto(url, wait_until=wait_until)
            try:
                await self._page.wait_for_load_state("networkidle", timeout=4000)
            except Exception:
                pass
            state = await self.observe()
            return {
                "status": resp.status if resp else 200,
                "url": self._page.url,
                "title": state.title,
                "elements_found": len(state.interactive),
            }
        except Exception as e:
            logger.warning(f"[BROWSER] navigate error: {e}")
            return {"status": "error", "error": str(e), "url": url}

    async def go_back(self) -> dict:
        if self._mock:
            return {"status": "mock"}
        await self._page.go_back()
        return {"url": self._page.url}

    async def go_forward(self) -> dict:
        if self._mock:
            return {"status": "mock"}
        await self._page.go_forward()
        return {"url": self._page.url}

    async def reload(self) -> dict:
        if self._mock:
            return {"status": "mock"}
        await self._page.reload()
        return {"url": self._page.url}

    # ── Core Act — DOM-first with vision fallback ─────────────────────────

    async def act(self, instruction: str, use_vision: bool = False) -> dict:
        if self._mock:
            return {"status": "mock_act", "instruction": instruction}

        # Try cached selector first
        cached = self._sel_cache.get(instruction)
        if cached:
            result = await self._execute_selector(cached, instruction)
            if result["status"] == "success":
                return result
            del self._sel_cache[instruction]  # stale — remove

        state = await self.observe()

        if use_vision:
            return await self._vision_act(instruction, state)

        element = await self._resolve_element(instruction, state)
        if not element:
            if self.config.screenshot_on_fail:
                await self.screenshot()
            # Auto-fallback to vision if DOM resolution fails
            logger.info(f"[BROWSER] DOM resolution failed for '{instruction}' — trying vision")
            return await self._vision_act(instruction, state)

        sel    = element.get("selector", "")
        result = await self._execute_selector(sel, instruction, element)
        if result["status"] == "success":
            self._sel_cache[instruction] = sel
        return result

    async def _execute_selector(
        self, selector: str, instruction: str, element: dict | None = None
    ) -> dict:
        if self._mock:
            return {"status": "success"}
        try:
            el   = self._page.locator(selector).first
            kind = (element or {}).get("type", "click")
            fill = (element or {}).get("fill_value", "")
            if kind == "input" and fill:
                await el.clear()
                await el.fill(fill)
            elif kind == "select":
                value = (element or {}).get("option_value", "")
                await el.select_option(value=value)
            else:
                await el.click()
            await asyncio.sleep(0.25)
            return {"status": "success", "selector": selector, "action": kind}
        except Exception as e:
            return {"status": "failed", "selector": selector, "error": str(e)}

    async def _resolve_element(self, instruction: str, state: PageState) -> dict | None:
        """Mini LLM call to map natural-language → DOM selector."""
        from core.agent_engine import LLMProvider
        provider = LLMProvider("fast")
        prompt = (
            f"Instruction: '{instruction}'\n"
            f"Interactive elements:\n{json.dumps(state.interactive[:50], indent=2)}\n\n"
            "Return ONLY JSON (no markdown):\n"
            '{"selector":"<css/aria>","type":"click|input|select|submit","fill_value":"<if input>","option_value":"<if select>"}'
        )
        raw, _ = await provider.complete(
            messages=[{"role": "user", "content": prompt}],
            system="Map instructions to DOM selectors. Return only JSON.",
            max_tokens=150,
        )
        try:
            return json.loads(raw.strip().lstrip("```json").rstrip("```").strip())
        except Exception:
            return None

    async def _vision_act(self, instruction: str, state: PageState) -> dict:
        """
        Full vision act: take screenshot, pass to Claude vision,
        get pixel coordinates, click.
        """
        if self._mock:
            return {"status": "mock_vision_act"}
        b64 = await self.screenshot()
        if not b64:
            return {"status": "error", "error": "screenshot failed"}

        from core.agent_engine import LLMProvider
        import anthropic

        try:
            client = anthropic.AsyncAnthropic()
            resp = await client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=200,
                messages=[{
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/png", "data": b64},
                        },
                        {
                            "type": "text",
                            "text": (
                                f"Find the element to: '{instruction}'\n"
                                f"Page is {self.config.viewport_width}x{self.config.viewport_height}px.\n"
                                'Return ONLY JSON: {"x":<int>,"y":<int>,"confidence":0.0-1.0,"description":"<what you found>"}'
                            ),
                        },
                    ],
                }],
            )
            raw = resp.content[0].text if resp.content else ""
            coords = json.loads(raw.strip().lstrip("```json").rstrip("```").strip())
            x, y   = int(coords["x"]), int(coords["y"])
            conf   = float(coords.get("confidence", 0.5))

            if conf < 0.3:
                return {"status": "low_confidence", "confidence": conf, "coords": [x, y]}

            await self._page.mouse.click(x, y)
            await asyncio.sleep(0.3)
            return {
                "status": "success", "method": "vision",
                "coords": [x, y], "confidence": conf,
                "description": coords.get("description", ""),
            }
        except ImportError:
            return {"status": "error", "error": "anthropic SDK not installed"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    # ── Extraction ────────────────────────────────────────────────────────

    async def extract(self, schema: dict, description: str = "") -> dict:
        if self._mock:
            return {k: f"mock_{k}" for k in schema}
        state = await self.observe()
        from core.agent_engine import LLMProvider
        provider = LLMProvider("fast")
        prompt = (
            f"Extract these fields from the page.\n"
            f"Schema: {json.dumps(schema)}\n"
            f"Goal: {description}\n\n"
            f"{state.to_context()}\n\n"
            "Return ONLY valid JSON with schema fields filled."
        )
        raw, _ = await provider.complete(
            messages=[{"role": "user", "content": prompt}],
            system="Extract structured data from web pages. Return only JSON.",
            max_tokens=1200,
        )
        try:
            return json.loads(raw.strip().lstrip("```json").rstrip("```").strip())
        except Exception:
            return {"_raw": raw, "_error": "parse_failed"}

    async def extract_table(self, selector: str = "table") -> list[dict]:
        """Extract an HTML table as list of dicts."""
        if self._mock:
            return [{"col1": "val1", "col2": "val2"}]
        try:
            script = f"""
            () => {{
                const table = document.querySelector('{selector}');
                if (!table) return [];
                const headers = [...table.querySelectorAll('th')].map(th => th.innerText.trim());
                return [...table.querySelectorAll('tbody tr')].map(tr => {{
                    const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
                    return Object.fromEntries(headers.map((h,i) => [h, cells[i] || '']));
                }});
            }}
            """
            return await self._page.evaluate(script) or []
        except Exception as e:
            return [{"_error": str(e)}]

    # ── Observe ────────────────────────────────────────────────────────────

    async def observe(self) -> PageState:
        if self._mock:
            return PageState(
                url="https://mock.example.com", title="Mock Page",
                dom_snapshot="[button] Click me\n[link] Go somewhere",
                interactive=[
                    {"id": 0, "tag": "button", "type": "button", "text": "Click me",
                     "selector": "button", "visible": True},
                ]
            )
        try:
            url   = self._page.url
            title = await self._page.title()
            ax    = await self._page.accessibility.snapshot()
            dom   = self._ax_to_text(ax)
            inter = await self._get_interactive_elements()
            return PageState(
                url=url, title=title,
                dom_snapshot=dom, interactive=inter,
                network_log=self._net_log[-20:],
            )
        except Exception as e:
            return PageState(url="error", title="error", dom_snapshot=str(e))

    # ── Screenshot ─────────────────────────────────────────────────────────

    async def screenshot(self, full_page: bool = False, save_path: str = "") -> str:
        if self._mock:
            return "bW9ja19zY3JlZW5zaG90"
        try:
            png = await self._page.screenshot(
                full_page=full_page,
                type="png",
            )
            if save_path:
                with open(save_path, "wb") as f:
                    f.write(png)
            return base64.b64encode(png).decode()
        except Exception as e:
            logger.warning(f"[BROWSER] screenshot error: {e}")
            return ""

    # ── Input actions ─────────────────────────────────────────────────────

    async def scroll(self, direction: str = "down", pixels: int = 600) -> dict:
        if self._mock:
            return {"status": "mock_scroll"}
        dy = pixels if direction == "down" else (-pixels if direction == "up" else 0)
        dx = pixels if direction == "right" else (-pixels if direction == "left" else 0)
        await self._page.mouse.wheel(dx, dy)
        await asyncio.sleep(0.3)
        return {"status": "scrolled", "direction": direction, "pixels": pixels}

    async def scroll_to_element(self, selector: str) -> dict:
        if self._mock:
            return {"status": "mock"}
        try:
            el = self._page.locator(selector).first
            await el.scroll_into_view_if_needed()
            return {"status": "success"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    async def type_text(self, selector: str, text: str, clear_first: bool = True,
                        press_enter: bool = False) -> dict:
        if self._mock:
            return {"status": "mock_type"}
        try:
            el = self._page.locator(selector).first
            if clear_first:
                await el.clear()
            await el.fill(text)
            if press_enter:
                await el.press("Enter")
            return {"status": "typed", "chars": len(text)}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    async def press_key(self, key: str) -> dict:
        """Press a keyboard key. e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown'"""
        if self._mock:
            return {"status": "mock_key"}
        await self._page.keyboard.press(key)
        return {"status": "pressed", "key": key}

    async def hover(self, selector: str) -> dict:
        if self._mock:
            return {"status": "mock_hover"}
        try:
            await self._page.locator(selector).first.hover()
            await asyncio.sleep(0.2)
            return {"status": "hovered", "selector": selector}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    async def drag(self, from_selector: str, to_selector: str) -> dict:
        if self._mock:
            return {"status": "mock_drag"}
        try:
            src  = self._page.locator(from_selector).first
            dest = self._page.locator(to_selector).first
            await src.drag_to(dest)
            return {"status": "dragged"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    async def select_option(self, selector: str, value: str = "",
                            label: str = "", index: int = -1) -> dict:
        if self._mock:
            return {"status": "mock_select"}
        try:
            el = self._page.locator(selector).first
            if value:
                await el.select_option(value=value)
            elif label:
                await el.select_option(label=label)
            elif index >= 0:
                await el.select_option(index=index)
            return {"status": "selected", "value": value or label}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    async def upload_file(self, selector: str, file_path: str) -> dict:
        if self._mock:
            return {"status": "mock_upload"}
        try:
            await self._page.locator(selector).first.set_input_files(file_path)
            return {"status": "uploaded", "file": file_path}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    async def download_file(self, selector: str) -> dict:
        """Click a download link and save the file."""
        if self._mock:
            return {"status": "mock_download"}
        try:
            os.makedirs(self.config.downloads_dir, exist_ok=True)
            async with self._page.expect_download() as dl_info:
                await self._page.locator(selector).first.click()
            download = await dl_info.value
            save_path = os.path.join(self.config.downloads_dir, download.suggested_filename)
            await download.save_as(save_path)
            return {"status": "downloaded", "path": save_path,
                    "filename": download.suggested_filename}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    # ── Wait ──────────────────────────────────────────────────────────────

    async def wait_for(self, condition: str, timeout_ms: int = 8000) -> dict:
        if self._mock:
            return {"status": "mock_wait"}
        try:
            if condition == "networkidle":
                await self._page.wait_for_load_state("networkidle", timeout=timeout_ms)
            elif condition.startswith("text="):
                text = condition[5:]
                await self._page.wait_for_function(
                    f"document.body.innerText.includes('{text}')", timeout=timeout_ms
                )
            elif condition.startswith("url="):
                await self._page.wait_for_url(condition[4:], timeout=timeout_ms)
            else:
                await self._page.wait_for_selector(condition,
                                                    state="visible", timeout=timeout_ms)
            return {"status": "ready", "condition": condition}
        except Exception as e:
            return {"status": "timeout", "error": str(e)}

    # ── Multi-tab ─────────────────────────────────────────────────────────

    async def new_tab(self, url: str = "") -> dict:
        if self._mock:
            return {"status": "mock_tab", "tab_index": 1}
        page = await self._context.new_page()
        self._pages.append(page)
        idx = len(self._pages) - 1
        if url:
            await page.goto(url)
        return {"status": "opened", "tab_index": idx, "url": url}

    async def switch_tab(self, tab_index: int) -> dict:
        if self._mock:
            return {"status": "mock_switch"}
        if 0 <= tab_index < len(self._pages):
            self._page = self._pages[tab_index]
            await self._page.bring_to_front()
            return {"status": "switched", "tab_index": tab_index,
                    "url": self._page.url}
        return {"status": "error", "error": f"Tab {tab_index} does not exist"}

    async def close_tab(self, tab_index: int) -> dict:
        if self._mock:
            return {"status": "mock_close"}
        if 0 <= tab_index < len(self._pages):
            await self._pages[tab_index].close()
            self._pages.pop(tab_index)
            if self._pages:
                self._page = self._pages[-1]
            return {"status": "closed", "tabs_remaining": len(self._pages)}
        return {"status": "error", "error": "invalid tab index"}

    async def list_tabs(self) -> dict:
        if self._mock:
            return {"tabs": [{"index": 0, "url": "https://mock.example.com", "title": "Mock"}]}
        tabs = []
        for i, p in enumerate(self._pages):
            try:
                tabs.append({"index": i, "url": p.url, "title": await p.title()})
            except Exception:
                tabs.append({"index": i, "url": "closed", "title": "closed"})
        return {"tabs": tabs, "active": self._pages.index(self._page) if self._page in self._pages else 0}

    # ── JavaScript & iframes ──────────────────────────────────────────────

    async def evaluate_js(self, script: str) -> Any:
        if self._mock:
            return None
        try:
            return await self._page.evaluate(script)
        except Exception as e:
            return {"error": str(e)}

    async def evaluate_in_frame(self, frame_selector: str, script: str) -> Any:
        """Run JS inside an iframe."""
        if self._mock:
            return None
        try:
            frame = self._page.frame_locator(frame_selector)
            return await frame.locator("body").evaluate(script)
        except Exception as e:
            return {"error": str(e)}

    # ── Cookies & Storage ──────────────────────────────────────────────────

    async def get_cookies(self) -> list[dict]:
        if self._mock:
            return []
        return await self._context.cookies()

    async def set_cookies(self, cookies: list[dict]) -> dict:
        if self._mock:
            return {"status": "mock"}
        await self._context.add_cookies(cookies)
        return {"status": "set", "count": len(cookies)}

    async def clear_cookies(self) -> dict:
        if self._mock:
            return {"status": "mock"}
        await self._context.clear_cookies()
        return {"status": "cleared"}

    async def get_local_storage(self, key: str = "") -> Any:
        if self._mock:
            return None
        script = f"localStorage.getItem('{key}')" if key else \
                 "Object.fromEntries(Object.entries(localStorage))"
        return await self._page.evaluate(script)

    async def get_page_source(self) -> str:
        if self._mock:
            return "<html><body>mock</body></html>"
        return await self._page.content()

    # ── Network intercept ─────────────────────────────────────────────────

    async def _setup_network_intercept(self):
        block = set(self.config.block_resources)

        async def handle_route(route, request):
            rtype = request.resource_type
            if rtype in block:
                await route.abort()
            else:
                if self.config.intercept_requests:
                    self._net_log.append({
                        "url": request.url[:120],
                        "method": request.method,
                        "type": rtype,
                        "ts": time.time(),
                    })
                await route.continue_()

        await self._page.route("**/*", handle_route)
        logger.info(f"[BROWSER] Network intercept active | blocking: {block}")

    # ── Private helpers ───────────────────────────────────────────────────

    async def _get_interactive_elements(self) -> list[dict]:
        try:
            script = """
            () => {
                const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [onclick], [tabindex="0"]';
                const els = Array.from(document.querySelectorAll(sel)).slice(0, 70);
                return els.map((el, i) => {
                    const rect = el.getBoundingClientRect();
                    const visible = rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
                    const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 90);
                    let sel = '';
                    if (el.id) sel = '#' + CSS.escape(el.id);
                    else if (el.getAttribute('data-testid')) sel = `[data-testid="${el.getAttribute('data-testid')}"]`;
                    else if (el.name) sel = `[name="${el.name}"]`;
                    else if (el.className) sel = el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/)[0];
                    else sel = el.tagName.toLowerCase();
                    return {id:i, tag:el.tagName.toLowerCase(), type:el.type||el.tagName.toLowerCase(),
                            text, selector:sel, href:el.href||'', visible,
                            x:Math.round(rect.x), y:Math.round(rect.y)};
                }).filter(e => e.visible && e.text);
            }
            """
            return await self._page.evaluate(script) or []
        except Exception:
            return []

    def _ax_to_text(self, node: dict | None, depth: int = 0) -> str:
        if not node or depth > 8:
            return ""
        indent = "  " * depth
        role   = node.get("role", "")
        name   = node.get("name", "")
        value  = node.get("value", "")
        line   = f"{indent}[{role}] {name}"
        if value:
            line += f" = {value}"
        children = node.get("children", [])[:15]
        child_text = "\n".join(
            c for c in (self._ax_to_text(ch, depth + 1) for ch in children) if c
        )
        return f"{line}\n{child_text}" if child_text else line


# ─────────────────────────────────────────────
# Browser Bot Agent
# ─────────────────────────────────────────────

class BrowserBotAgent:
    """
    Full autonomous browser agent.
    BrowserSession + ReActEngine + all tools registered.
    """

    def __init__(
        self,
        browser_config:      BrowserConfig | None = None,
        model_alias:         str = "claude",
        session_token_limit: int = 200_000,
        iteration_limit:     int = 25,
        on_step:             Any = None,
    ):
        from core.agent_engine import ToolRegistry, LLMProvider, BudgetState, ReActEngine
        self.browser  = BrowserSession(browser_config or BrowserConfig())
        self.registry = ToolRegistry()
        self.provider = LLMProvider(model_alias)
        self.budget   = BudgetState(
            session_limit   = session_token_limit,
            iteration_limit = iteration_limit,
        )
        self.engine = ReActEngine(
            registry = self.registry,
            provider = self.provider,
            budget   = self.budget,
            on_step  = on_step,
        )
        self._register_all_tools()

    def _register_all_tools(self):
        r = self.registry
        b = self.browser

        r.register("navigate", b.navigate, {
            "name": "navigate", "description": "Navigate to a URL",
            "parameters": {"type": "object", "required": ["url"], "properties": {
                "url": {"type": "string"},
                "wait_until": {"type": "string", "enum": ["load","domcontentloaded","networkidle"]},
            }},
        }, timeout_s=35.0)

        r.register("act", b.act, {
            "name": "act",
            "description": "Natural-language browser action: click, fill, submit, check, etc.",
            "parameters": {"type": "object", "required": ["instruction"], "properties": {
                "instruction": {"type": "string"},
                "use_vision":  {"type": "boolean"},
            }},
        }, timeout_s=20.0)

        r.register("extract", b.extract, {
            "name": "extract", "description": "Extract structured data from current page",
            "parameters": {"type": "object", "required": ["schema"], "properties": {
                "schema":      {"type": "object"},
                "description": {"type": "string"},
            }},
        }, timeout_s=30.0)

        r.register("extract_table", b.extract_table, {
            "name": "extract_table", "description": "Extract HTML table as list of dicts",
            "parameters": {"type": "object", "properties": {
                "selector": {"type": "string"},
            }},
        })

        r.register("observe", lambda: b.observe(), {
            "name": "observe", "description": "Snapshot current page: URL, title, interactive elements",
            "parameters": {"type": "object", "properties": {}},
        })

        r.register("screenshot", b.screenshot, {
            "name": "screenshot", "description": "Take screenshot, returns base64 PNG",
            "parameters": {"type": "object", "properties": {
                "full_page": {"type": "boolean"},
                "save_path": {"type": "string"},
            }},
        })

        r.register("scroll", b.scroll, {
            "name": "scroll", "description": "Scroll the page",
            "parameters": {"type": "object", "properties": {
                "direction": {"type": "string", "enum": ["up","down","left","right"]},
                "pixels":    {"type": "integer"},
            }},
        })

        r.register("scroll_to_element", b.scroll_to_element, {
            "name": "scroll_to_element", "description": "Scroll element into view",
            "parameters": {"type": "object", "required": ["selector"], "properties": {
                "selector": {"type": "string"},
            }},
        })

        r.register("type_text", b.type_text, {
            "name": "type_text", "description": "Type text into a CSS-selector element",
            "parameters": {"type": "object", "required": ["selector","text"], "properties": {
                "selector":    {"type": "string"},
                "text":        {"type": "string"},
                "clear_first": {"type": "boolean"},
                "press_enter": {"type": "boolean"},
            }},
        })

        r.register("press_key", b.press_key, {
            "name": "press_key", "description": "Press keyboard key: Enter, Escape, Tab, ArrowDown, etc.",
            "parameters": {"type": "object", "required": ["key"], "properties": {
                "key": {"type": "string"},
            }},
        })

        r.register("hover", b.hover, {
            "name": "hover", "description": "Hover over an element",
            "parameters": {"type": "object", "required": ["selector"], "properties": {
                "selector": {"type": "string"},
            }},
        })

        r.register("drag", b.drag, {
            "name": "drag", "description": "Drag one element to another",
            "parameters": {"type": "object", "required": ["from_selector","to_selector"], "properties": {
                "from_selector": {"type": "string"},
                "to_selector":   {"type": "string"},
            }},
        })

        r.register("select_option", b.select_option, {
            "name": "select_option", "description": "Select a dropdown option",
            "parameters": {"type": "object", "required": ["selector"], "properties": {
                "selector": {"type": "string"},
                "value":    {"type": "string"},
                "label":    {"type": "string"},
                "index":    {"type": "integer"},
            }},
        })

        r.register("wait_for", b.wait_for, {
            "name": "wait_for",
            "description": "Wait for: selector, 'text=<text>', 'url=<url>', or 'networkidle'",
            "parameters": {"type": "object", "required": ["condition"], "properties": {
                "condition":  {"type": "string"},
                "timeout_ms": {"type": "integer"},
            }},
        })

        r.register("evaluate_js", b.evaluate_js, {
            "name": "evaluate_js", "description": "Execute JavaScript in the page context",
            "parameters": {"type": "object", "required": ["script"], "properties": {
                "script": {"type": "string"},
            }},
        })

        r.register("get_page_source", b.get_page_source, {
            "name": "get_page_source", "description": "Get full HTML source of current page",
            "parameters": {"type": "object", "properties": {}},
        })

        r.register("new_tab", b.new_tab, {
            "name": "new_tab", "description": "Open a new browser tab",
            "parameters": {"type": "object", "properties": {
                "url": {"type": "string"},
            }},
        })

        r.register("switch_tab", b.switch_tab, {
            "name": "switch_tab", "description": "Switch to a tab by index",
            "parameters": {"type": "object", "required": ["tab_index"], "properties": {
                "tab_index": {"type": "integer"},
            }},
        })

        r.register("list_tabs", b.list_tabs, {
            "name": "list_tabs", "description": "List all open tabs",
            "parameters": {"type": "object", "properties": {}},
        })

        r.register("go_back",    b.go_back,    {"name":"go_back","description":"Browser back","parameters":{"type":"object","properties":{}}})
        r.register("go_forward", b.go_forward, {"name":"go_forward","description":"Browser forward","parameters":{"type":"object","properties":{}}})
        r.register("reload",     b.reload,     {"name":"reload","description":"Reload page","parameters":{"type":"object","properties":{}}})

        r.register("get_cookies", b.get_cookies, {
            "name": "get_cookies", "description": "Get all cookies for current session",
            "parameters": {"type": "object", "properties": {}},
        })

        r.register("set_cookies", b.set_cookies, {
            "name": "set_cookies", "description": "Set cookies for auth/session",
            "parameters": {"type": "object", "required": ["cookies"], "properties": {
                "cookies": {"type": "array", "items": {"type": "object"}},
            }},
        })

        r.register("download_file", b.download_file, {
            "name": "download_file", "description": "Click a download link and save file",
            "parameters": {"type": "object", "required": ["selector"], "properties": {
                "selector": {"type": "string"},
            }},
        })

        r.register("upload_file", b.upload_file, {
            "name": "upload_file", "description": "Upload a file via file input element",
            "parameters": {"type": "object", "required": ["selector","file_path"], "properties": {
                "selector":  {"type": "string"},
                "file_path": {"type": "string"},
            }},
        })

    async def run(self, task: str, start_url: str = "", save_session: bool = False) -> dict:
        await self.browser.start()
        try:
            context = {}
            if start_url:
                result = await self.browser.navigate(start_url)
                context["start_page"] = result

            from core.agent_engine import AgentSession
            session = await self.engine.run(
                task, context=context,
                tags=["browser"],
                save_session=save_session,
            )
            return {
                "session_id":  session.session_id,
                "status":      session.phase.value,
                "result":      session.final_result,
                "steps":       len(session.steps),
                "duration_s":  session.duration_s(),
                "cost_usd":    session.budget.cost_usd,
                "tokens_used": session.budget.total_used,
                "model":       self.provider.model,
            }
        finally:
            await self.browser.stop()

    async def __aenter__(self):
        await self.browser.start()
        return self

    async def __aexit__(self, *_):
        await self.browser.stop()

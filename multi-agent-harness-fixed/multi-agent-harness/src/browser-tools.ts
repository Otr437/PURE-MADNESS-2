// src/browser-tools.ts
// Playwright browser tools — headless, Merkle-logged, security-gated.
// Every tool validated through SecurityMiddleware before execution.

import { tool } from "ai";
import { z } from "zod";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { MerkleLog } from "./merkle-log.js";
import { SecurityMiddleware } from "./security-middleware.js";

let browser:  Browser        | null = null;
let context:  BrowserContext | null = null;
let page:     Page           | null = null;
let _merkle:  MerkleLog      | null = null;
let _mw:      SecurityMiddleware | null = null;

export function getMerkleLog(): MerkleLog {
  if (!_merkle) throw new Error("Browser not initialised.");
  return _merkle;
}

export async function initBrowser(
  merkle: MerkleLog,
  mw: SecurityMiddleware,
  channel: "chromium" | "chrome" | "msedge" = "chromium"
) {
  _merkle = merkle;
  _mw     = mw;

  browser = await chromium.launch({
    headless: true,
    channel:  channel === "chromium" ? undefined : channel,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  context = await browser.newContext({
    userAgent:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport:   { width: 1280, height: 800 },
    locale:     "en-US",
    javaScriptEnabled: true,
  });

  page = await context.newPage();

  // Block trackers / ads for privacy + speed
  await page.route("**/(ads|analytics|tracking|doubleclick|facebook|google-analytics|hotjar|mixpanel)**",
    route => route.abort()
  );

  merkle.append("browser:init", { channel }, { ok: true });
  console.log(`[browser] launched (headless, ${channel})`);
}

export async function closeBrowser() {
  _merkle?.append("browser:close", {}, { ok: true });
  await browser?.close();
  browser = context = page = null;
}

function getPage(): Page {
  if (!page) throw new Error("Browser not initialised.");
  return page;
}

function mw(): SecurityMiddleware {
  if (!_mw) throw new Error("SecurityMiddleware not initialised.");
  return _mw;
}

function log(): MerkleLog {
  if (!_merkle) throw new Error("MerkleLog not initialised.");
  return _merkle;
}

function logged<TArgs extends Record<string, unknown>>(
  toolName: string,
  fn: (args: TArgs) => Promise<unknown>
) {
  return async (args: TArgs) => {
    const result = await fn(args);
    log().append(toolName, args, result);
    return result;
  };
}

export const browserTools = {

  navigate: tool({
    description: "Navigate the browser to a URL.",
    parameters: z.object({ url: z.string() }),
    execute: logged("navigate", async ({ url }) => {
      const gate = mw().browserNavigate({ url });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const p = getPage();
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        return { ok: true, title: await p.title(), url: p.url() };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  click: tool({
    description: "Click a button, link, or element described in plain English.",
    parameters: z.object({ description: z.string() }),
    execute: logged("click", async ({ description }) => {
      const gate = mw().browserClick({ description });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const p = getPage();
        for (const s of [
          () => p.getByRole("button", { name: new RegExp(description, "i") }).first(),
          () => p.getByRole("link",   { name: new RegExp(description, "i") }).first(),
          () => p.getByText(new RegExp(description, "i")).first(),
          () => p.getByLabel(new RegExp(description, "i")).first(),
        ]) {
          try {
            const el = s();
            if (await el.isVisible({ timeout: 2_000 })) { await el.click(); return { ok: true, clicked: description }; }
          } catch { /* try next */ }
        }
        return { ok: false, error: `Not found: "${description}"` };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  type_text: tool({
    description: "Type text into a field.",
    parameters: z.object({ field: z.string(), text: z.string(), press_enter: z.boolean().default(false) }),
    execute: logged("type_text", async ({ field, text, press_enter }) => {
      const gate = mw().browserTypeText({ field, text, press_enter });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const p = getPage();
        for (const s of [
          () => p.getByRole("searchbox").first(),
          () => p.getByRole("textbox", { name: new RegExp(field, "i") }).first(),
          () => p.getByLabel(new RegExp(field, "i")).first(),
          () => p.getByPlaceholder(new RegExp(field, "i")).first(),
          () => p.locator("input[type=text], input[type=search], textarea").first(),
        ]) {
          try {
            const el = s();
            if (await el.isVisible({ timeout: 2_000 })) {
              await el.fill(text);
              if (press_enter) await el.press("Enter");
              return { ok: true, typed: text, field };
            }
          } catch { /* try next */ }
        }
        return { ok: false, error: `Field not found: "${field}"` };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  read_page: tool({
    description: "Read visible text from the current page.",
    parameters: z.object({ selector: z.string().optional() }),
    execute: logged("read_page", async ({ selector }) => {
      const gate = mw().browserReadPage({ selector });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const p    = getPage();
        const text = selector
          ? await p.locator(selector).first().innerText({ timeout: 5_000 })
          : await p.evaluate(() => document.body.innerText);
        return { ok: true, text: text.replace(/\s+/g, " ").trim().slice(0, 4000), url: p.url() };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  screenshot: tool({
    description: "Take a screenshot and save as PNG.",
    parameters: z.object({ filename: z.string().default("screenshot.png") }),
    execute: logged("screenshot", async ({ filename }) => {
      const gate = mw().browserScreenshot({ filename });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const p    = getPage();
        const path = filename.endsWith(".png") ? filename : `${filename}.png`;
        await p.screenshot({ path, fullPage: false });
        return { ok: true, saved: path };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  scroll: tool({
    description: "Scroll the page up or down.",
    parameters: z.object({ direction: z.enum(["up", "down"]), amount: z.number().default(500) }),
    execute: logged("scroll", async ({ direction, amount }) => {
      const gate = mw().browserScroll({ direction, amount });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        await getPage().evaluate((y) => window.scrollBy(0, y), direction === "down" ? amount : -amount);
        return { ok: true, scrolled: `${direction} ${amount}px` };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  navigate_history: tool({
    description: "Go back or forward in browser history.",
    parameters: z.object({ direction: z.enum(["back", "forward"]) }),
    execute: logged("navigate_history", async ({ direction }) => {
      const gate = mw().browserHistory({ direction });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const p = getPage();
        if (direction === "back") await p.goBack(); else await p.goForward();
        return { ok: true, direction, url: p.url() };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  wait_for: tool({
    description: "Wait for text to appear on the page.",
    parameters: z.object({ text: z.string(), timeout_ms: z.number().default(8000) }),
    execute: logged("wait_for", async ({ text, timeout_ms }) => {
      const gate = mw().browserWaitFor({ text, timeout_ms });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        await getPage().getByText(new RegExp(text, "i")).first().waitFor({ timeout: timeout_ms });
        return { ok: true, found: text };
      } catch { return { ok: false, error: `Timed out: "${text}"` }; }
    }),
  }),

  page_info: tool({
    description: "Get current page URL and title.",
    parameters: z.object({}),
    execute: logged("page_info", async (args) => {
      const gate = mw().browserPageInfo(args);
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const p = getPage();
        return { ok: true, url: p.url(), title: await p.title() };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  extract: tool({
    description: "Extract specific data from the page.",
    parameters: z.object({ target: z.string(), selector: z.string().optional() }),
    execute: logged("extract", async ({ target, selector }) => {
      const gate = mw().browserExtract({ target, selector });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const p     = getPage();
        const scope = selector ? p.locator(selector) : p.locator("body");
        const text  = await scope.innerText({ timeout: 5_000 });
        return { ok: true, target, raw: text.replace(/\s+/g, " ").trim().slice(0, 3000), url: p.url() };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  run_js: tool({
    description: "Run JavaScript on the page and return the result.",
    parameters: z.object({ code: z.string() }),
    execute: logged("run_js", async ({ code }) => {
      const gate = mw().browserRunJs({ code });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        return { ok: true, result: await getPage().evaluate(code) };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  select_option: tool({
    description: "Select an option from a dropdown.",
    parameters: z.object({ field: z.string(), value: z.string() }),
    execute: logged("select_option", async ({ field, value }) => {
      const gate = mw().browserSelectOption({ field, value });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        await getPage().getByLabel(new RegExp(field, "i")).first().selectOption({ label: value });
        return { ok: true, selected: value };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  check_box: tool({
    description: "Check or uncheck a checkbox.",
    parameters: z.object({ label: z.string(), checked: z.boolean().default(true) }),
    execute: logged("check_box", async ({ label, checked }) => {
      const gate = mw().browserCheckBox({ label, checked });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        const el = getPage().getByLabel(new RegExp(label, "i")).first();
        if (checked) await el.check(); else await el.uncheck();
        return { ok: true, label, checked };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),

  hover: tool({
    description: "Hover over an element.",
    parameters: z.object({ description: z.string() }),
    execute: logged("hover", async ({ description }) => {
      const gate = mw().browserHover({ description });
      if (!gate.allowed) return { ok: false, error: gate.reason };
      try {
        await getPage().getByText(new RegExp(description, "i")).first().hover();
        return { ok: true, hovered: description };
      } catch (err) { return { ok: false, error: String(err) }; }
    }),
  }),
};

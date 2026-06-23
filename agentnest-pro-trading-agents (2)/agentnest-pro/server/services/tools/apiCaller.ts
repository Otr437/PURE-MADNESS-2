/**
 * apiCaller tool — makes outbound HTTP calls on behalf of an agent.
 * Enforces: explicit timeout, safe method restrictions, response size cap.
 * Used by DevOps, Crypto Analyst, OSINT agents.
 */

import { registerTool, type ToolResult } from "./index.js";

const TIMEOUT_MS      = 10_000;
const MAX_BODY_BYTES  = 50_000;

const BLOCKED_HOSTS = [
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "169.254.169.254", // AWS metadata
  "metadata.google.internal",
];

function isBlockedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return BLOCKED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
  } catch {
    return true; // unparseable URL is blocked
  }
}

registerTool({
  name:        "apiCaller",
  description: "Make an HTTP request to an external API and return the response. Use for fetching live data: crypto prices, CVE databases, domain info, REST APIs.",
  parameters: {
    url:     { type: "string",  description: "Full URL to call (must be https://)", required: true },
    method:  { type: "string",  description: "HTTP method: GET, POST, PUT, DELETE (default: GET)" },
    headers: { type: "object",  description: "Request headers as key/value object" },
    body:    { type: "string",  description: "Request body (for POST/PUT, JSON string)" },
  },

  async execute(args, _taskId, _agentId): Promise<ToolResult> {
    const url    = String(args.url ?? "").trim();
    const method = String(args.method ?? "GET").toUpperCase();

    if (!url) return { success: false, output: "", error: "url is required" };
    if (!url.startsWith("https://")) {
      return { success: false, output: "", error: "Only HTTPS URLs are permitted" };
    }
    if (isBlockedHost(url)) {
      return { success: false, output: "", error: "Request to internal/localhost address is blocked" };
    }
    if (!["GET","POST","PUT","DELETE","PATCH"].includes(method)) {
      return { success: false, output: "", error: `Method ${method} is not permitted` };
    }

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const headersRaw = args.headers && typeof args.headers === "object" ? args.headers as Record<string,string> : {};
      const fetchInit: RequestInit = {
        method,
        signal:  controller.signal,
        headers: { "User-Agent": "AgentNest-Pro/1.0", ...headersRaw },
      };

      if (args.body && ["POST","PUT","PATCH"].includes(method)) {
        fetchInit.body = String(args.body);
        if (!headersRaw["Content-Type"]) {
          (fetchInit.headers as any)["Content-Type"] = "application/json";
        }
      }

      const res = await fetch(url, fetchInit);
      clearTimeout(timeout);

      const contentType = res.headers.get("content-type") ?? "";
      let body: string;

      if (contentType.includes("application/json")) {
        const raw = await res.text();
        body = raw.substring(0, MAX_BODY_BYTES);
        // Pretty-print if it's valid JSON and small enough
        try {
          body = JSON.stringify(JSON.parse(body), null, 2).substring(0, MAX_BODY_BYTES);
        } catch { /* leave as-is */ }
      } else {
        body = (await res.text()).substring(0, MAX_BODY_BYTES);
      }

      if (!res.ok) {
        return {
          success: false,
          output:  body,
          error:   `HTTP ${res.status} ${res.statusText}`,
        };
      }

      return { success: true, output: body };

    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        return { success: false, output: "", error: `apiCaller timed out after ${TIMEOUT_MS}ms` };
      }
      return { success: false, output: "", error: `apiCaller failed: ${err.message}` };
    }
  },
});

/**
 * splunkSearch tool — executes SPL searches against the Splunk REST API.
 *
 * Supports both one-shot searches (small result sets) and job-based
 * searches for larger queries. Handles authentication via Splunk token
 * stored in settings (SPLUNK_TOKEN) with basic-auth fallback
 * (SPLUNK_USERNAME / SPLUNK_PASSWORD).
 *
 * Used by: anomaly-detection-agent, incident-response-agent
 */

import { registerTool, type ToolResult } from "./index.js";
import { queries }                        from "../../db/index.js";
import { safeDecryptSetting }             from "../crypto.js";

const TIMEOUT_MS     = 30_000;
const POLL_INTERVAL  = 2_000;
const MAX_POLL_TRIES = 15;   // 30 seconds max wait for search job
const MAX_RESULTS    = 100;

// ─── Config helpers ───────────────────────────────────────────────────────────

function getSplunkBase(): string {
  const row = queries.getSetting.get("SPLUNK_BASE_URL") as any;
  const val = row?.value ? safeDecryptSetting(row.value, row.is_secret) : "";
  return (val || process.env.SPLUNK_BASE_URL || "").replace(/\/$/, "");
}

function getSplunkAuth(): { type: "token" | "basic"; value: string } {
  const tokenRow = queries.getSetting.get("SPLUNK_TOKEN") as any;
  const token    = tokenRow?.value ? safeDecryptSetting(tokenRow.value, tokenRow.is_secret) : (process.env.SPLUNK_TOKEN || "");

  if (token) return { type: "token", value: token };

  const userRow  = queries.getSetting.get("SPLUNK_USERNAME") as any;
  const passRow  = queries.getSetting.get("SPLUNK_PASSWORD") as any;
  const username = userRow?.value ? safeDecryptSetting(userRow.value, userRow.is_secret) : (process.env.SPLUNK_USERNAME || "");
  const password = passRow?.value ? safeDecryptSetting(passRow.value, passRow.is_secret) : (process.env.SPLUNK_PASSWORD || "");

  if (username && password) {
    return { type: "basic", value: Buffer.from(`${username}:${password}`).toString("base64") };
  }

  throw new Error("Splunk credentials not configured. Set SPLUNK_TOKEN (preferred) or SPLUNK_USERNAME + SPLUNK_PASSWORD in Settings.");
}

function authHeader(): Record<string, string> {
  const auth = getSplunkAuth();
  return auth.type === "token"
    ? { Authorization: `Bearer ${auth.value}` }
    : { Authorization: `Basic ${auth.value}` };
}

// ─── Core search logic ────────────────────────────────────────────────────────

/**
 * Run a Splunk search job and poll for results.
 * Returns an array of result objects (each is a key/value record).
 */
async function runSplunkSearch(
  spl:      string,
  earliest: string,
  latest:   string,
  maxCount: number
): Promise<any[]> {
  const base    = getSplunkBase();
  const headers = { ...authHeader(), "Content-Type": "application/x-www-form-urlencoded" };

  // Create the search job
  const createBody = new URLSearchParams({
    search:        spl.startsWith("search ") ? spl : `search ${spl}`,
    earliest_time: earliest,
    latest_time:   latest,
    output_mode:   "json",
    max_count:     String(maxCount),
  });

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let sid: string;
  try {
    const createRes = await fetch(`${base}/services/search/jobs`, {
      method:  "POST",
      headers,
      body:    createBody.toString(),
      signal:  controller.signal,
    });

    if (!createRes.ok) {
      const txt = await createRes.text();
      throw new Error(`Splunk job creation failed (${createRes.status}): ${txt.substring(0, 300)}`);
    }

    const createData = await createRes.json();
    sid = createData?.sid;
    if (!sid) throw new Error("Splunk did not return a search job SID");
  } finally {
    clearTimeout(timer);
  }

  // Poll until the job is done
  let done  = false;
  let tries = 0;

  while (!done && tries < MAX_POLL_TRIES) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    tries++;

    const statusRes = await fetch(
      `${base}/services/search/jobs/${sid}?output_mode=json`,
      { headers: authHeader() }
    );

    if (!statusRes.ok) throw new Error(`Splunk job status check failed (${statusRes.status})`);

    const statusData = await statusRes.json();
    const entry      = statusData?.entry?.[0]?.content;

    if (!entry) throw new Error("Splunk job status response missing entry content");

    if (entry.isFailed)   throw new Error(`Splunk search job failed: ${entry.messages?.[0]?.text ?? "unknown"}`);
    if (entry.isDone)     done = true;
  }

  if (!done) throw new Error(`Splunk search timed out after ${MAX_POLL_TRIES * POLL_INTERVAL / 1000}s`);

  // Fetch results
  const resultsRes = await fetch(
    `${base}/services/search/jobs/${sid}/results?output_mode=json&count=${maxCount}`,
    { headers: authHeader() }
  );

  if (!resultsRes.ok) {
    const txt = await resultsRes.text();
    throw new Error(`Splunk results fetch failed (${resultsRes.status}): ${txt.substring(0, 300)}`);
  }

  const resultsData = await resultsRes.json();
  return resultsData?.results ?? [];
}

// ─── Tool registration ────────────────────────────────────────────────────────

registerTool({
  name:        "splunkSearch",
  description: "Run a Splunk SPL search and return the results. Use this to query logs, detect anomalies, investigate incidents, or pull metrics from Splunk. Always specify a time range using earliest and latest.",
  parameters: {
    spl:      { type: "string", description: "The SPL query to run (do not include the leading 'search' keyword — it is added automatically)", required: true },
    earliest: { type: "string", description: "Earliest time for the search window, in Splunk time format e.g. -1h, -24h, -7d, 2024-01-01T00:00:00 (default: -1h)" },
    latest:   { type: "string", description: "Latest time for the search window (default: now)" },
    maxResults: { type: "number", description: `Maximum number of results to return (default 50, max ${MAX_RESULTS})` },
  },

  async execute(args, _taskId, _agentId): Promise<ToolResult> {
    const spl      = String(args.spl      ?? "").trim();
    const earliest = String(args.earliest ?? "-1h").trim();
    const latest   = String(args.latest   ?? "now").trim();
    const maxCount = Math.min(Number(args.maxResults ?? 50), MAX_RESULTS);

    if (!spl) return { success: false, output: "", error: "spl query is required" };

    let base: string;
    try {
      base = getSplunkBase();
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }

    if (!base) {
      return { success: false, output: "", error: "SPLUNK_BASE_URL is not configured in Settings (e.g. https://splunk.yourcompany.com:8089)" };
    }

    try {
      const results = await runSplunkSearch(spl, earliest, latest, maxCount);

      if (results.length === 0) {
        return {
          success: true,
          output:  `Splunk search returned 0 results for the query in window [${earliest} → ${latest}].`,
        };
      }

      // Format results as a readable table-like block for the LLM
      const formatted = results.map((row: any, i: number) => {
        const fields = Object.entries(row)
          // Drop internal Splunk meta-fields that add noise
          .filter(([k]) => !k.startsWith("_") || k === "_time" || k === "_raw")
          .map(([k, v]) => `  ${k}: ${String(v).substring(0, 200)}`)
          .join("\n");
        return `--- Result ${i + 1} ---\n${fields}`;
      }).join("\n\n");

      return {
        success: true,
        output:  `Splunk returned ${results.length} result(s) [${earliest} → ${latest}]:\n\n${formatted}`,
      };

    } catch (err: any) {
      return { success: false, output: "", error: `splunkSearch failed: ${err.message}` };
    }
  },
});

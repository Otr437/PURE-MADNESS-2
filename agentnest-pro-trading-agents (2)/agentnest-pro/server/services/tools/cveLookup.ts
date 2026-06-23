/**
 * cveLookup tool — queries the NIST NVD CVE API v2 and the CISA Known
 * Exploited Vulnerabilities (KEV) catalog.
 *
 * Supports two modes:
 *   1. Direct CVE ID lookup (e.g. "CVE-2024-12345")
 *   2. Keyword search with severity filter (e.g. "apache log4j", severity >= HIGH)
 *
 * Also cross-references the CISA KEV catalog so agents know whether a
 * vulnerability is actively being exploited in the wild — that is the
 * single most important triage signal for real-world teams.
 *
 * Used by: threat-intel-agent, incident-response-agent
 */

import { registerTool, type ToolResult } from "./index.js";

const NVD_BASE        = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const CISA_KEV_URL    = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const TIMEOUT_MS      = 15_000;
const MAX_NVD_RESULTS = 10;

// CISA KEV is cached in memory for the process lifetime to avoid hammering
// the endpoint on every agent run. TTL: 1 hour.
let kevCache:    Set<string>  = new Set();
let kevCachedAt: number       = 0;
const KEV_TTL_MS              = 60 * 60 * 1000;

async function getKevSet(): Promise<Set<string>> {
  if (kevCache.size > 0 && Date.now() - kevCachedAt < KEV_TTL_MS) {
    return kevCache;
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(CISA_KEV_URL, {
      signal:  controller.signal,
      headers: { "User-Agent": "AgentNest-Pro/1.0 (AIOps threat intel)" },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`CISA KEV fetch failed: ${res.status}`);

    const data: any = await res.json();
    const ids = (data?.vulnerabilities ?? []).map((v: any) => v.cveID as string);
    kevCache    = new Set(ids);
    kevCachedAt = Date.now();
    return kevCache;
  } catch (err: any) {
    clearTimeout(timer);
    // Non-fatal — proceed without KEV data rather than failing the whole lookup
    console.warn("[cveLookup] CISA KEV fetch failed:", err.message);
    return new Set();
  }
}

// ─── NVD parsers ──────────────────────────────────────────────────────────────

interface ParsedCVE {
  id:           string;
  published:    string;
  lastModified: string;
  description:  string;
  cvssV3Score:  number | null;
  cvssV3Vector: string | null;
  severity:     string;           // CRITICAL / HIGH / MEDIUM / LOW / NONE / UNKNOWN
  affectedProducts: string[];
  references:   string[];
  inCisaKev:    boolean;
}

function parseCveItem(item: any, kevSet: Set<string>): ParsedCVE {
  const cve  = item.cve;
  const id   = cve.id ?? "UNKNOWN";

  // Description — prefer English
  const descriptions: any[] = cve.descriptions ?? [];
  const desc = descriptions.find((d: any) => d.lang === "en")?.value
    ?? descriptions[0]?.value
    ?? "No description available.";

  // CVSS v3 score — NVD may provide both primary and secondary metrics
  const metrics    = cve.metrics ?? {};
  const cvssV3List = metrics.cvssMetricV31 ?? metrics.cvssMetricV30 ?? [];
  const primaryV3  = cvssV3List.find((m: any) => m.type === "Primary") ?? cvssV3List[0];

  const cvssScore  = primaryV3?.cvssData?.baseScore  ?? null;
  const cvssVector = primaryV3?.cvssData?.vectorString ?? null;

  // Severity string
  let severity = "UNKNOWN";
  if (cvssScore !== null) {
    if      (cvssScore >= 9.0) severity = "CRITICAL";
    else if (cvssScore >= 7.0) severity = "HIGH";
    else if (cvssScore >= 4.0) severity = "MEDIUM";
    else if (cvssScore >  0.0) severity = "LOW";
    else                       severity = "NONE";
  }

  // Affected products (CPE configurations — flatten to readable strings)
  const configs: any[]         = cve.configurations ?? [];
  const affected: Set<string>  = new Set();

  for (const config of configs) {
    for (const node of (config.nodes ?? [])) {
      for (const match of (node.cpeMatch ?? [])) {
        // CPE 2.3 format: cpe:2.3:a:vendor:product:version:...
        const parts = (match.criteria ?? "").split(":");
        if (parts.length >= 5) {
          const vendor  = parts[3];
          const product = parts[4];
          const version = parts[5] && parts[5] !== "*" ? parts[5] : "any";
          affected.add(`${vendor}/${product} (${version})`);
        }
      }
    }
  }

  // References — top 5 URLs
  const refs: string[] = (cve.references ?? [])
    .slice(0, 5)
    .map((r: any) => r.url)
    .filter(Boolean);

  return {
    id,
    published:        cve.published ?? "",
    lastModified:     cve.lastModified ?? "",
    description:      desc,
    cvssV3Score:      cvssScore,
    cvssV3Vector:     cvssVector,
    severity,
    affectedProducts: [...affected].slice(0, 10),
    references:       refs,
    inCisaKev:        kevSet.has(id),
  };
}

function formatCVE(c: ParsedCVE): string {
  const kevTag = c.inCisaKev ? " ⚠️  IN CISA KEV — ACTIVELY EXPLOITED IN THE WILD" : "";
  const score  = c.cvssV3Score !== null ? `${c.cvssV3Score}/10` : "N/A";

  const lines = [
    `CVE ID:       ${c.id}${kevTag}`,
    `Severity:     ${c.severity} (CVSS v3: ${score})`,
    `Published:    ${c.published.substring(0, 10)}`,
    `Last Updated: ${c.lastModified.substring(0, 10)}`,
    `Description:  ${c.description.substring(0, 500)}`,
  ];

  if (c.cvssV3Vector) {
    lines.push(`CVSS Vector:  ${c.cvssV3Vector}`);
  }
  if (c.affectedProducts.length > 0) {
    lines.push(`Affected:     ${c.affectedProducts.join(", ")}`);
  }
  if (c.references.length > 0) {
    lines.push(`References:`);
    c.references.forEach(r => lines.push(`  - ${r}`));
  }

  return lines.join("\n");
}

// ─── Tool registration ────────────────────────────────────────────────────────

registerTool({
  name:        "cveLookup",
  description: "Look up CVE vulnerability data from NIST NVD and cross-reference with the CISA Known Exploited Vulnerabilities catalog. Use a specific CVE ID for direct lookup, or a keyword and severity to discover recent vulnerabilities affecting a product or technology.",
  parameters: {
    cve_id:   { type: "string",  description: "Specific CVE ID to look up, e.g. CVE-2024-12345. If provided, keyword and severity are ignored." },
    keyword:  { type: "string",  description: "Product or technology keyword to search for, e.g. 'apache log4j', 'windows smb', 'cisco ios'" },
    severity: { type: "string",  description: "Minimum CVSS severity filter: CRITICAL, HIGH, MEDIUM, LOW (default: HIGH)" },
    days:     { type: "number",  description: "Only return CVEs published or modified in the last N days (default: 30)" },
  },

  async execute(args, _taskId, _agentId): Promise<ToolResult> {
    const cveId    = String(args.cve_id  ?? "").trim().toUpperCase();
    const keyword  = String(args.keyword ?? "").trim();
    const severity = String(args.severity ?? "HIGH").trim().toUpperCase();
    const days     = Math.min(Number(args.days ?? 30), 120);

    if (!cveId && !keyword) {
      return { success: false, output: "", error: "Provide either cve_id or keyword" };
    }

    const kevSet = await getKevSet();

    // ── Mode 1: Direct CVE ID lookup ─────────────────────────────────────────
    if (cveId) {
      if (!/^CVE-\d{4}-\d+$/.test(cveId)) {
        return { success: false, output: "", error: `Invalid CVE ID format: ${cveId}. Expected CVE-YYYY-NNNNN` };
      }

      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const url = `${NVD_BASE}?cveId=${cveId}`;
        const res = await fetch(url, {
          signal:  controller.signal,
          headers: { "User-Agent": "AgentNest-Pro/1.0" },
        });
        clearTimeout(timer);

        if (res.status === 404) return { success: false, output: "", error: `CVE ${cveId} not found in NVD` };
        if (!res.ok)            throw new Error(`NVD API returned ${res.status}`);

        const data: any  = await res.json();
        const items: any[] = data?.vulnerabilities ?? [];

        if (items.length === 0) {
          return { success: true, output: `No data found for ${cveId} in NVD.` };
        }

        const parsed = parseCveItem(items[0], kevSet);
        return { success: true, output: formatCVE(parsed) };

      } catch (err: any) {
        clearTimeout(timer);
        if (err.name === "AbortError") return { success: false, output: "", error: "cveLookup timed out" };
        return { success: false, output: "", error: `cveLookup failed: ${err.message}` };
      }
    }

    // ── Mode 2: Keyword + severity search ────────────────────────────────────

    const severityRankMap: Record<string, string> = {
      CRITICAL: "CRITICAL",
      HIGH:     "HIGH",
      MEDIUM:   "MEDIUM",
      LOW:      "LOW",
    };

    const cvssFilter = severityRankMap[severity] ?? "HIGH";

    // NVD date range
    const endDate   = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const fmt       = (d: Date) => d.toISOString().replace(/\.\d+Z$/, ".000");

    const params = new URLSearchParams({
      keywordSearch:       keyword,
      cvssV3Severity:      cvssFilter,
      pubStartDate:        fmt(startDate),
      pubEndDate:          fmt(endDate),
      resultsPerPage:      String(MAX_NVD_RESULTS),
      startIndex:          "0",
    });

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(`${NVD_BASE}?${params}`, {
        signal:  controller.signal,
        headers: { "User-Agent": "AgentNest-Pro/1.0" },
      });
      clearTimeout(timer);

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`NVD API returned ${res.status}: ${txt.substring(0, 200)}`);
      }

      const data: any    = await res.json();
      const items: any[] = data?.vulnerabilities ?? [];
      const total: number = data?.totalResults   ?? 0;

      if (items.length === 0) {
        return {
          success: true,
          output:  `No ${cvssFilter}+ CVEs found for "${keyword}" in the last ${days} days.`,
        };
      }

      const parsed  = items.map((item: any) => parseCveItem(item, kevSet));

      // Sort: CISA KEV first, then by CVSS score descending
      parsed.sort((a, b) => {
        if (a.inCisaKev && !b.inCisaKev) return -1;
        if (!a.inCisaKev && b.inCisaKev) return 1;
        return (b.cvssV3Score ?? 0) - (a.cvssV3Score ?? 0);
      });

      const kevCount = parsed.filter(c => c.inCisaKev).length;
      const header   = [
        `Found ${total} total ${cvssFilter}+ CVEs for "${keyword}" in the last ${days} days.`,
        `Showing top ${parsed.length}.`,
        kevCount > 0 ? `⚠️  ${kevCount} are in the CISA KEV (actively exploited).` : "None are currently in the CISA KEV.",
        "",
      ].join("\n");

      const body = parsed.map(formatCVE).join("\n\n" + "─".repeat(60) + "\n\n");
      return { success: true, output: header + body };

    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") return { success: false, output: "", error: "cveLookup timed out" };
      return { success: false, output: "", error: `cveLookup failed: ${err.message}` };
    }
  },
});

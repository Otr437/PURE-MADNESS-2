// ============================================================
// SHARED: DATE UTILITIES + FETCH HELPERS
// All modules import from here.
// ============================================================

export function getTodayISO(): string {
  return new Date().toISOString();
}

export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]!;
}

export function getTodayLabel(): string {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
}

export function isAuditDateValid(auditDate: string): boolean {
  return auditDate.split('T')[0] === getTodayDate();
}

// Fetch with timeout — uses AbortController, clears timer on success/failure
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  if (timeoutMs <= 0) {
    // 0 = no timeout — used for SSE streams
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const existing = options.signal;
    const signal = existing
      ? (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([controller.signal, existing as AbortSignal])
      : controller.signal;
    return await fetch(url, { ...options, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Build date-locked relevance context injected into every AI prompt
export function buildRelevanceContext(): string {
  const today = getTodayLabel();
  return `Today is ${today}. ALL code, packages, and patterns must be evaluated against ${new Date().getFullYear()} production standards.

KNOWN SECURITY INCIDENT: September-December 2025 — widespread supply-chain attacks on npm. Verify ALL packages.

APPROVED PACKAGES AS OF ${getTodayDate()}:
Core AI:
  - @anthropic-ai/sdk@0.77.0+ (Claude)
  - @google/genai@1.42.0+ (Gemini) — NOT @google/generative-ai (deprecated, vulnerable)
  - openai@6.22.0+ (OpenAI / DeepSeek)
  - @aws-sdk/client-bedrock-runtime@3.758.0+ (Nova)
  - @elevenlabs/elevenlabs-js@2.30.0+ (ElevenLabs)

Web Framework:
  - fastify@5.x (NOT express — too slow, too many CVEs)
  - @fastify/cors@10.x, @fastify/rate-limit@10.x, @fastify/static@8.x
  - zod@3.23.0+ (validation)

Database:
  - pg@8.13.0+ (PostgreSQL)
  - NOT mongoose, sequelize, typeorm (too heavy for this system)

Blockchain:
  - ethers@6.x ONLY (v5 deprecated, breaking changes)
  - viem@2.x, wagmi@2.x (modern alternatives)
  - @openzeppelin/contracts@5.x ONLY (v3/v4 have critical vulnerabilities)
  - Solidity: pragma ^0.8.24 MINIMUM
  - Foundry (forge/cast) preferred over Hardhat for compilation

Runtime:
  - Node.js 22 LTS (NOT 18, NOT 20 — EOL)
  - TypeScript 5.7+
  - tsx@4.19.0+ for runtime execution

BLOCKED (security risk or deprecated):
  - express@any — DO NOT USE
  - web3@any — deprecated, use ethers@6 or viem
  - ethers@4 or ethers@5 — breaking API changes, deprecated
  - @openzeppelin/contracts@3 or @4 — critical vulnerabilities
  - truffle, embark, ganache-cli — deprecated
  - axios@<1.7.0 — CVE-2023-45857 and others
  - node-fetch@2 — CommonJS only, security issues
  - @google/generative-ai — replaced by @google/genai
  - web3-providers-ws@1.x — deprecated

Flag anything not in the approved list above or not actively maintained.`;
}

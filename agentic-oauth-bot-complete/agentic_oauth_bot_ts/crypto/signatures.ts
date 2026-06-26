// crypto/signatures.ts — Sign outbound requests with the agent's private RSA key.
// Every request the bot sends to authorized-to-act includes a signed JWT assertion
// in the X-Agent-Assertion header so the server can verify the bot's identity
// independently of the Auth0 M2M token.

import { SignJWT } from 'jose';
import { v4 as uuidv4 } from 'uuid';
import { loadKeyPair } from './keys';
import { config } from '../config';
import { SignedAgentAssertion } from '../auth/models';

const ASSERTION_TTL_SECONDS = 60; // short-lived — each assertion is single-use

/**
 * Create a signed JWT assertion binding this agent to a specific request.
 * The assertion includes:
 *   - sub: agent ID
 *   - jti: unique nonce (prevents replay)
 *   - iat/exp: timestamps
 *   - aud: the authorized-to-act API URL
 *   - agent_id: same as sub for explicitness
 *   - request_hash: SHA-256 of the request body (optional, passed when available)
 */
export async function signRequest(requestBodyHash?: string): Promise<SignedAgentAssertion> {
  const { privateKey, kid } = await loadKeyPair();
  const now = Math.floor(Date.now() / 1_000);

  const payload: Record<string, unknown> = {
    sub:      config.AGENT_ID,
    agent_id: config.AGENT_ID,
    agent_name: config.AGENT_NAME,
    jti:      uuidv4(),
    aud:      config.ATA_API_URL,
    'https://ai-agent/is_agent': true,
  };

  if (requestBodyHash) {
    payload['request_hash'] = requestBodyHash;
  }

  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt(now)
    .setExpirationTime(now + ASSERTION_TTL_SECONDS)
    .setIssuer(config.AGENT_ID)
    .sign(privateKey);

  return {
    jwt,
    kid,
    issuedAt:  now,
    expiresAt: now + ASSERTION_TTL_SECONDS,
  };
}

/**
 * Build the full set of auth headers for an outbound request to authorized-to-act.
 * Combines the M2M Bearer token with the agent assertion signature.
 *
 * @param bearerToken — M2M access token from auth/client.ts
 * @param bodyHash    — optional SHA-256 hex of request body
 */
export async function buildAuthHeaders(
  bearerToken: string,
  bodyHash?: string,
): Promise<Record<string, string>> {
  const assertion = await signRequest(bodyHash);
  return {
    'Authorization':     `Bearer ${bearerToken}`,
    'X-Agent-Assertion': assertion.jwt,
    'X-Agent-Id':        config.AGENT_ID,
    'X-Request-Id':      uuidv4(),
  };
}

/**
 * Compute SHA-256 hash of a request body string.
 * Used to bind the assertion to the exact payload.
 */
export function hashBody(body: unknown): string {
  const crypto = require('crypto') as typeof import('crypto');
  return crypto
    .createHash('sha256')
    .update(typeof body === 'string' ? body : JSON.stringify(body))
    .digest('hex');
}

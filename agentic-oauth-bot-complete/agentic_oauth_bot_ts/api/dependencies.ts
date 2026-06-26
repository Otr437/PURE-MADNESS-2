// api/dependencies.ts — Startup checks: verify all required services are reachable
// before the bot begins accepting requests. Fails fast with clear error messages.

import axios from 'axios';
import { getBearerHeader } from '../auth/client';
import { loadKeyPair } from '../crypto/keys';
import { config } from '../config';
import { logger } from './middleware';

export interface DependencyStatus {
  name:    string;
  ok:      boolean;
  detail?: string;
}

/**
 * Check that the authorized-to-act API is reachable and accepting the bot's token.
 */
async function checkATA(): Promise<DependencyStatus> {
  try {
    const headers = await getBearerHeader();
    const response = await axios.get(`${config.ATA_API_URL}/health`, {
      headers,
      timeout: 8_000,
    });
    const ok = response.status === 200;
    return { name: 'authorized-to-act', ok, detail: ok ? `HTTP ${response.status}` : `Unexpected status ${response.status}` };
  } catch (err: unknown) {
    const detail = axios.isAxiosError(err)
      ? `HTTP ${err.response?.status ?? 'unreachable'}: ${err.message}`
      : String(err);
    return { name: 'authorized-to-act', ok: false, detail };
  }
}

/**
 * Check that the Auth0 M2M token endpoint is working.
 */
async function checkAuth0(): Promise<DependencyStatus> {
  try {
    await getBearerHeader();
    return { name: 'auth0-m2m', ok: true, detail: 'Token obtained successfully' };
  } catch (err: unknown) {
    return { name: 'auth0-m2m', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check that the RSA key pair is present and loadable.
 */
async function checkCryptoKeys(): Promise<DependencyStatus> {
  try {
    const kp = await loadKeyPair();
    return { name: 'crypto-keys', ok: true, detail: `kid=${kp.kid}` };
  } catch (err: unknown) {
    return { name: 'crypto-keys', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check that the Anthropic API key is set and the API responds.
 */
async function checkAnthropic(): Promise<DependencyStatus> {
  if (!config.ANTHROPIC_API_KEY) {
    return { name: 'anthropic', ok: false, detail: 'ANTHROPIC_API_KEY not set' };
  }
  try {
    const response = await axios.get('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key':         config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 8_000,
    });
    return { name: 'anthropic', ok: response.status === 200, detail: `HTTP ${response.status}` };
  } catch (err: unknown) {
    const detail = axios.isAxiosError(err)
      ? `HTTP ${err.response?.status}: ${err.message}`
      : String(err);
    return { name: 'anthropic', ok: false, detail };
  }
}

/**
 * Run all dependency checks in parallel.
 * Returns the list of results and a boolean indicating whether all passed.
 */
export async function checkAllDependencies(): Promise<{ allOk: boolean; results: DependencyStatus[] }> {
  const results = await Promise.all([
    checkAuth0(),
    checkCryptoKeys(),
    checkATA(),
    checkAnthropic(),
  ]);

  const allOk = results.every(r => r.ok);

  results.forEach(r => {
    if (r.ok) {
      logger.info(`Dependency OK: ${r.name}`, { detail: r.detail });
    } else {
      logger.error(`Dependency FAILED: ${r.name}`, { detail: r.detail });
    }
  });

  return { allOk, results };
}

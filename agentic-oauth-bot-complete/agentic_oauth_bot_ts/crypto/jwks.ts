// crypto/jwks.ts — Serve the bot's public JWKS so authorized-to-act can verify signatures.
// Mount this at GET /.well-known/jwks.json on the bot's Express server.

import { Request, Response } from 'express';
import { getPublicJWK } from './keys';
import { logger } from '../api/middleware';

let _cachedJWKS: { keys: Record<string, unknown>[] } | null = null;

/**
 * Express route handler that serves the JWKS document.
 * Cached in memory — only reloads if keys are rotated (which clears the cache).
 */
export async function jwksHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!_cachedJWKS) {
      const jwk = await getPublicJWK();
      _cachedJWKS = { keys: [jwk] };
    }
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.status(200).json(_cachedJWKS);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Failed to serve JWKS', { error: message });
    res.status(500).json({ error: 'Failed to load JWKS' });
  }
}

/**
 * Clear the JWKS cache — call after key rotation.
 */
export function clearJWKSCache(): void {
  _cachedJWKS = null;
}

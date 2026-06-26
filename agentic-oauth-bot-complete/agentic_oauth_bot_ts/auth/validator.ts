// auth/validator.ts — Verify incoming JWTs on the bot's own API endpoints.
// Uses Auth0 JWKS to validate tokens so the bot's API is properly secured.

import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { config } from '../config';
import { TokenClaims } from './models';
import { InvalidTokenError, TokenExpiredError } from './exceptions';

const JWKS_URL = `https://${config.AUTH0_DOMAIN}/.well-known/jwks.json`;

// Cache the JWKS remote set — jose handles key rotation internally
const jwks = createRemoteJWKSet(new URL(JWKS_URL), {
  cacheMaxAge: 600_000, // 10 minutes
});

/**
 * Verify an Auth0 JWT and return its decoded claims.
 * Throws typed errors on any verification failure.
 *
 * @param token — raw Bearer token string (without "Bearer " prefix)
 */
export async function verifyToken(token: string): Promise<TokenClaims> {
  if (!token || typeof token !== 'string') {
    throw new InvalidTokenError('Token must be a non-empty string');
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer:   `https://${config.AUTH0_DOMAIN}/`,
      audience: config.AUTH0_AUDIENCE,
      algorithms: ['RS256'],
    });

    return payload as unknown as TokenClaims;
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message.includes('expired')) throw new TokenExpiredError();
      throw new InvalidTokenError(err.message);
    }
    throw new InvalidTokenError('Unknown verification error');
  }
}

/**
 * Extract the Bearer token from an Authorization header.
 * Returns null if the header is absent or malformed.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Check that a decoded token has all required permissions.
 * Returns true or throws InsufficientPermissionsError.
 */
export function assertPermissions(claims: TokenClaims, required: string[]): true {
  const { InsufficientPermissionsError } = require('./exceptions');
  const userPerms: string[] = claims.permissions ?? [];
  const missing = required.filter(p => !userPerms.includes(p) && !userPerms.includes('admin:all'));
  if (missing.length > 0) {
    throw new InsufficientPermissionsError(missing.join(', '));
  }
  return true;
}

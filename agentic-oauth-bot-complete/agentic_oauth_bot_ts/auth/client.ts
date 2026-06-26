// auth/client.ts — OAuth 2.0 M2M client credentials flow
// Fetches and caches access tokens from Auth0 for machine-to-machine calls.
// The token is used to authenticate every request to authorized-to-act's API and MCP server.

import axios from 'axios';
import { config } from '../config';
import { logger } from '../api/middleware';
import { CachedToken, M2MTokenResponse } from './models';
import { TokenFetchError } from './exceptions';

// Token is cached in memory — valid for its full lifetime minus a 30-second buffer
let _cachedToken: CachedToken | null = null;
const BUFFER_MS = 30_000;

/**
 * Get a valid M2M access token, using cache when still valid.
 * Automatically refreshes when within the buffer window.
 */
export async function getM2MToken(): Promise<string> {
  const now = Date.now();

  if (_cachedToken && _cachedToken.expiresAt - BUFFER_MS > now) {
    return _cachedToken.accessToken;
  }

  const token = await fetchNewToken();
  return token.accessToken;
}

async function fetchNewToken(): Promise<CachedToken> {
  try {
    const response = await axios.post<M2MTokenResponse>(
      `https://${config.AUTH0_DOMAIN}/oauth/token`,
      {
        grant_type:    'client_credentials',
        client_id:     config.AUTH0_M2M_CLIENT_ID,
        client_secret: config.AUTH0_M2M_CLIENT_SECRET,
        audience:      config.AUTH0_AUDIENCE,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10_000,
      },
    );

    const { access_token, expires_in, scope } = response.data;

    _cachedToken = {
      accessToken: access_token,
      expiresAt:   Date.now() + expires_in * 1_000,
      scope:       scope ? scope.split(' ') : [],
    };

    logger.info('M2M token refreshed', {
      expiresIn: expires_in,
      scopes:    _cachedToken.scope,
    });

    return _cachedToken;
  } catch (err: unknown) {
    const message = axios.isAxiosError(err)
      ? `${err.response?.status} — ${JSON.stringify(err.response?.data)}`
      : String(err);
    throw new TokenFetchError(message);
  }
}

/**
 * Return an Authorization header object ready to pass to axios/fetch.
 */
export async function getBearerHeader(): Promise<{ Authorization: string }> {
  const token = await getM2MToken();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Force-refresh the token — call after receiving a 401 from the API.
 */
export async function refreshToken(): Promise<string> {
  _cachedToken = null;
  return getM2MToken();
}

/**
 * Inspect cached token state — used by health checks.
 */
export function getTokenStatus(): { cached: boolean; expiresAt: number | null; ttlMs: number } {
  if (!_cachedToken) return { cached: false, expiresAt: null, ttlMs: 0 };
  return {
    cached:    true,
    expiresAt: _cachedToken.expiresAt,
    ttlMs:     Math.max(0, _cachedToken.expiresAt - Date.now()),
  };
}

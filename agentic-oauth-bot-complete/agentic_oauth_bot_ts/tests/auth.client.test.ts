// tests/auth.client.test.ts

const mockPost = jest.fn();
jest.mock('axios', () => ({
  post:          mockPost,
  isAxiosError:  jest.fn((e) => e?.isAxiosError === true),
  create:        jest.fn(() => ({ post: mockPost, get: jest.fn(), request: jest.fn() })),
}));

// Reset module state between tests so the token cache is cleared
beforeEach(() => {
  jest.resetModules();
  mockPost.mockReset();
});

const makeTokenResponse = (expiresIn = 3600) => ({
  data: {
    access_token: 'mock-access-token-abc123',
    token_type:   'Bearer',
    expires_in:   expiresIn,
    scope:        'read:agent write:agent',
  },
});

describe('auth/client', () => {
  describe('getM2MToken()', () => {
    it('fetches a new token from Auth0 on first call', async () => {
      mockPost.mockResolvedValue(makeTokenResponse());
      const { getM2MToken } = require('../auth/client');
      const token = await getM2MToken();
      expect(token).toBe('mock-access-token-abc123');
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('oauth/token'),
        expect.objectContaining({ grant_type: 'client_credentials' }),
        expect.any(Object),
      );
    });

    it('returns the cached token on subsequent calls without hitting Auth0', async () => {
      mockPost.mockResolvedValue(makeTokenResponse(3600));
      const { getM2MToken } = require('../auth/client');
      await getM2MToken();
      await getM2MToken();
      await getM2MToken();
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('throws TokenFetchError on Auth0 failure', async () => {
      const axiosErr = new Error('network error');
      (axiosErr as typeof axiosErr & { isAxiosError: boolean }).isAxiosError = true;
      (axiosErr as typeof axiosErr & { response: { status: number; data: object } }).response = { status: 401, data: { error: 'invalid_client' } };
      mockPost.mockRejectedValue(axiosErr);

      const { getM2MToken } = require('../auth/client');
      const { TokenFetchError } = require('../auth/exceptions');
      await expect(getM2MToken()).rejects.toThrow(TokenFetchError);
    });
  });

  describe('getBearerHeader()', () => {
    it('returns an Authorization header with Bearer prefix', async () => {
      mockPost.mockResolvedValue(makeTokenResponse());
      const { getBearerHeader } = require('../auth/client');
      const header = await getBearerHeader();
      expect(header.Authorization).toBe('Bearer mock-access-token-abc123');
    });
  });

  describe('refreshToken()', () => {
    it('forces a new token fetch even if cache is valid', async () => {
      mockPost.mockResolvedValue(makeTokenResponse());
      const { getM2MToken, refreshToken } = require('../auth/client');
      await getM2MToken();         // populates cache
      await refreshToken();        // clears cache and re-fetches
      expect(mockPost).toHaveBeenCalledTimes(2);
    });
  });

  describe('getTokenStatus()', () => {
    it('returns cached=false before any token is fetched', () => {
      const { getTokenStatus } = require('../auth/client');
      const status = getTokenStatus();
      expect(status.cached).toBe(false);
      expect(status.expiresAt).toBeNull();
    });

    it('returns cached=true and positive ttlMs after token fetch', async () => {
      mockPost.mockResolvedValue(makeTokenResponse(3600));
      const { getM2MToken, getTokenStatus } = require('../auth/client');
      await getM2MToken();
      const status = getTokenStatus();
      expect(status.cached).toBe(true);
      expect(status.ttlMs).toBeGreaterThan(0);
    });
  });
});

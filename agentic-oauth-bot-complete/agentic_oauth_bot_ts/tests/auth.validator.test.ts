// tests/auth.validator.test.ts

import { extractBearerToken, assertPermissions } from '../auth/validator';
import { InvalidTokenError, InsufficientPermissionsError } from '../auth/exceptions';
import type { TokenClaims } from '../auth/models';

// verifyToken hits a real JWKS endpoint, so we mock jose's jwtVerify
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => 'mock-jwks'),
  jwtVerify: jest.fn(),
}));

const { jwtVerify } = require('jose') as { jwtVerify: jest.Mock };

const mockClaims: TokenClaims = {
  sub:         'auth0|test-user',
  iss:         'https://test.auth0.com/',
  aud:         'https://test-api',
  iat:         Math.floor(Date.now() / 1000),
  exp:         Math.floor(Date.now() / 1000) + 3600,
  permissions: ['send:crypto', 'swap:tokens'],
};

describe('auth/validator', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('extractBearerToken()', () => {
    it('extracts the token from a valid Authorization header', () => {
      expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    });

    it('returns null when header is undefined', () => {
      expect(extractBearerToken(undefined)).toBeNull();
    });

    it('returns null when header does not start with Bearer', () => {
      expect(extractBearerToken('Basic abc123')).toBeNull();
    });

    it('returns null when token is empty after Bearer prefix', () => {
      expect(extractBearerToken('Bearer ')).toBeNull();
    });
  });

  describe('verifyToken()', () => {
    it('returns decoded claims for a valid token', async () => {
      jwtVerify.mockResolvedValue({ payload: mockClaims });
      const { verifyToken } = require('../auth/validator');
      const claims = await verifyToken('valid.jwt.token');
      expect(claims.sub).toBe('auth0|test-user');
      expect(claims.permissions).toContain('send:crypto');
    });

    it('throws InvalidTokenError for empty token', async () => {
      const { verifyToken } = require('../auth/validator');
      await expect(verifyToken('')).rejects.toThrow(InvalidTokenError);
    });

    it('throws TokenExpiredError when jose reports expired', async () => {
      const { TokenExpiredError } = require('../auth/exceptions');
      jwtVerify.mockRejectedValue(new Error('Token is expired'));
      const { verifyToken } = require('../auth/validator');
      await expect(verifyToken('expired.jwt.token')).rejects.toThrow(TokenExpiredError);
    });

    it('throws InvalidTokenError for invalid signature', async () => {
      jwtVerify.mockRejectedValue(new Error('signature verification failed'));
      const { verifyToken } = require('../auth/validator');
      await expect(verifyToken('bad.sig.token')).rejects.toThrow(InvalidTokenError);
    });
  });

  describe('assertPermissions()', () => {
    it('returns true when user has all required permissions', () => {
      expect(assertPermissions(mockClaims, ['send:crypto'])).toBe(true);
    });

    it('returns true when user has admin:all', () => {
      const adminClaims = { ...mockClaims, permissions: ['admin:all'] };
      expect(assertPermissions(adminClaims, ['send:crypto', 'deploy:contract'])).toBe(true);
    });

    it('throws InsufficientPermissionsError when a permission is missing', () => {
      expect(() => assertPermissions(mockClaims, ['deploy:contract'])).toThrow(InsufficientPermissionsError);
    });

    it('throws with the missing permission name in the message', () => {
      try {
        assertPermissions(mockClaims, ['deploy:contract']);
      } catch (err: unknown) {
        expect((err as Error).message).toContain('deploy:contract');
      }
    });

    it('returns true when required list is empty', () => {
      expect(assertPermissions(mockClaims, [])).toBe(true);
    });
  });
});

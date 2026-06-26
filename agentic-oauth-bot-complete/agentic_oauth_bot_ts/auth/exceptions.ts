// auth/exceptions.ts — Typed error classes for auth failures

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class TokenExpiredError extends AuthError {
  constructor() {
    super('Access token has expired', 'TOKEN_EXPIRED', 401);
    this.name = 'TokenExpiredError';
  }
}

export class TokenFetchError extends AuthError {
  constructor(detail: string) {
    super(`Failed to fetch M2M token: ${detail}`, 'TOKEN_FETCH_ERROR', 502);
    this.name = 'TokenFetchError';
  }
}

export class InvalidTokenError extends AuthError {
  constructor(detail: string) {
    super(`Invalid token: ${detail}`, 'INVALID_TOKEN', 401);
    this.name = 'InvalidTokenError';
  }
}

export class InsufficientPermissionsError extends AuthError {
  constructor(required: string) {
    super(`Insufficient permissions — required: ${required}`, 'INSUFFICIENT_PERMISSIONS', 403);
    this.name = 'InsufficientPermissionsError';
  }
}

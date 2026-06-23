import * as crypto from "crypto";
import type { EncryptionService } from "@rtos/shared-crypto";
import type {
  OAuthClient,
  OAuthToken,
  AuthCodeData,
} from "@rtos/shared-types";

const REQUIRED_SCOPES = [
  "mcp:tools:read",
  "mcp:tools:write",
  "mcp:resources:read",
  "mcp:resources:write",
  "mcp:prompts:read",
  "mcp:agent:spawn",
  "mcp:agent:control",
  "mcp:financial:trade",
  "mcp:system:execute",
  "mcp:admin:all",
] as const;

const AUTH_CODE_TTL_MS = 600_000; // 10 minutes
const TOKEN_TTL_S = 3600; // 1 hour

export interface RegisterClientInput {
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  scopes?: string[];
}

export interface AuthorizeInput {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state?: string;
}

export interface ExchangeCodeInput {
  code: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  code_verifier: string;
}

export class OAuthService {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly tokens = new Map<string, OAuthToken>();
  private readonly authCodes = new Map<string, AuthCodeData>();

  constructor(private readonly encryption: EncryptionService) {}

  registerClient(input: RegisterClientInput): OAuthClient {
    const clientId = this.encryption.generateToken(16);
    const isPublic =
      !input.grant_types?.includes("authorization_code") ?? true;
    const clientSecret = isPublic
      ? undefined
      : this.encryption.generateToken(32);

    const client: OAuthClient = {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: input.redirect_uris,
      scopes: input.scopes ?? [...REQUIRED_SCOPES],
      grant_types: input.grant_types ?? ["authorization_code", "refresh_token"],
      is_public: isPublic,
    };

    this.clients.set(clientId, client);
    return client;
  }

  generateAuthCode(params: AuthorizeInput): string {
    const client = this.clients.get(params.client_id);
    if (!client) throw new Error("Invalid client_id");
    if (!client.redirect_uris.includes(params.redirect_uri)) {
      throw new Error("Invalid redirect_uri");
    }

    const authCode = this.encryption.generateToken(32);
    this.authCodes.set(authCode, {
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      scope: params.scope,
      code_challenge: params.code_challenge,
      code_challenge_method: params.code_challenge_method,
      expires_at: Date.now() + AUTH_CODE_TTL_MS,
    });

    return authCode;
  }

  exchangeCode(params: ExchangeCodeInput): OAuthToken {
    const authData = this.authCodes.get(params.code);
    if (!authData || Date.now() > authData.expires_at) {
      throw new Error("Invalid or expired authorization code");
    }

    const computed = crypto
      .createHash("sha256")
      .update(params.code_verifier)
      .digest("base64url");

    if (computed !== authData.code_challenge) {
      throw new Error("PKCE verification failed");
    }

    const client = this.clients.get(params.client_id);
    if (!client) throw new Error("Invalid client");
    if (client.client_secret && client.client_secret !== params.client_secret) {
      throw new Error("Invalid client credentials");
    }

    const accessToken = this.encryption.generateToken(32);
    const refreshToken = this.encryption.generateToken(32);

    const token: OAuthToken = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_S,
      refresh_token: refreshToken,
      scope: authData.scope,
      created_at: Date.now(),
    };

    this.tokens.set(accessToken, token);
    this.authCodes.delete(params.code);
    return token;
  }

  validateToken(accessToken: string, requiredScopes?: string[]): boolean {
    const token = this.tokens.get(accessToken);
    if (!token) return false;

    if (Date.now() > token.created_at + token.expires_in * 1000) {
      this.tokens.delete(accessToken);
      return false;
    }

    if (requiredScopes) {
      const tokenScopes = token.scope.split(" ");
      const hasAll = requiredScopes.every(
        (s) => tokenScopes.includes(s) || tokenScopes.includes("mcp:admin:all")
      );
      if (!hasAll) return false;
    }

    return true;
  }

  refreshToken(refreshToken: string): OAuthToken {
    const existing = Array.from(this.tokens.values()).find(
      (t) => t.refresh_token === refreshToken
    );
    if (!existing) throw new Error("Invalid refresh token");

    const oldKey = Array.from(this.tokens.entries()).find(
      ([, t]) => t.refresh_token === refreshToken
    )?.[0];
    if (oldKey) this.tokens.delete(oldKey);

    const newAccessToken = this.encryption.generateToken(32);
    const newRefreshToken = this.encryption.generateToken(32);

    const token: OAuthToken = {
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_S,
      refresh_token: newRefreshToken,
      scope: existing.scope,
      created_at: Date.now(),
    };

    this.tokens.set(newAccessToken, token);
    return token;
  }
}

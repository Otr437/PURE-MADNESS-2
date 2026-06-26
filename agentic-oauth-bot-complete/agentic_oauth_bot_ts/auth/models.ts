// auth/models.ts — Type definitions for OAuth tokens and agent identity

export interface M2MTokenResponse {
  access_token: string;
  token_type:   'Bearer';
  expires_in:   number;
  scope?:       string;
}

export interface CachedToken {
  accessToken: string;
  expiresAt:   number;
  scope:       string[];
}

export interface AgentIdentity {
  agentId:     string;
  agentName:   string;
  permissions: string[];
  roles:       string[];
  issuedAt:    number;
  issuer:      string;
}

export interface SignedAgentAssertion {
  jwt:       string;
  kid:       string;
  issuedAt:  number;
  expiresAt: number;
}

export interface TokenClaims {
  sub:         string;
  iss:         string;
  aud:         string | string[];
  iat:         number;
  exp:         number;
  scope?:      string;
  permissions?: string[];
  'https://ai-agent/is_agent'?:  boolean;
  'https://ai-agent/agent_id'?:  string;
  'https://ai-agent/roles'?:     string[];
}

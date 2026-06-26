// crypto/keys.ts — RSA key pair generation and loading for agent request signing.
// The bot signs its own outbound MCP requests with its private key.
// authorized-to-act verifies these signatures using the bot's public JWKS endpoint.

import { generateKeyPair, exportPKCS8, exportSPKI, importPKCS8, importSPKI, KeyLike } from 'jose';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../api/middleware';

export interface AgentKeyPair {
  privateKey: KeyLike;
  publicKey:  KeyLike;
  kid:        string;
}

let _keyPair: AgentKeyPair | null = null;

/**
 * Generate a new RSA-4096 key pair and persist it to disk.
 * Called by npm run keygen / scripts/rotateKeys.ts.
 */
export async function generateAndSaveKeyPair(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 4096 });

  const privatePem = await exportPKCS8(privateKey);
  const publicPem  = await exportSPKI(publicKey);

  const privPath = path.resolve(config.AGENT_PRIVATE_KEY_PATH);
  const pubPath  = path.resolve(config.AGENT_PUBLIC_KEY_PATH);

  fs.mkdirSync(path.dirname(privPath), { recursive: true });
  fs.writeFileSync(privPath, privatePem, { mode: 0o600 });
  fs.writeFileSync(pubPath,  publicPem,  { mode: 0o644 });

  // Clear in-memory cache so next call re-loads from disk
  _keyPair = null;

  logger.info('RSA key pair generated and saved', { kid: config.AGENT_KID, privPath, pubPath });
}

/**
 * Load the agent key pair from disk.
 * Cached in memory after first load.
 */
export async function loadKeyPair(): Promise<AgentKeyPair> {
  if (_keyPair) return _keyPair;

  const privPath = path.resolve(config.AGENT_PRIVATE_KEY_PATH);
  const pubPath  = path.resolve(config.AGENT_PUBLIC_KEY_PATH);

  if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
    throw new Error(
      `Agent RSA keys not found at ${privPath} / ${pubPath}. ` +
      'Run "npm run keygen" to generate them.'
    );
  }

  const privatePem = fs.readFileSync(privPath, 'utf8');
  const publicPem  = fs.readFileSync(pubPath,  'utf8');

  const privateKey = await importPKCS8(privatePem, 'RS256');
  const publicKey  = await importSPKI(publicPem,   'RS256');

  _keyPair = { privateKey, publicKey, kid: config.AGENT_KID };
  logger.info('Agent RSA keys loaded', { kid: config.AGENT_KID });
  return _keyPair;
}

/**
 * Export the public key as a JWK — served at /.well-known/jwks.json
 * so authorized-to-act can verify the bot's signed requests.
 */
export async function getPublicJWK(): Promise<Record<string, unknown>> {
  const { exportJWK } = await import('jose');
  const { publicKey, kid } = await loadKeyPair();
  const jwk = await exportJWK(publicKey);
  return { ...jwk, kid, use: 'sig', alg: 'RS256' };
}

/**
 * Clear the in-memory key cache — used after key rotation.
 */
export function clearKeyCache(): void {
  _keyPair = null;
}

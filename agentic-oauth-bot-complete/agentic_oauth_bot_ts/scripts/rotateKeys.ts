// scripts/rotateKeys.ts — Generate a new RSA-4096 key pair and save to disk.
// Run with: npm run keygen
// Old keys are overwritten. After running this:
//   1. Restart the bot so it loads the new keys
//   2. The new public key is automatically served at /.well-known/jwks.json
//   3. Update AGENT_KID in .env if you want to version your keys

import dotenv from 'dotenv';
dotenv.config();

import { generateAndSaveKeyPair, getPublicJWK } from '../crypto/keys';
import { config } from '../config';

async function main(): Promise<void> {
  console.log('Generating RSA-4096 key pair...');
  console.log(`  Private key → ${config.AGENT_PRIVATE_KEY_PATH}`);
  console.log(`  Public key  → ${config.AGENT_PUBLIC_KEY_PATH}`);
  console.log(`  KID         → ${config.AGENT_KID}`);

  await generateAndSaveKeyPair();

  // Print the public JWK so it can be shared with authorized-to-act if needed
  const jwk = await getPublicJWK();
  console.log('\nPublic JWK (share with authorized-to-act if not using JWKS URL):');
  console.log(JSON.stringify(jwk, null, 2));
  console.log('\nKey rotation complete. Restart the bot to load the new keys.');
}

main().catch(err => {
  console.error('Key rotation failed:', err);
  process.exit(1);
});

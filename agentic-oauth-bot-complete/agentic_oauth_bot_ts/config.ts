import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const ConfigSchema = z.object({
  // Agent identity
  AGENT_ID:           z.string().min(1),
  AGENT_NAME:         z.string().min(1).default('agentic-oauth-bot'),

  // authorized-to-act backend URLs
  ATA_API_URL:        z.string().url(),
  ATA_MCP_URL:        z.string().url(),

  // Auth0 M2M
  AUTH0_DOMAIN:            z.string().min(1),
  AUTH0_M2M_CLIENT_ID:     z.string().min(1),
  AUTH0_M2M_CLIENT_SECRET: z.string().min(1),
  AUTH0_AUDIENCE:          z.string().min(1),

  // Bot API server
  PORT:           z.coerce.number().default(4000),
  BOT_API_SECRET: z.string().min(32),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),

  // Slack
  SLACK_BOT_TOKEN:       z.string().min(1),
  SLACK_SIGNING_SECRET:  z.string().min(1),
  SLACK_DEFAULT_CHANNEL: z.string().default('#general'),

  // Google
  GOOGLE_CLIENT_ID:     z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),

  // Crypto
  AGENT_PRIVATE_KEY_PATH: z.string().default('./crypto/keys/agent_private.pem'),
  AGENT_PUBLIC_KEY_PATH:  z.string().default('./crypto/keys/agent_public.pem'),
  AGENT_KID:              z.string().default('bot-key-001'),

  // Memory
  MEMORY_MAX_ITEMS:    z.coerce.number().default(100),
  MEMORY_TTL_SECONDS:  z.coerce.number().default(3600),

  // Runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Missing or invalid environment variables:\n${missing}`);
  }
  return result.data;
}

export const config = loadConfig();

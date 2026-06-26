import { z } from 'zod';

const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CIRCLE_API_KEY: z.string().min(1),
  CIRCLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  CIRCLE_ENTITY_SECRET: z.string().min(1),
  CIRCLE_WALLET_SET_ID: z.string().min(1),
  ARC_RPC_URL: z.string().url().default('https://rpc.testnet.arc.network/'),
  ARC_CHAIN_ID: z.coerce.number().default(5042002),
  BASE_RPC_URL: z.string().url().default('https://mainnet.base.org'),
  ETH_RPC_URL: z.string().url().default('https://eth.llamarpc.com'),
  X402_FACILITATOR_URL: z.string().url().default('https://x402.org/facilitator'),
  X402_BATCH_SETTLEMENT_INTERVAL_MS: z.coerce.number().default(30000),
  NANO_MAX_SPEND_PER_SECOND_USDC: z.coerce.number().default(0.01),
  NANO_BATCH_SIZE: z.coerce.number().default(500),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  DATABASE_URL: z.string().url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_SPENDING_LIMIT_USDC_PER_HOUR: z.coerce.number().default(100),
  AGENT_SPENDING_LIMIT_USDC_PER_TX: z.coerce.number().default(10),
});

export type Config = z.infer<typeof BaseConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const result = BaseConfigSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map(i => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration. Missing/invalid: ${missing}`);
  }
  _config = result.data;
  return _config;
}

export const USDC_DECIMALS = 6;
export const USDC_DIVISOR = BigInt(10 ** USDC_DECIMALS);

export function toUSDCUnits(dollars: number): bigint {
  return BigInt(Math.round(dollars * 10 ** USDC_DECIMALS));
}

export function fromUSDCUnits(units: bigint | string): number {
  return Number(BigInt(units)) / 10 ** USDC_DECIMALS;
}

export function toUSDCString(dollars: number): string {
  return toUSDCUnits(dollars).toString();
}

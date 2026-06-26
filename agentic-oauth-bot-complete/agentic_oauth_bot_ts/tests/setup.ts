// tests/setup.ts — Jest global setup: set all required env vars before any test runs.

process.env.AGENT_ID                 = 'agent:test-bot-001';
process.env.AGENT_NAME               = 'test-bot';
process.env.ATA_API_URL              = 'http://localhost:3000';
process.env.ATA_MCP_URL              = 'http://localhost:3000/mcp';
process.env.AUTH0_DOMAIN             = 'test.auth0.com';
process.env.AUTH0_M2M_CLIENT_ID      = 'test-m2m-client-id';
process.env.AUTH0_M2M_CLIENT_SECRET  = 'test-m2m-client-secret';
process.env.AUTH0_AUDIENCE           = 'https://test-api';
process.env.PORT                     = '4001';
process.env.BOT_API_SECRET           = 'test-bot-api-secret-at-least-32-chars-long';
process.env.ANTHROPIC_API_KEY        = 'sk-ant-test';
process.env.SLACK_BOT_TOKEN          = 'xoxb-test-token';
process.env.SLACK_SIGNING_SECRET     = 'test-slack-signing-secret';
process.env.SLACK_DEFAULT_CHANNEL    = '#test';
process.env.GOOGLE_CLIENT_ID         = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET     = 'test-google-client-secret';
process.env.GOOGLE_REFRESH_TOKEN     = 'test-refresh-token';
process.env.AGENT_PRIVATE_KEY_PATH   = './crypto/keys/agent_private.pem';
process.env.AGENT_PUBLIC_KEY_PATH    = './crypto/keys/agent_public.pem';
process.env.AGENT_KID                = 'test-key-001';
process.env.MEMORY_MAX_ITEMS         = '50';
process.env.MEMORY_TTL_SECONDS       = '300';
process.env.NODE_ENV                 = 'test';

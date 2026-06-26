# agentic-oauth-bot

Autonomous TypeScript OAuth agent that authenticates as a machine identity and delegates work to [authorized-to-act](https://github.com/your-org/authorized-to-act) via its REST API.

## Architecture (Option A — Separate Services)

```
[agentic-oauth-bot]  ──── HTTPS + M2M Bearer token ────►  [authorized-to-act]
    TypeScript               + RSA-signed assertion            JavaScript (Next.js)
    Port 4000                X-Agent-Assertion header          Port 3000 / Render
         │
         ├── POST /chat          → Claude orchestrator loop
         ├── GET  /tools         → list available tools
         ├── POST /tools/:name   → execute a specific tool
         ├── GET  /admin/health  → health check (public)
         ├── GET  /admin/status  → token + memory status (secret required)
         └── GET  /.well-known/jwks.json  → public key for ATA to verify bot signatures
```

## How the two services talk

1. **Bot gets an M2M token** from Auth0 using `client_credentials` grant (its own M2M app, separate from the user app).
2. **Every request to ATA** carries:
   - `Authorization: Bearer <M2M token>` — proves the bot is a registered Auth0 client
   - `X-Agent-Assertion: <RSA-signed JWT>` — cryptographically proves it is *this specific bot* (not just any M2M client)
   - `X-Agent-Id: agent:bot-001` — human-readable identity
3. **ATA verifies** both headers. The RSA signature is checked against the bot's public key served at `/.well-known/jwks.json`.

## Setup

### 1. Auth0 — create an M2M application
- In Auth0 Dashboard → Applications → Create Application → Machine to Machine
- Authorize it for your API with the permissions you want the bot to have
- Copy the Client ID and Client Secret to `.env`

### 2. Generate RSA keys
```bash
npm install
npm run keygen
```
This writes `crypto/keys/agent_private.pem` and `crypto/keys/agent_public.pem`. Never commit the private key.

### 3. Configure environment
```bash
cp .env.example .env
# Fill in all required values
```

### 4. Register the bot with authorized-to-act
```bash
export ATA_ADMIN_TOKEN="<admin Auth0 token>"
npm run register
```
This calls `POST /api/admin/agents/register` on your ATA deployment.

### 5. Update authorized-to-act to verify bot assertions (wire-in step)
Add to your ATA `middleware/agentIdentity.js`:
```js
// After verifying the Bearer token, also verify the agent assertion if present
const agentAssertion = req.headers['x-agent-assertion'];
if (agentAssertion) {
  const botJwksUrl = `${process.env.BOT_JWKS_URL}/.well-known/jwks.json`;
  // verify agentAssertion JWT against botJwksUrl using jwks-rsa
}
```

### 6. Start the bot
```bash
npm run dev        # development with hot reload
npm start          # production (after npm run build)
```

### 7. Verify everything works
```bash
npm run test:flow  # runs end-to-end integration checks
npm test           # unit tests
```

## API

All write endpoints require `X-Bot-Api-Secret` header matching `BOT_API_SECRET` in `.env`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET    | `/admin/health` | None | Liveness check |
| GET    | `/.well-known/jwks.json` | None | Bot's public JWKS |
| GET    | `/admin/status` | Secret | Token + memory stats |
| GET    | `/tools` | Secret | List available tools |
| POST   | `/tools/:name` | Secret | Execute a specific tool |
| POST   | `/chat` | Secret | Run a task through the agent |

### POST /chat
```json
{
  "task": "Check the ETH balance of 0xABC... and post a summary to #defi-alerts",
  "sessionId": "optional-session-id-for-conversation-continuity"
}
```

## Security notes

- The private key (`crypto/keys/agent_private.pem`) must never be committed to source control — it is in `.gitignore`
- The M2M client secret must never be committed — use environment variable injection
- `axios` is pinned to `1.14.0` — do not upgrade to `1.14.1` or `0.30.4` (supply chain compromise — North Korean state actor, March 31 2026)
- Rotate keys regularly using `npm run keygen` and restart the bot
- The `BOT_API_SECRET` protects the bot's own API from unauthorized callers — use a 32+ character random string

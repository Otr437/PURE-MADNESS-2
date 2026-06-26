# API Key Library — Universal Key Rotator

All files contain PLACEHOLDER values only. Never commit real keys.  
Real keys go in environment variables or a secrets manager (Vault, Doppler, AWS Secrets Manager).

## Structure

```
api_keys/
├── KEY_ROTATOR_CONFIG.json     ← Master config — rotation rules, load/unload, hot-swap logic
├── crypto/
│   ├── blockchain_rpc.json     ← Infura, Alchemy, QuickNode, Ankr, Blast, dRPC, Moralis
│   ├── exchange_and_data.json  ← Coinbase, Binance, Kraken, OKX, Bybit, CoinGecko, CMC,
│   │                              Etherscan, The Graph, Dune, Covalent, DefiLlama, Zerion,
│   │                              Zapper, Nansen, Birdeye
│   └── wallets_and_web3.json   ← WalletConnect, Dynamic, Privy, Thirdweb, Biconomy,
│                                  Stackup, MoonPay, Transak, Onramper, AVNU Paymaster
├── payments/
│   └── payment_processors.json ← Stripe, PayPal, Square, Braintree, Adyen, Plaid,
│                                  Coinbase Commerce, BitPay, NowPayments
├── ai/
│   └── ai_models.json          ← Anthropic, OpenAI, Gemini, Groq, Mistral, Together AI,
│                                  HuggingFace, Replicate, ElevenLabs, Stability AI,
│                                  Cohere, DeepSeek, Perplexity, OpenRouter
├── dev/
│   └── developer_tools.json    ← GitHub, Vercel, Netlify, AWS, GCP, Cloudflare (R2+Workers AI),
│                                  Supabase, PlanetScale, Upstash, Sentry, Datadog,
│                                  PostHog, Mixpanel, Resend, Pusher
├── google/
│   └── google_services.json    ← OAuth, Maps, Firebase, Cloud, Sheets, Search Console,
│                                  YouTube, Analytics GA4
├── email/
│   └── email_services.json     ← Resend, SendGrid, Mailgun, Postmark, Amazon SES,
│                                  Mailchimp, ConvertKit, Gmail SMTP, IMAP
├── social/
│   └── social_apis.json        ← Twitter/X, Discord, Telegram, Slack, Reddit,
│                                  LinkedIn, Instagram
├── data/
│   └── data_services.json      ← Alpha Vantage, Polygon.io, Finnhub, NewsAPI,
│                                  OpenWeather, SerpAPI, Browserless, Apify,
│                                  Twilio, Vonage, IPInfo, AbstractAPI
└── infra/
    └── infrastructure.json     ← Redis, MongoDB, Postgres, Pinecone, Weaviate,
                                   Cloudinary, S3, Auth0, Clerk, HashiCorp Vault, Doppler
```

## How the Rotator Works

```
1. Bot starts → loads KEY_ROTATOR_CONFIG.json
2. "always_loaded" groups decrypt into memory (RPC + AI + Infra)
3. Bot receives a task (e.g. "check ETH price")
4. Rotator checks: does this task need "exchange_data" group?
5. If yes → decrypt that group → inject key → execute task
6. After unload_after_seconds → wipe from memory
7. If 429/401/503 error → hot swap to next provider in priority list
8. Alert fired to Telegram/Slack on swap or failure
```

## Key Priority (Hot Swap Order)

**RPC:** Alchemy → Infura → QuickNode → Ankr → Blast → dRPC  
**AI:** Anthropic → OpenAI → Groq → Mistral → OpenRouter  
**Email:** Resend → SendGrid → Postmark → Mailgun  
**No fallback:** Payments (Stripe only — no auto-swap for real money)

## Security Rules

- `ROTATOR_MASTER_KEY` — ONLY in environment variable, never in any file
- Payment keys — manual rotation only, never auto-swap
- All files are safe to store encrypted. Only the master key unlocks them.
- Audit log redacts all actual key values — only logs events.
- Redis TTL = 1 hour max for any in-memory key

## Encryption Flow (for the bot)

```python
# Encrypt a key file
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import os, json

master_key = os.environ["ROTATOR_MASTER_KEY"].encode()
data = json.dumps(key_data).encode()
iv = os.urandom(16)
aesgcm = AESGCM(master_key[:32])
encrypted = aesgcm.encrypt(iv, data, None)
# Store: iv + encrypted

# Decrypt
decrypted = aesgcm.decrypt(iv, encrypted, None)
key_data = json.loads(decrypted)
```

## Parseable Key Access Pattern

```javascript
// Load a specific provider key
const key = rotator.get("ai_models", "anthropic", "api_key")
// → "sk-ant-..." (decrypted, in memory only)

// Get best available RPC for a chain
const rpc = rotator.getBestRPC("ethereum")
// → tries alchemy first, falls back down priority list

// Execute with auto-retry + hot swap
const result = await rotator.execute("blockchain_rpc", async (key) => {
  return await ethers.getBalance(address)
}, { chain: "ethereum" })
```

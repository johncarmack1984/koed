# Configuration

Use `.env.example` as the starting point.

Required production values:

- `DATABASE_URL`
- `REDIS_URL`
- `DATA_ENCRYPTION_KEY`
- `API_TOKEN_PEPPER`
- `CORS_ORIGINS`

Recommended default:

```text
MEMORY_MODE=codex_subscription
```

In this mode, backend recall returns evidence and local Codex performs synthesis. Server-side model provider configuration is optional and should only be enabled intentionally.

Provider API keys are encrypted at rest with `DATA_ENCRYPTION_KEY`. They are never returned by API list endpoints or diagnostics.

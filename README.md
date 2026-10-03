# Lonora

Lonora is one owner's private gold-market agent. It runs continuously on the
VPS as the Agent Gateway (`src/worker.ts`), remembers across web, Telegram,
and MCP, and keeps durable goals. There is no public signup and no customer
billing.

It reads XAUUSD, reasons through the existing analysis gates, and can issue a
recommendation — direction, entry, stop, targets, rationale, and confidence.
Cheap deterministic checks watch the market. A model runs only after a
material change.

**The gateway never places, modifies, or closes a trade.** A manual
confirmation path exists for the owner and nothing else can reach it: not a
goal, a cron job, a market watcher, or a sub-agent. Recommendations are
tracked to a terminal outcome against the market's own candles.

## Surfaces

- **Chat** — talk to the analyst; charts and cards render inline.
- **Recommendations** — every plan, its evidence, and its outcome.
- **Performance** — equity curve in R, win rate, expectancy, decay alerts.

Also reachable from Telegram and MCP, with the same owner and the same brain.
The private control center is `/control`. Gateway health is `GET /api/gateway/status`.
Architecture: [docs/AGENT_GATEWAY.md](docs/AGENT_GATEWAY.md).

## Stack

Next.js (app + API routes) · `mcp/` MCP server (read-and-recommend tools) ·
`research-service/` Python backtester · OANDA for all market data.

## VPS

Fresh install on a server that already runs other projects:
[`docs/vps-install.md`](docs/vps-install.md) and `bash infra/vps-fresh-install.sh`.
That script is what keeps chart capture wired (`CHART_HOST_URL`,
`AICHART_API_URL`, and the `chart-host` container). Do not use
`infra/deploy-vps.sh` — it targets the old `web/` layout.

## Running it

```bash
npm install
cp .env.example .env    # OANDA_API_TOKEN, OANDA_ACCOUNT_ID, OANDA_ENV
npm run dev
```

```bash
npm run test:ci         # full suite
```

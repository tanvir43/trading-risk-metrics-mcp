# trading-risk-metrics-mcp

Deterministic, auditable **portfolio risk and performance** analytics from your **CSV or JSON** exports: historical VaR/ES, Sharpe/Sortino, max drawdown, concentration (HHI), and Markdown tear sheets. **No API keys** — all inputs are user-provided data.

[![Available on MCPize](https://img.shields.io/badge/MCPize-Available-blue)](https://mcpize.com/mcp/trading-risk-metrics-mcp)

## Live on MCPize

| | |
|--|--|
| **Marketplace** | https://mcpize.com/mcp/trading-risk-metrics-mcp |
| **Gateway (hosted MCP)** | https://trading-risk-metrics-mcp.mcpize.run |
| **Manage / analytics** | https://mcpize.com/developer/servers/6bc1cfe4-59b9-4e30-9b57-c66c166a2892/manage |

Connect your client from the marketplace page (install snippets and auth are configured there). Subscribers use MCPize-issued credentials; the CLI session token is for **your** dashboard/deploy, not for calling `*.mcpize.run` as a subscriber.

## Tools

| Tool | Description |
|------|-------------|
| `validate_dataset` | Validate transactions + prices; duplicates, missing symbols, schema issues |
| `normalize_transactions` | Map broker-style CSV/JSON rows to the canonical transaction schema |
| `compute_risk_metrics` | Build daily mark-to-market series, returns, risk ratios, VaR/ES, HHI |
| `generate_tearsheet` | One-call Markdown report + JSON metrics + small audit manifest files |

PRD / brief: see `../mcp-brief-trading-risk-metrics-mcp.md` in the parent `mcp_servers` folder.

## Quick start

```bash
npm install
npm run build
PORT=8080 node dist/index.js
```

- Health: `http://localhost:8080/health`
- MCP (Streamable HTTP): `http://localhost:8080/mcp`

### MCPize dev (recommended)

```bash
mcpize dev              # hot reload; default port 3000
mcpize dev --playground # interactive browser testing
```

## Input shape

- **Transactions** (CSV or JSON array): `datetime`, `symbol`, `side` (`buy` / `sell`), `quantity` (positive), `price`, `price_ccy`, optional `txn_id`, `fees`, …
- **Prices** (long format): `date`, `symbol`, `close`, `ccy`

Optional: `columnMapping` maps canonical field names → your column names (see tool descriptions).

## Development

```bash
npm test                 # vitest unit tests
npm run build            # tsc → dist/
bash test-mcp.sh         # MCP protocol smoke (server must be running)
```

Smoke test (after `npm run build`):

```bash
PORT=3000 node dist/index.js &
sleep 2
MCP_URL=http://localhost:3000 bash test-mcp.sh
```

All `curl` calls to `/mcp` must send header `Accept: application/json, text/event-stream`.

## Deploy

```bash
mcpize doctor
mcpize deploy
```

This server does **not** require publisher secrets — optional env vars are standard `PORT` / `NODE_ENV` only.

## License

MIT

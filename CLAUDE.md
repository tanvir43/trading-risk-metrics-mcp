# trading-risk-metrics-mcp — dev notes

TypeScript MCP server on **Streamable HTTP** (`POST /mcp`) for MCPize Cloud. Spec: `../mcp-brief-trading-risk-metrics-mcp.md`.

## Layout

```
src/
  index.ts                 # Express + MCP tool registration
  tools.ts                 # validate / normalize / metrics / tear sheet orchestration
  lib/
    schemas.ts             # Zod canonical types + RiskDatasetInputSchema
    parse-input.ts         # CSV/JSON rows → canonical rows (Papa Parse)
    portfolio-metrics.ts # Mark-to-market series, returns, VaR/ES, Sharpe/Sortino, HHI
tests/tools.test.ts
test-mcp.sh                # Protocol smoke (needs running server)
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | `tsx watch src/index.ts` |
| `npm run build` | `tsc` → `dist/` |
| `npm test` | Vitest on `tools.ts` |
| `mcpize dev` | MCPize dev server (loads `.env`) |
| `mcpize dev --playground` | Tunnel + browser playground |
| `mcpize doctor` | Pre-deploy checks |
| `bash test-mcp.sh` | JSON-RPC initialize + tools/list + sample tools/call |

## Adding a tool

1. Implement pure logic in `src/tools.ts` or `src/lib/*.ts`.
2. Register in `src/index.ts` with `server.registerTool(...)` — always return `content` + `structuredContent`, `try/catch` → `isError: true` with actionable text.
3. Extend `tests/tools.test.ts` and `test-mcp.sh` if the tool is part of the public contract.

## Env

- `PORT` — listen port (default **8080**; `mcpize dev` often uses **3000**).
- `NODE_ENV=production` — disables color dev logging.

No API keys required for this product.

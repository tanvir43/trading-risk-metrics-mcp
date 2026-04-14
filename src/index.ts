import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import chalk from "chalk";
import {
  validateDataset,
  normalizeTransactions,
  computeRiskMetricsTool,
  generateTearsheet,
} from "./tools.js";
import { RiskDatasetInputSchema, TransactionRowSchema } from "./lib/schemas.js";

// ============================================================================
// Dev Logging Utilities
// ============================================================================

const isDev = process.env.NODE_ENV !== "production";

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function formatLatency(ms: number): string {
  if (ms < 100) return chalk.green(`${ms}ms`);
  if (ms < 500) return chalk.yellow(`${ms}ms`);
  return chalk.red(`${ms}ms`);
}

function truncate(str: string, maxLen = 60): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function logRequest(method: string, params?: unknown): void {
  if (!isDev) return;

  const paramsStr = params ? chalk.gray(` ${truncate(JSON.stringify(params))}`) : "";
  console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.cyan("→")} ${method}${paramsStr}`);
}

function logResponse(method: string, result: unknown, latencyMs: number): void {
  if (!isDev) return;

  const latency = formatLatency(latencyMs);

  if (method === "tools/call" && result) {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    console.log(
      `${chalk.gray(`[${timestamp()}]`)} ${chalk.green("←")} ${truncate(resultStr)} ${chalk.gray(`(${latency})`)}`
    );
  } else {
    console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.green("✓")} ${method} ${chalk.gray(`(${latency})`)}`);
  }
}

function logError(method: string, error: unknown, latencyMs: number): void {
  const latency = formatLatency(latencyMs);

  let errorMsg: string;
  if (error instanceof Error) {
    errorMsg = error.message;
  } else if (typeof error === "object" && error !== null) {
    const rpcError = error as { message?: string; code?: number };
    errorMsg = rpcError.message || `Error ${rpcError.code || "unknown"}`;
  } else {
    errorMsg = String(error);
  }

  console.log(
    `${chalk.gray(`[${timestamp()}]`)} ${chalk.red("✖")} ${method} ${chalk.red(truncate(errorMsg))} ${chalk.gray(`(${latency})`)}`
  );
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new McpServer({
  name: "trading-risk-metrics-mcp",
  version: "1.0.0",
});

const validateInputSchema = {
  transactionsCsv: z.string().optional().describe("CSV string of transactions (header row required)"),
  transactionsJson: z.string().optional().describe("JSON array of transaction objects, or CSV string"),
  pricesCsv: z.string().optional().describe("CSV string of daily prices"),
  pricesJson: z.string().optional().describe("JSON array of price rows, or CSV string"),
  baseCcy: z.string().optional().describe("Portfolio base currency, default USD"),
  columnMapping: z
    .record(z.string(), z.string())
    .optional()
    .describe('Map canonical fields to your column names, e.g. {"datetime":"Date","symbol":"Ticker"}'),
};

server.registerTool(
  "validate_dataset",
  {
    title: "Validate dataset",
    description:
      "Validate transactions and price exports: schema checks, duplicate txn_id hints, missing price symbols.",
    inputSchema: validateInputSchema,
    outputSchema: {
      ok: z.boolean(),
      baseCcy: z.string(),
      transactionCount: z.number(),
      priceCount: z.number(),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
      preview: z.object({
        transactions: z.array(z.record(z.string(), z.unknown())),
        prices: z.array(z.record(z.string(), z.unknown())),
      }),
    },
  },
  async (args) => {
    try {
      const output = validateDataset(args);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: message,
              suggestion: "Check CSV headers or pass columnMapping for non-standard column names.",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "normalize_transactions",
  {
    title: "Normalize transactions",
    description: "Map CSV or JSON rows to the canonical transaction schema (buy/sell, positive quantity).",
    inputSchema: {
      csvOrJson: z
        .string()
        .min(1)
        .describe("CSV string with header row, or JSON array string of transaction objects"),
      columnMapping: z.record(z.string(), z.string()).optional().describe("Canonical field name → your column name"),
    },
    outputSchema: {
      normalized: z.array(z.record(z.string(), z.unknown())),
      warnings: z.array(z.string()),
      rowCount: z.number(),
    },
  },
  async ({ csvOrJson, columnMapping }) => {
    try {
      const output = normalizeTransactions(csvOrJson, columnMapping);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: message,
              suggestion: "Ensure csvOrJson is valid CSV with headers or a JSON array of objects.",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

const riskMetricsInputShape = RiskDatasetInputSchema.shape;

server.registerTool(
  "compute_risk_metrics",
  {
    title: "Compute risk metrics",
    description:
      "From normalized transactions + daily prices, compute returns, volatility, Sharpe/Sortino, max drawdown, historical VaR/ES, and concentration (HHI). No external APIs.",
    inputSchema: {
      transactions: z.array(TransactionRowSchema).describe("Canonical transaction rows"),
      prices: z.array(
        z.object({
          date: z.string(),
          symbol: z.string(),
          close: z.number(),
          ccy: z.string(),
        })
      ).describe("Daily close prices (long format)"),
      fxRates: riskMetricsInputShape.fxRates,
      baseCcy: z.string().optional().describe("Default USD"),
      riskFreeAnnual: riskMetricsInputShape.riskFreeAnnual,
      varConfidence: riskMetricsInputShape.varConfidence,
    },
    outputSchema: {
      datasetFingerprint: z.string(),
      metrics: z.record(z.string(), z.unknown()),
    },
  },
  async (args) => {
    try {
      if (!args.transactions?.length) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "transactions array is empty",
                suggestion: "Provide at least one buy/sell row, or use normalize_transactions on your export first.",
              }),
            },
          ],
          isError: true,
        };
      }
      const output = computeRiskMetricsTool(args);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output as { datasetFingerprint: string; metrics: Record<string, unknown> },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: message,
              suggestion: "Validate inputs with validate_dataset; ensure price dates cover your trade window.",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "generate_tearsheet",
  {
    title: "Generate tear sheet",
    description:
      "One-call Markdown tear sheet plus JSON metrics and a small audit manifest (fingerprints, methodology version).",
    inputSchema: {
      transactions: z.array(TransactionRowSchema),
      prices: z.array(
        z.object({
          date: z.string(),
          symbol: z.string(),
          close: z.number(),
          ccy: z.string(),
        })
      ),
      fxRates: riskMetricsInputShape.fxRates,
      baseCcy: z.string().optional(),
      riskFreeAnnual: riskMetricsInputShape.riskFreeAnnual,
      varConfidence: riskMetricsInputShape.varConfidence,
      title: z.string().optional().describe("Report title"),
    },
    outputSchema: {
      markdown: z.string(),
      json: z.record(z.string(), z.unknown()),
      artifacts: z.array(
        z.object({
          name: z.string(),
          mimeType: z.string(),
          content: z.string(),
        })
      ),
    },
  },
  async (args) => {
    try {
      if (!args.transactions?.length) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "transactions array is empty",
                suggestion: "Load and normalize your broker export, then call generate_tearsheet.",
              }),
            },
          ],
          isError: true,
        };
      }
      const output = generateTearsheet(args);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: message,
              suggestion: "Run validate_dataset on the same data to see specific row-level issues.",
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const body = req.body;

  const method = body?.method || "unknown";
  const params = body?.params;

  if (method === "tools/call") {
    const toolName = params?.name || "unknown";
    const toolArgs = params?.arguments;
    logRequest(`tools/call ${chalk.bold(toolName)}`, toolArgs);
  } else if (method !== "notifications/initialized") {
    logRequest(method, params);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  let responseBody = "";
  const originalWrite = res.write.bind(res) as typeof res.write;
  const originalEnd = res.end.bind(res) as typeof res.end;

  res.write = function (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) {
    if (chunk) {
      responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    }
    return originalWrite(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.end = function (chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) {
    if (chunk) {
      responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    }

    if (method !== "notifications/initialized") {
      const latency = Date.now() - startTime;

      try {
        const rpcResponse = JSON.parse(responseBody) as { result?: unknown; error?: unknown };

        if (rpcResponse?.error) {
          logError(method, rpcResponse.error, latency);
        } else if (method === "tools/call") {
          const content = (rpcResponse?.result as { content?: Array<{ text?: string }> })?.content;
          const resultText = content?.[0]?.text;
          logResponse(method, resultText, latency);
        } else {
          logResponse(method, null, latency);
        }
      } catch {
        logResponse(method, null, latency);
      }
    }

    return originalEnd(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.on("close", () => {
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.use((_err: unknown, _req: Request, res: Response, _next: Function) => {
  res.status(500).json({ error: "Internal server error" });
});

const port = parseInt(process.env.PORT || "8080");
const httpServer = app.listen(port, () => {
  console.log();
  console.log(chalk.bold("MCP Server running on"), chalk.cyan(`http://localhost:${port}`));
  console.log(`  ${chalk.gray("Health:")} http://localhost:${port}/health`);
  console.log(`  ${chalk.gray("MCP:")}    http://localhost:${port}/mcp`);

  if (isDev) {
    console.log();
    console.log(chalk.gray("─".repeat(50)));
    console.log();
  }
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  httpServer.close(() => {
    process.exit(0);
  });
});

/**
 * Pure tool functions — portfolio validation, normalization, risk metrics, tear sheets.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  NormalizedDatasetSchema,
  RiskDatasetInputSchema,
  TransactionRowSchema,
  type NormalizedDataset,
  type PriceRow,
  type TransactionRow,
} from "./lib/schemas.js";
import { mapRowToPrice, mapRowToTransaction, rowsFromCsvOrJson } from "./lib/parse-input.js";
import {
  buildTearsheetMarkdown,
  computeRiskMetrics,
  type RiskMetricsResult,
} from "./lib/portfolio-metrics.js";

function datasetFingerprint(ds: NormalizedDataset): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ t: ds.transactions, p: ds.prices, b: ds.baseCcy }));
  return h.digest("hex").slice(0, 16);
}

export interface ValidateDatasetResult {
  [key: string]: unknown;
  ok: boolean;
  baseCcy: string;
  transactionCount: number;
  priceCount: number;
  errors: string[];
  warnings: string[];
  preview: { transactions: TransactionRow[]; prices: PriceRow[] };
}

export function validateDataset(input: {
  transactionsCsv?: string;
  transactionsJson?: string;
  pricesCsv?: string;
  pricesJson?: string;
  baseCcy?: string;
  columnMapping?: Record<string, string>;
}): ValidateDatasetResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const baseCcy = input.baseCcy ?? "USD";
  let transactions: TransactionRow[] = [];
  let prices: PriceRow[] = [];

  if (input.transactionsCsv?.trim()) {
    try {
      const rows = rowsFromCsvOrJson(input.transactionsCsv);
      rows.forEach((r, i) => {
        try {
          transactions.push(TransactionRowSchema.parse(mapRowToTransaction(r, input.columnMapping)));
        } catch (e) {
          errors.push(`Transaction row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } catch (e) {
      errors.push(`Transactions CSV/JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (input.transactionsJson?.trim()) {
    try {
      const rows = rowsFromCsvOrJson(input.transactionsJson);
      rows.forEach((r, i) => {
        try {
          transactions.push(TransactionRowSchema.parse(mapRowToTransaction(r, input.columnMapping)));
        } catch (e) {
          errors.push(`Transaction row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } catch (e) {
      errors.push(`Transactions JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (input.pricesCsv?.trim()) {
    try {
      const rows = rowsFromCsvOrJson(input.pricesCsv);
      rows.forEach((r, i) => {
        try {
          prices.push(mapRowToPrice(r, input.columnMapping));
        } catch (e) {
          errors.push(`Price row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } catch (e) {
      errors.push(`Prices CSV/JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (input.pricesJson?.trim()) {
    try {
      const rows = rowsFromCsvOrJson(input.pricesJson);
      rows.forEach((r, i) => {
        try {
          prices.push(mapRowToPrice(r, input.columnMapping));
        } catch (e) {
          errors.push(`Price row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } catch (e) {
      errors.push(`Prices JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!input.transactionsCsv?.trim() && !input.transactionsJson?.trim()) {
    warnings.push("No transactions provided — risk metrics will be limited.");
  }
  if (!input.pricesCsv?.trim() && !input.pricesJson?.trim()) {
    errors.push("Prices are required (pricesCsv or pricesJson).");
  }

  const txnIds = new Map<string, number>();
  for (const t of transactions) {
    if (t.txn_id) txnIds.set(t.txn_id, (txnIds.get(t.txn_id) ?? 0) + 1);
  }
  for (const [id, c] of txnIds) {
    if (c > 1) warnings.push(`Duplicate txn_id detected: ${id} (${c} rows)`);
  }

  const symbolsWithTx = new Set(transactions.map((t) => t.symbol.trim()));
  const symbolsWithPx = new Set(prices.map((p) => p.symbol.trim()));
  for (const s of symbolsWithTx) {
    if (!symbolsWithPx.has(s)) warnings.push(`No price rows found for traded symbol: ${s}`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    baseCcy,
    transactionCount: transactions.length,
    priceCount: prices.length,
    errors,
    warnings,
    preview: {
      transactions: transactions.slice(0, 5),
      prices: prices.slice(0, 5),
    },
  };
}

export interface NormalizeTransactionsResult {
  [key: string]: unknown;
  normalized: TransactionRow[];
  warnings: string[];
  rowCount: number;
}

export function normalizeTransactions(csvOrJson: string, mapping?: Record<string, string>): NormalizeTransactionsResult {
  const rows = rowsFromCsvOrJson(csvOrJson);
  const warnings: string[] = [];
  const normalized: TransactionRow[] = [];
  rows.forEach((r, i) => {
    try {
      normalized.push(TransactionRowSchema.parse(mapRowToTransaction(r, mapping)));
    } catch (e) {
      warnings.push(`Skipped row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (normalized.length === 0 && rows.length > 0) {
    warnings.push("No rows could be normalized — check column names or provide columnMapping.");
  }
  return { normalized, warnings, rowCount: normalized.length };
}

export interface ComputeRiskMetricsResult {
  [key: string]: unknown;
  datasetFingerprint: string;
  metrics: RiskMetricsResult;
}

export function computeRiskMetricsTool(input: unknown): ComputeRiskMetricsResult {
  const parsed = RiskDatasetInputSchema.parse(input);
  const { riskFreeAnnual, varConfidence, ...ds } = parsed;
  const metrics = computeRiskMetrics(ds, { riskFreeAnnual, varConfidence });
  return {
    datasetFingerprint: datasetFingerprint(ds),
    metrics,
  };
}

export interface GenerateTearsheetResult {
  [key: string]: unknown;
  markdown: string;
  json: {
    datasetFingerprint: string;
    methodologyVersion: string;
    metrics: RiskMetricsResult;
  };
  artifacts: Array<{ name: string; mimeType: string; content: string }>;
}

export function generateTearsheet(input: {
  transactions: TransactionRow[];
  prices: PriceRow[];
  fxRates?: NormalizedDataset["fxRates"];
  baseCcy?: string;
  riskFreeAnnual?: number;
  varConfidence?: number;
  title?: string;
}): GenerateTearsheetResult {
  const ds = NormalizedDatasetSchema.parse({
    transactions: input.transactions,
    prices: input.prices,
    fxRates: input.fxRates,
    baseCcy: input.baseCcy ?? "USD",
  });
  const metrics = computeRiskMetrics(ds, {
    riskFreeAnnual: input.riskFreeAnnual,
    varConfidence: input.varConfidence,
  });
  const title = input.title ?? "Portfolio tear sheet";
  const markdown = buildTearsheetMarkdown(ds, metrics, title);
  const fingerprint = datasetFingerprint(ds);
  const json = {
    datasetFingerprint: fingerprint,
    methodologyVersion: "1.0.0",
    metrics,
  };
  return {
    markdown,
    json,
    artifacts: [
      { name: "tearsheet.md", mimeType: "text/markdown", content: markdown },
      { name: "metrics.json", mimeType: "application/json", content: JSON.stringify(json, null, 2) },
      {
        name: "manifest.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            datasetFingerprint: fingerprint,
            methodologyVersion: "1.0.0",
            baseCcy: ds.baseCcy,
            rowCounts: { transactions: ds.transactions.length, prices: ds.prices.length },
          },
          null,
          2
        ),
      },
    ],
  };
}

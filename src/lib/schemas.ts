import { z } from "zod";

/** Canonical transaction row after normalization */
export const TransactionRowSchema = z.object({
  txn_id: z.string().optional(),
  datetime: z.string().describe("ISO 8601 or parseable date-time"),
  symbol: z.string().min(1),
  asset_type: z.string().default("equity"),
  side: z.string().min(1),
  quantity: z.number().positive(),
  price: z.number(),
  price_ccy: z.string().min(1),
  fees: z.number().optional(),
  fees_ccy: z.string().optional(),
  taxes: z.number().optional(),
  taxes_ccy: z.string().optional(),
  net_cash: z.number().optional(),
  cash_ccy: z.string().optional(),
  fx_rate: z.number().optional(),
  account: z.string().optional(),
  tag: z.string().optional(),
});

export type TransactionRow = z.infer<typeof TransactionRowSchema>;

export const PriceRowSchema = z.object({
  date: z.string().describe("YYYY-MM-DD or ISO date"),
  symbol: z.string().min(1),
  close: z.number(),
  ccy: z.string().min(1),
});

export type PriceRow = z.infer<typeof PriceRowSchema>;

export const FxRateRowSchema = z.object({
  date: z.string(),
  base_ccy: z.string(),
  quote_ccy: z.string(),
  rate: z.number(),
});

export type FxRateRow = z.infer<typeof FxRateRowSchema>;

export const NormalizedDatasetSchema = z.object({
  transactions: z.array(TransactionRowSchema),
  prices: z.array(PriceRowSchema),
  fxRates: z.array(FxRateRowSchema).optional(),
  baseCcy: z.string().default("USD"),
});

export type NormalizedDataset = z.infer<typeof NormalizedDatasetSchema>;

/** Dataset plus optional risk parameters (tools/call input). */
export const RiskDatasetInputSchema = NormalizedDatasetSchema.extend({
  riskFreeAnnual: z.number().optional().describe("Annual risk-free rate as decimal, e.g. 0.04 for 4%"),
  varConfidence: z.number().min(0.5).max(0.999).optional().describe("Confidence level for historical VaR/ES, e.g. 0.95"),
});

export type RiskDatasetInput = z.infer<typeof RiskDatasetInputSchema>;

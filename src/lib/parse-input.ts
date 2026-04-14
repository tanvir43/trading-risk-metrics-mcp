import Papa from "papaparse";
import type { TransactionRow, PriceRow } from "./schemas.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  const data = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(data)) throw new Error("JSON must be an array of objects");
  return data;
}

export function rowsFromCsvOrJson(csvOrJson: string): Record<string, unknown>[] {
  const t = csvOrJson.trim();
  if (t.startsWith("[")) {
    const arr = parseJsonArray(t);
    return arr.map((row, i) => {
      if (!isRecord(row)) throw new Error(`Row ${i} is not an object`);
      return row;
    });
  }
  const parsed = Papa.parse<Record<string, unknown>>(csvOrJson, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length) {
    const msg = parsed.errors.map((e) => `${e.row ?? "?"}: ${e.message}`).join("; ");
    throw new Error(`CSV parse error: ${msg}`);
  }
  return parsed.data.filter((r) => Object.keys(r).length > 0);
}

export function getCell(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (k in row && row[k] !== "" && row[k] !== null && row[k] !== undefined) return row[k];
  }
  return undefined;
}

function num(v: unknown, field: string): number {
  if (v === undefined || v === null || v === "") throw new Error(`Missing numeric field: ${field}`);
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (Number.isNaN(n)) throw new Error(`Invalid number for ${field}`);
  return n;
}

function str(v: unknown, field: string): string {
  if (v === undefined || v === null) throw new Error(`Missing string field: ${field}`);
  return String(v).trim();
}

/** Map arbitrary CSV/JSON row to canonical transaction using optional column aliases (canonicalKey -> sourceColumn). */
export function mapRowToTransaction(
  row: Record<string, unknown>,
  mapping?: Record<string, string>
): TransactionRow {
  const m = (canonical: string, fallbacks: string[]) => {
    const src = mapping?.[canonical];
    const keys = src ? [src, ...fallbacks] : fallbacks;
    return getCell(row, keys);
  };

  const datetime = str(m("datetime", ["datetime", "date", "Date", "timestamp", "Timestamp", "Date/Time"]), "datetime");
  const symbol = str(m("symbol", ["symbol", "Symbol", "ticker", "Ticker", "pair", "Pair"]), "symbol");
  const atRaw = m("asset_type", ["asset_type", "AssetType", "asset", "Asset"]);
  const asset_type =
    atRaw !== undefined && atRaw !== "" ? str(atRaw, "asset_type") : "equity";
  const sideRaw = str(m("side", ["side", "Side", "type", "Type", "Transaction Type"]), "side").toLowerCase();
  const side =
    sideRaw === "b" || sideRaw === "buy"
      ? "buy"
      : sideRaw === "s" || sideRaw === "sell"
        ? "sell"
        : sideRaw;

  const quantityRaw = num(m("quantity", ["quantity", "Quantity", "shares", "Shares", "qty", "Qty", "amount", "Amount"]), "quantity");
  const quantity = Math.abs(quantityRaw);
  const price = Math.abs(num(m("price", ["price", "Price", "px", "Px", "close", "Close"]), "price"));
  const price_ccy = str(m("price_ccy", ["price_ccy", "currency", "Currency", "ccy", "Ccy"]), "price_ccy");

  const feesRaw = m("fees", ["fees", "Fees", "commission", "Commission"]);
  const taxesRaw = m("taxes", ["taxes", "Taxes"]);

  const out: TransactionRow = {
    txn_id: m("txn_id", ["txn_id", "id", "Id", "trade_id", "TradeID"]) as string | undefined,
    datetime,
    symbol,
    asset_type,
    side,
    quantity,
    price,
    price_ccy,
  };

  if (feesRaw !== undefined) out.fees = num(feesRaw, "fees");
  if (taxesRaw !== undefined) out.taxes = num(taxesRaw, "taxes");
  const net = m("net_cash", ["net_cash", "Value", "value", "Net"]);
  if (net !== undefined) out.net_cash = num(net, "net_cash");

  return out;
}

export function mapRowToPrice(row: Record<string, unknown>, mapping?: Record<string, string>): PriceRow {
  const m = (canonical: string, fallbacks: string[]) => {
    const src = mapping?.[canonical];
    return getCell(row, src ? [src, ...fallbacks] : fallbacks);
  };
  const date = str(m("date", ["date", "Date", "datetime", "Datetime"]), "date");
  const symbol = str(m("symbol", ["symbol", "Symbol", "ticker", "Ticker"]), "symbol");
  const close = num(m("close", ["close", "Close", "price", "Price", "quote", "Quote"]), "close");
  const ccy = str(m("ccy", ["ccy", "Ccy", "currency", "Currency"]), "ccy");
  return { date: date.slice(0, 10), symbol, close, ccy };
}

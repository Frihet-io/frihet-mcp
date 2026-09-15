/**
 * Period contract for the READ-ONLY fiscal modelo summaries.
 *
 * Single source for BOTH the client (which query param to send) and the tools
 * (what to validate before calling, what to compare after). Mirrors the
 * deployed Frihet-ERP backend (functions/src/publicApi.ts):
 *   - 303/130 read `?quarter=YYYY-Q[1-4]`, default current quarter
 *   - 390     reads `?year=YYYY`, default current year
 *   - 347     reads `?year=YYYY`, default current year
 * Every other modelo code has no backend route (404 "Unknown fiscal model").
 * The backend silently answers the CURRENT period for any param it does not
 * read, so the param name here is load-bearing.
 */

export interface FiscalPeriodRule {
  /** Query param the backend reads. */
  param: "quarter" | "year";
  pattern: RegExp;
  format: string;
}

export const FISCAL_PERIOD_RULES: Readonly<Record<string, FiscalPeriodRule>> = {
  "303": { param: "quarter", pattern: /^\d{4}-Q[1-4]$/, format: "YYYY-Q1..YYYY-Q4" },
  "130": { param: "quarter", pattern: /^\d{4}-Q[1-4]$/, format: "YYYY-Q1..YYYY-Q4" },
  "390": { param: "year", pattern: /^\d{4}$/, format: "YYYY" },
  "347": { param: "year", pattern: /^\d{4}$/, format: "YYYY" },
};

/**
 * Query object for GET /fiscal/modelo/{code}. Throws for a modelo code without
 * a backend rule so no caller can fall back to an ignored `?period=` param.
 */
export function fiscalModeloQuery(
  modeloCode: string,
  period?: string,
): Record<string, string | undefined> {
  const rule = FISCAL_PERIOD_RULES[modeloCode];
  if (!rule) {
    throw new Error(`No deployed fiscal summary backend for Modelo ${modeloCode}`);
  }
  return { [rule.param]: period };
}

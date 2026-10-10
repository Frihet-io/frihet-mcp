/**
 * MCP Prompts for the Frihet ERP server.
 *
 * Prompts are pre-built templates that guide common business workflows.
 * They return structured messages that an LLM can follow step-by-step,
 * using the available Frihet tools to complete each action.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

/** Exact prompt registrations below; runtime capture gates this value. */
export const MCP_PROMPT_COUNT = 10;

export function registerAllPrompts(server: McpServer): void {
  // -- monthly-close --

  server.registerPrompt(
    "monthly-close",
    {
      title: "Monthly Close",
      description:
        "Guide through closing the month: review unpaid invoices, categorize uncategorized expenses, " +
        "check tax obligations, and generate a financial summary. " +
        "/ Guía para el cierre mensual: revisar facturas impagadas, categorizar gastos, " +
        "verificar obligaciones fiscales y generar resumen.",
      argsSchema: {
        month: z
          .string()
          .optional()
          .describe("Month to close in YYYY-MM format (defaults to previous month) / Mes a cerrar"),
      },
    },
    async ({ month }) => {
      const targetMonth = month || "the previous month";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Perform the monthly close for ${targetMonth}. Follow these steps in order:\n\n` +
                `1. UNPAID INVOICES\n` +
                `   - Use list_invoices to find all invoices with status "sent" or "overdue"\n` +
                `   - For each overdue invoice, note the client name, amount, and days overdue\n` +
                `   - Summarize total outstanding receivables\n\n` +
                `2. EXPENSE REVIEW\n` +
                `   - Use list_expenses to get all expenses for the period\n` +
                `   - Identify any expenses without a category — suggest categories based on the description\n` +
                `   - Flag any unusually large expenses that might need review\n` +
                `   - Calculate total expenses by category\n\n` +
                `3. REVENUE SUMMARY\n` +
                `   - List all invoices with status "paid" for the period\n` +
                `   - Calculate total revenue, total tax collected (IVA/IGIC)\n` +
                `   - Compare with expenses to get net profit/loss\n\n` +
                `4. TAX CHECK\n` +
                `   - Read frihet://tax/calendar to check if any tax filings are due\n` +
                `   - Calculate preliminary IVA/IGIC balance (output tax - input tax)\n` +
                `   - Flag if quarterly filing deadline is approaching\n\n` +
                `5. SUMMARY REPORT\n` +
                `   - Total invoiced (draft/sent/paid/overdue/cancelled counts)\n` +
                `   - Total revenue (paid invoices)\n` +
                `   - Total expenses by category\n` +
                `   - Net position\n` +
                `   - Action items (overdue follow-ups, uncategorized expenses, upcoming tax deadlines)`,
            },
          },
        ],
      };
    },
  );

  // -- onboard-client --

  server.registerPrompt(
    "onboard-client",
    {
      title: "Onboard New Client",
      description:
        "Set up a new client: create the client record, determine correct tax rates based on their location, " +
        "and optionally create a welcome quote. " +
        "/ Dar de alta un nuevo cliente: crear ficha, determinar impuestos según ubicación y crear presupuesto de bienvenida.",
      argsSchema: {
        clientName: z.string().describe("Client or company name / Nombre del cliente o empresa"),
        country: z
          .string()
          .optional()
          .describe("Client country ISO code (e.g. ES, DE, US) / Código de país"),
        region: z
          .string()
          .optional()
          .describe("Spanish region if applicable (peninsula, canarias, ceuta, melilla) / Región española"),
      },
    },
    async ({ clientName, country, region }) => {
      const locationContext = country
        ? `The client is located in ${country}${region ? ` (${region})` : ""}.`
        : "Ask the client for their country and region to determine the correct tax rate.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Onboard a new client: "${clientName}". ${locationContext}\n\n` +
                `Follow these steps:\n\n` +
                `1. DETERMINE TAX RATE\n` +
                `   - Read frihet://tax/rates to look up the correct rate\n` +
                `   - Peninsula Spain → IVA 21% (general)\n` +
                `   - Canary Islands → IGIC 7% (general)\n` +
                `   - Ceuta/Melilla → IPSI 10%\n` +
                `   - EU B2B → 0% reverse charge (need their VAT number)\n` +
                `   - Outside EU → 0% export exempt\n` +
                `   - Confirm the rate with the user before proceeding\n\n` +
                `2. CREATE CLIENT RECORD\n` +
                `   - Use create_client with the client name\n` +
                `   - Ask for: email, phone, taxId (NIF/CIF/VAT number), address\n` +
                `   - Set the country in the address based on location\n\n` +
                `3. WELCOME QUOTE (optional)\n` +
                `   - Ask if the user wants to create an initial quote for this client\n` +
                `   - If yes, ask for the services/products and prices\n` +
                `   - Use create_quote with the correct tax rate\n` +
                `   - Set validUntil to 30 days from now\n\n` +
                `4. SUMMARY\n` +
                `   - Confirm the client record was created\n` +
                `   - State the tax rate that should be used for this client\n` +
                `   - List any missing information that should be filled in later`,
            },
          },
        ],
      };
    },
  );

  // -- quarterly-tax-prep --

  server.registerPrompt(
    "quarterly-tax-prep",
    {
      title: "Quarterly Tax Preparation",
      description:
        "Prepare for quarterly tax filing: list all invoices and expenses for the quarter, calculate IVA/IGIC totals, " +
        "identify deductible expenses, and generate a Modelo 303/130/420 preview. " +
        "/ Preparar la declaración trimestral: facturas, gastos, cálculo de IVA/IGIC, gastos deducibles y vista previa del modelo.",
      argsSchema: {
        quarter: z
          .string()
          .optional()
          .describe("Quarter in format Q1-Q4 and year, e.g. 'Q1 2026' (defaults to current quarter) / Trimestre"),
        fiscalZone: z
          .enum(["peninsula", "canarias", "ceuta", "melilla"])
          .optional()
          .describe("Fiscal zone for tax calculation / Zona fiscal"),
      },
    },
    async ({ quarter, fiscalZone }) => {
      const targetQuarter = quarter || "the current quarter";
      const zone = fiscalZone || "peninsula";
      const taxType = zone === "canarias" ? "IGIC" : zone === "peninsula" ? "IVA" : "IPSI";
      const modelo = zone === "canarias" ? "420" : "303";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Prepare the quarterly tax filing for ${targetQuarter} (fiscal zone: ${zone}, tax: ${taxType}).\n\n` +
                `Follow these steps:\n\n` +
                `1. GATHER INVOICES\n` +
                `   - Use list_invoices to get all invoices for the quarter\n` +
                `   - Filter by date range for the quarter period\n` +
                `   - Separate by status: paid, sent, overdue, cancelled\n` +
                `   - Calculate total revenue (base imponible) and total ${taxType} collected (${taxType} repercutido)\n\n` +
                `2. GATHER EXPENSES\n` +
                `   - Use list_expenses to get all expenses for the quarter\n` +
                `   - Read frihet://config/expense-categories for deductibility rules\n` +
                `   - Categorize expenses and calculate deductible ${taxType} (${taxType} soportado)\n` +
                `   - Flag any expenses missing receipts or with questionable deductibility\n\n` +
                `3. TAX CALCULATION\n` +
                `   - Read frihet://tax/rates to confirm the applicable rates\n` +
                `   - ${taxType} to pay = ${taxType} repercutido (collected) - ${taxType} soportado (deductible)\n` +
                `   - If negative, it is a refund (a compensar o devolver)\n\n` +
                `4. MODELO ${modelo} PREVIEW\n` +
                `   - Base imponible (taxable base): sum of invoice subtotals\n` +
                `   - ${taxType} devengado (output tax): sum of tax on invoices\n` +
                `   - ${taxType} deducible (input tax): sum of deductible tax on expenses\n` +
                `   - Resultado (result): output - input = amount to pay or refund\n\n` +
                `5. MODELO 130 PREVIEW (IRPF advance)\n` +
                `   - Net income = Revenue - Deductible expenses\n` +
                `   - Advance payment = 20% of net income\n` +
                `   - Subtract any previous quarterly payments already made\n\n` +
                `6. FILING REMINDER\n` +
                `   - Read frihet://tax/calendar for the filing deadline\n` +
                `   - Note: this is a PREVIEW only — actual filing must be done through AEAT/ATC\n` +
                `   - List any issues that need resolution before filing`,
            },
          },
        ],
      };
    },
  );

  // -- overdue-followup --

  server.registerPrompt(
    "overdue-followup",
    {
      title: "Overdue Invoice Follow-up",
      description:
        "Find all overdue invoices, draft follow-up messages for each client, and suggest payment reminders. " +
        "/ Buscar facturas vencidas, redactar mensajes de seguimiento y sugerir recordatorios de pago.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Help me prepare overdue invoice follow-ups for review.

1. GATHER RECORDS
   - Use list_invoices for sent, partial and overdue records. Paginate every result set using the returned pagination fields until exhausted; deduplicate by invoice ID. If a page fails or results are incomplete, disclose that limitation.
   - Use get_invoice when detail is missing. Record invoice ID/number, client, currency, due date and remaining unpaid balance after recorded payments and credits. Do not count full invoice totals as outstanding for partially paid records. If balance cannot be verified, flag it as unknown instead of assuming it.
   - Confirm the as-of date and workspace timezone. Separate not-yet-due and due-today invoices from overdue invoices. Missing or invalid due dates need review, not an invented age. Invoice status alone does not prove delivery.

2. GROUP AND DRAFT
   - Group verified positive overdue balances by client and currency; never sum different currencies or infer conversion rates. Show the source invoices, balances and days overdue.
   - Use get_client to verify contact details. Draft a neutral, professional reminder in English and Spanish, listing invoice numbers, due dates, remaining balances and currencies. Do not assume why payment is late or that a debt is undisputed.

3. USER REVIEW
   - Present drafts, recipients and supporting records for user approval before any actions, including sending messages, changing records or setting reminders.
   - Do not automatically impose late fees, write off balances, stop work, threaten collection, assign collectible probabilities or make business decisions based on age alone. Ask the user to review disputes and their agreed terms.
   - Summarize overdue balances per currency, clients affected, oldest verified overdue invoice and any missing evidence. Keep not-yet-due balances separate.`,
          },
        },
      ],
    }),
  );

  // -- new-client-invoice --

  server.registerPrompt(
    "new-client-invoice",
    {
      title: "New Client + First Invoice",
      description:
        "Create a new client and their first invoice in one workflow. Handles tax rate lookup based on " +
        "client location, client record creation, and invoice generation. " +
        "/ Crear un nuevo cliente y su primera factura en un solo flujo. Determina impuestos, crea cliente y factura.",
      argsSchema: {
        clientName: z.string().describe("Client or company name / Nombre del cliente o empresa"),
        country: z
          .string()
          .optional()
          .describe("Client country ISO code (e.g. ES, DE, US) / Codigo de pais"),
      },
    },
    async ({ clientName, country }) => {
      const locationContext = country
        ? `The client is located in ${country}.`
        : "Ask for the client's country to determine the correct tax rate.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Create a new client "${clientName}" and their first invoice. ${locationContext}\n\n` +
                `Follow these steps:\n\n` +
                `1. GET BUSINESS CONTEXT\n` +
                `   - Call get_business_context to understand the business defaults and plan limits\n` +
                `   - Note the default tax rate and currency\n\n` +
                `2. DETERMINE TAX RATE\n` +
                `   - Read frihet://tax/rates for the correct rate based on client location\n` +
                `   - Peninsula Spain: IVA 21% | Canary Islands: IGIC 7% | EU B2B: 0% reverse charge | Outside EU: 0%\n` +
                `   - Confirm with the user before proceeding\n\n` +
                `3. CREATE CLIENT\n` +
                `   - Use create_client with: name, email, taxId (NIF/CIF/VAT), address\n` +
                `   - Ask the user for any missing details\n\n` +
                `4. CREATE FIRST INVOICE\n` +
                `   - Ask what services/products to include with quantities and prices\n` +
                `   - Use create_invoice with the correct tax rate and client name\n` +
                `   - Set status to 'draft' for review\n` +
                `   - Set dueDate to 30 days from today unless specified otherwise\n\n` +
                `5. SUMMARY\n` +
                `   - Show the client record and invoice created\n` +
                `   - State the tax rate applied and total amount\n` +
                `   - Suggest: send the invoice when ready, or duplicate_invoice for recurring billing`,
            },
          },
        ],
      };
    },
  );

  // -- expense-report --

  server.registerPrompt(
    "expense-report",
    {
      title: "Expense Report",
      description:
        "Generate an expense report grouped by category for a given period. Shows totals, " +
        "deductible amounts, top vendors, and flags uncategorized expenses. " +
        "/ Genera un informe de gastos agrupado por categoria para un periodo. Totales, deducibles, proveedores.",
      argsSchema: {
        month: z
          .string()
          .optional()
          .describe("Month in YYYY-MM format (defaults to current month) / Mes en formato YYYY-MM"),
      },
    },
    async ({ month }) => {
      const targetMonth = month || "the current month";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Generate an expense report for ${targetMonth}.\n\n` +
                `Follow these steps:\n\n` +
                `1. GATHER EXPENSES\n` +
                `   - Use list_expenses with the date range for the month\n` +
                `   - If there are more than 50, paginate to get all of them\n\n` +
                `2. CATEGORIZE & GROUP\n` +
                `   - Read frihet://config/expense-categories for the category definitions\n` +
                `   - Group expenses by category\n` +
                `   - For uncategorized expenses, suggest the best category and flag for review\n\n` +
                `3. GENERATE REPORT\n` +
                `   Present a clear report with:\n` +
                `   - TOTAL expenses for the period\n` +
                `   - Breakdown by category (amount, count, % of total)\n` +
                `   - Top 5 vendors by spend\n` +
                `   - Tax-deductible total vs non-deductible\n` +
                `   - Deductible IVA/IGIC total (input tax for quarterly filing)\n\n` +
                `4. INSIGHTS\n` +
                `   - Compare with get_monthly_summary for the same period\n` +
                `   - Flag any expenses >€500 that might need amortization instead of full deduction\n` +
                `   - Note any categories with unusual spending vs typical patterns\n` +
                `   - Identify expenses missing receipts (no vendor = likely missing documentation)\n\n` +
                `5. ACTION ITEMS\n` +
                `   - List uncategorized expenses that need categorization\n` +
                `   - List expenses that may need receipts\n` +
                `   - Suggest if any expenses should be reclassified`,
            },
          },
        ],
      };
    },
  );

  // -- year-end-close --

  server.registerPrompt(
    "year-end-close",
    {
      title: "Year-End Close",
      description:
        "Annual closing review: summarize revenue, expenses, profit/loss for the entire year, " +
        "check all quarters, flag pending invoices and uncategorized expenses, and generate a year-end checklist. " +
        "/ Cierre anual: resumen de ingresos, gastos, resultado del ejercicio, revisión trimestral " +
        "y checklist de cierre.",
      argsSchema: {
        year: z
          .string()
          .describe("Year to close, e.g. '2025' / Año a cerrar"),
      },
    },
    async ({ year }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Perform the year-end close for ${year}. Follow these steps in order:\n\n` +
                `1. BUSINESS CONTEXT\n` +
                `   - Call get_business_context to understand the business setup, fiscal zone, and plan\n` +
                `   - Note the default tax type (IVA/IGIC/IPSI) and currency\n\n` +
                `2. QUARTERLY REVIEW\n` +
                `   - Call get_quarterly_taxes for Q1 ${year} (months: ${year}-01, ${year}-02, ${year}-03)\n` +
                `   - Call get_quarterly_taxes for Q2 ${year} (months: ${year}-04, ${year}-05, ${year}-06)\n` +
                `   - Call get_quarterly_taxes for Q3 ${year} (months: ${year}-07, ${year}-08, ${year}-09)\n` +
                `   - Call get_quarterly_taxes for Q4 ${year} (months: ${year}-10, ${year}-11, ${year}-12)\n` +
                `   - For each quarter, note: revenue, expenses, tax collected, tax deductible, net result\n\n` +
                `3. PENDING INVOICES\n` +
                `   - Use list_invoices to find all invoices from ${year} with status "draft" or "sent"\n` +
                `   - Draft invoices should be either finalized or cancelled before closing\n` +
                `   - Sent invoices should be followed up or marked as bad debt\n` +
                `   - List each with: invoice number, client, amount, status, date\n\n` +
                `4. UNCATEGORIZED EXPENSES\n` +
                `   - Use list_expenses for the full year ${year}\n` +
                `   - Identify any expenses without a category or with category "other"\n` +
                `   - Read frihet://config/expense-categories for proper categorization\n` +
                `   - Suggest correct categories for each uncategorized expense\n\n` +
                `5. ANNUAL SUMMARY\n` +
                `   Present the full-year numbers:\n` +
                `   - Total revenue (paid invoices): sum across all 4 quarters\n` +
                `   - Total expenses: sum across all 4 quarters, broken down by category\n` +
                `   - Net profit/loss: revenue minus expenses\n` +
                `   - Total tax collected (output tax) vs total tax deductible (input tax)\n` +
                `   - Net tax position for the year (paid vs owed)\n` +
                `   - Invoice breakdown: total count by status (paid, sent, overdue, draft, cancelled)\n\n` +
                `6. YEAR-END CHECKLIST\n` +
                `   Generate actionable items:\n` +
                `   - [ ] Pending draft invoices to finalize or cancel (list them)\n` +
                `   - [ ] Sent/overdue invoices to collect or write off (list them)\n` +
                `   - [ ] Expenses to categorize (list them)\n` +
                `   - [ ] Tax forms to file:\n` +
                `         - Read frihet://tax/calendar for annual filing deadlines\n` +
                `         - Modelo 390 (annual IVA summary) if applicable\n` +
                `         - Modelo 180/190 (retentions summary) if applicable\n` +
                `         - Modelo 100 (IRPF annual return)\n` +
                `   - [ ] Verify all quarterly filings (Modelo 303/420 + 130) were submitted\n` +
                `   - [ ] Reconcile bank statements with recorded transactions\n` +
                `   - [ ] Archive all receipts and supporting documents\n` +
                `   - [ ] Note any carry-forward amounts (negative tax balance, losses)`,
            },
          },
        ],
      };
    },
  );

  // -- cash-flow-forecast --

  server.registerPrompt(
    "cash-flow-forecast",
    {
      title: "Cash Flow Forecast",
      description:
        "Project cash flow for the coming months based on recurring income, recurring expenses, " +
        "overdue receivables, and upcoming tax deadlines. Flags concentration and seasonality risks. " +
        "/ Proyección de flujo de caja: ingresos recurrentes, gastos fijos, cobros pendientes, " +
        "plazos fiscales y alertas de riesgo.",
      argsSchema: {
        months: z
          .string()
          .optional()
          .describe("Number of months to forecast, e.g. '3' (default: 3) / Meses a proyectar"),
      },
    },
    async ({ months }) => {
      const forecastMonths = months ? parseInt(months, 10) || 3 : 3;
      const monthLabel = forecastMonths === 1 ? "month" : "months";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Create a cash flow forecast for the next ${forecastMonths} ${monthLabel}. Follow these steps:\n\n` +
                `1. BUSINESS CONTEXT\n` +
                `   - Call get_business_context to understand the business setup and currency\n` +
                `   - Call get_monthly_summary for the current month to establish the baseline\n\n` +
                `2. PREDICTABLE INCOME\n` +
                `   - Use list_invoices with status "sent" to find expected incoming payments\n` +
                `   - Use list_invoices to identify recurring invoice patterns (same client, similar amounts, regular intervals)\n` +
                `   - For each recurring pattern, project the expected amount per month\n` +
                `   - Note: recurring invoices are the most reliable income predictor\n\n` +
                `3. PREDICTABLE EXPENSES\n` +
                `   - Use list_expenses to review the last 3 months of expenses\n` +
                `   - Identify recurring expenses (same vendor, similar amounts monthly)\n` +
                `   - Read frihet://config/expense-categories to understand categories\n` +
                `   - Project fixed costs per month (software, rent, insurance, subscriptions)\n` +
                `   - Estimate variable costs based on recent trends\n\n` +
                `4. OVERDUE RECEIVABLES\n` +
                `   - Use list_invoices with status "overdue" to find overdue invoices\n` +
                `   - Estimate collection probability:\n` +
                `     - 0-30 days overdue: 80% likely to collect\n` +
                `     - 31-60 days overdue: 50% likely\n` +
                `     - 61-90 days overdue: 25% likely\n` +
                `     - 90+ days overdue: 10% likely (consider write-off)\n` +
                `   - Add weighted amounts to the first forecast month\n\n` +
                `5. TAX OBLIGATIONS\n` +
                `   - Read frihet://tax/calendar for upcoming tax deadlines in the forecast period\n` +
                `   - Estimate quarterly tax payments based on current quarter activity\n` +
                `   - Include these as cash outflows in the months they are due\n\n` +
                `6. MONTHLY PROJECTION\n` +
                `   For each of the next ${forecastMonths} months, present:\n` +
                `   - Expected income (recurring + one-time expected payments)\n` +
                `   - Expected expenses (fixed + estimated variable)\n` +
                `   - Tax payments due (if any)\n` +
                `   - Net cash flow = income - expenses - taxes\n` +
                `   - Running cash position (cumulative)\n\n` +
                `7. RISK ANALYSIS\n` +
                `   Flag the following risks:\n` +
                `   - CLIENT CONCENTRATION: If any single client represents >30% of projected income,\n` +
                `     flag the dependency risk and suggest diversification\n` +
                `   - SEASONALITY: Compare with previous months — if income is trending down,\n` +
                `     flag and estimate the impact\n` +
                `   - TAX DEADLINES: Highlight months with large tax outflows that could cause a cash crunch\n` +
                `   - OVERDUE EXPOSURE: Total amount at risk from overdue invoices\n` +
                `   - NEGATIVE MONTHS: Any months where projected cash flow is negative — suggest actions\n\n` +
                `8. RECOMMENDATIONS\n` +
                `   - If cash flow is tight: suggest invoicing earlier, following up on overdue, reducing discretionary spend\n` +
                `   - If cash flow is healthy: suggest setting aside tax reserves, building an emergency buffer\n` +
                `   - Provide a "worst case" scenario (only 50% of expected income arrives)`,
            },
          },
        ],
      };
    },
  );

  // -- invoice-aging-review --

  server.registerPrompt(
    "invoice-aging-review",
    {
      title: "Invoice Aging Review",
      description:
        "Accounts receivable aging analysis: separate not-yet-due balances from overdue buckets by currency, " +
        "identify top debtors, and suggest collection actions. " +
        "/ Análisis de antigüedad de cuentas por cobrar: agrupar facturas impagadas por tramos, " +
        "identificar mayores deudores y sugerir acciones de cobro.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Prepare an accounts receivable aging review.

1. VERIFY THE DATA
   - Use list_invoices for sent, partial and overdue records. Paginate every result set using the returned pagination fields until exhausted; deduplicate by invoice ID. Report any failed page or incomplete coverage.
   - Use get_invoice when needed to verify currency, due date and remaining unpaid balance after recorded payments and credits. Do not count full invoice totals as outstanding for partially paid invoices. Mark unverifiable balances as unknown; do not invent totals.
   - Confirm the as-of date and workspace timezone. Exclude settled, draft and cancelled records from receivables. Status alone does not establish delivery or an undisputed debt.

2. AGE VERIFIED BALANCES
   - Keep separate buckets: not-yet-due; due today; 1-30 days overdue; 31-60 days overdue; 61-90 days overdue; more than 90 days overdue. Missing or invalid due dates form an unknown-age bucket.
   - Group by currency. For each bucket, show invoice IDs, count, remaining unpaid balance and percentage of that currency's verified receivables (only when the denominator is positive). Never combine currencies without a user-supplied conversion basis.
   - Use get_client for client details and summarize positive balances by client within each currency, showing oldest due dates and missing evidence.

3. REVIEW BEFORE ACTING
   - Present the per-currency report and possible follow-up drafts using overdue-followup for user approval before any actions. A report is not permission to send, change status or create charges.
   - Do not assign arbitrary collectible probabilities, automatically write off balances, impose late fees, stop work or make business decisions from age or amount alone. Ask for the user's terms, dispute context and decision before proposing an action.
   - Keep not-yet-due amounts separate from overdue exposure and disclose unknown balances and incomplete pagination.`,
          },
        },
      ],
    }),
  );

  // -- expense-batch --

  server.registerPrompt(
    "expense-batch",
    {
      title: "Batch Expense Processing",
      description:
        "Process a batch of expenses: help categorize each one, apply correct tax rates, flag items needing receipts. " +
        "/ Procesar lote de gastos: categorizar, aplicar impuestos correctos, marcar los que necesitan justificante.",
      argsSchema: {
        fiscalZone: z
          .enum(["peninsula", "canarias", "ceuta", "melilla"])
          .optional()
          .describe("Fiscal zone for tax deduction rules / Zona fiscal"),
      },
    },
    async ({ fiscalZone }) => {
      const zone = fiscalZone || "peninsula";
      const taxType = zone === "canarias" ? "IGIC" : zone === "peninsula" ? "IVA" : "IPSI";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Help me process a batch of expenses (fiscal zone: ${zone}, tax: ${taxType}).\n\n` +
                `Before we start, read frihet://config/expense-categories to understand the 8 categories and their deductibility rules.\n\n` +
                `For each expense I describe, do the following:\n\n` +
                `1. CATEGORIZE\n` +
                `   - Assign one of the 8 categories: office, travel, software, marketing, professional, equipment, insurance, other\n` +
                `   - Explain why this category fits\n\n` +
                `2. TAX TREATMENT\n` +
                `   - Determine if ${taxType} is deductible on this expense\n` +
                `   - Calculate the deductible ${taxType} amount\n` +
                `   - Note any special rules (e.g., vehicles 50%, meals with limits)\n\n` +
                `3. DEDUCTIBILITY CHECK\n` +
                `   - Is this expense fully deductible, partially deductible, or not deductible?\n` +
                `   - If equipment >€300, note amortization period\n` +
                `   - Flag if the expense seems personal (not deductible)\n\n` +
                `4. RECEIPT STATUS\n` +
                `   - Does this expense need an official invoice (factura) for ${taxType} deduction?\n` +
                `   - A simplified invoice (ticket) works for amounts <€400\n` +
                `   - International purchases may need a different document\n\n` +
                `5. CREATE THE EXPENSE\n` +
                `   - Use create_expense with the suggested category, amount, date, and vendor\n` +
                `   - Set taxDeductible based on the analysis\n` +
                `   - Wait for my confirmation before creating each one\n\n` +
                `I will now describe the expenses one by one. After processing all of them, provide a summary with:\n` +
                `- Total expenses by category\n` +
                `- Total deductible ${taxType}\n` +
                `- Any items flagged for review`,
            },
          },
        ],
      };
    },
  );
}

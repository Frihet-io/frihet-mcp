# Frihet Workflow Recipes

Step-by-step MCP tool call sequences for common business workflows. Each recipe includes trigger phrases, the exact tool sequence, and response formatting templates.

## Monthly Close

**Triggers:** "monthly close", "cierre mensual", "resumen del mes", "month summary"

### Steps

1. `list_invoices` — Filter by current month. Get all invoices regardless of status.
2. `list_expenses` — Filter by current month. Get all expenses.
3. Calculate:
   - Total income (sum of invoice bases)
   - Total expenses (sum of expense amounts)
   - IVA repercutido (IVA from invoices)
   - IVA soportado (IVA from deductible expenses)
   - Net result (income - expenses)
4. Identify unpaid invoices → list them separately for follow-up.
5. Present using the Monthly P&L template below.

### Response Template

```
RESUMEN — {Month} {Year}
═══════════════════════════════════════
Ingresos facturados     {total_income} EUR
  Cobrados              {paid_amount} EUR
  Pendientes            {unpaid_amount} EUR ({unpaid_count} facturas)
(-) Gastos              {total_expenses} EUR
───────────────────────────────────────
Resultado neto          {net_result} EUR

IVA repercutido         {iva_collected} EUR
IVA soportado           {iva_paid} EUR
IVA neto                {iva_net} EUR

{if unpaid invoices}
FACTURAS PENDIENTES
  #{invoice_number}  {client_name}  {amount} EUR  ({days} días)
{/if}
```

## Tax Prep — Modelo 303 (Quarterly IVA)

**Triggers:** "303", "IVA trimestral", "quarterly tax", "tax prep", "preparar impuestos", "modelo 303"

### Steps

1. Determine the quarter from context (default: most recent completed quarter).
2. `list_invoices` — Filter by quarter date range. Sum:
   - Base imponible by IVA rate (21%, 10%, 4%)
   - IVA repercutido by rate
3. `list_expenses` — Filter by quarter date range. Sum:
   - IVA soportado (only from deductible expenses)
4. Calculate:
   - Total IVA repercutido (all rates)
   - Total IVA soportado (deductible)
   - Result = repercutido - soportado
   - If positive → "a ingresar" (pay)
   - If negative → "a compensar" (carry forward) or "a devolver" (refund, Q4 only)
5. Present with line-by-line breakdown matching Modelo 303 structure.

### Response Template

```
MODELO 303 — {Quarter} {Year}
═══════════════════════════════════════
IVA DEVENGADO (REPERCUTIDO)
  Base 21%:     {base_21} EUR    Cuota: {iva_21} EUR
  Base 10%:     {base_10} EUR    Cuota: {iva_10} EUR
  Base 4%:      {base_4} EUR     Cuota: {iva_4} EUR
  Total repercutido:             {total_rep} EUR

IVA DEDUCIBLE (SOPORTADO)
  Bienes y servicios:            {iva_soportado} EUR
  Bienes de inversión:           {iva_inversion} EUR
  Total deducible:               {total_ded} EUR

───────────────────────────────────────
RESULTADO:                       {result} EUR ({a_ingresar|a_compensar})
```

## Tax Prep — Modelo 130 (Quarterly IRPF)

**Triggers:** "130", "IRPF trimestral", "pago fraccionado"

### Steps

1. `list_invoices` — YTD invoices, sum base imponible (excluding IVA).
2. `list_expenses` — YTD deductible expenses, sum amounts.
3. Calculate:
   - Rendimiento neto acumulado = income - expenses (YTD)
   - 20% of rendimiento neto
   - Minus previous quarters' 130 payments (ask user or estimate)
   - Result = amount to pay this quarter

### Response Template

```
MODELO 130 — {Quarter} {Year}
═══════════════════════════════════════
Ingresos acumulados (YTD)    {ytd_income} EUR
Gastos deducibles (YTD)      {ytd_expenses} EUR
Rendimiento neto             {net_income} EUR
20% rendimiento neto         {twenty_pct} EUR
(-) Pagos anteriores         {prev_payments} EUR
───────────────────────────────────────
A INGRESAR:                  {result} EUR
```

## Client Onboarding

**Triggers:** "new client", "nuevo cliente", "add client with invoice", "alta cliente", "onboarding"

### Steps

1. Gather client data: name, taxId (NIF/CIF), email, address, fiscal zone.
2. `create_client` — With all gathered data.
3. If the service/product doesn't exist yet:
   - `create_product` — With name, price, tax rate.
4. `create_invoice` — With:
   - Client ID from step 2
   - Line items (product or custom)
   - Correct tax rate based on client's fiscal zone (see tax-guide.md)
   - IRPF if applicable (professional B2B peninsula)
5. Confirm: "Client {name} created. Invoice #{number} for {amount} EUR ready. Send it?"

### Notes

- Always validate NIF/CIF format: 8 digits + letter (NIF), letter + 7 digits + letter (CIF)
- If address suggests Canarias → use IGIC, not IVA
- If EU address + VAT number → reverse charge
- Ask for payment terms if not specified (default: 30 days)

## Expense Batch

**Triggers:** "log expenses", "gastos del mes", "batch expenses", "registrar gastos", multiple expenses in one message

### Steps

1. Parse all expenses from the user's message. Extract for each:
   - Amount
   - Description
   - Date (default: today)
   - Category (auto-categorize using keyword matching)
   - IVA amount if mentioned
2. For each expense: `create_expense` with parsed data.
3. Present summary table.

### Response Template

```
GASTOS REGISTRADOS — {Date Range}
───────────────────────────────────────
{description}          {amount} EUR  [{category}]  {deductible?}
{description}          {amount} EUR  [{category}]  {deductible?}
{description}          {amount} EUR  [{category}]  {deductible?}
───────────────────────────────────────
Total:                 {total} EUR
Deducible:             {deductible_total} EUR ({pct}%)
IVA recuperable:       {iva_total} EUR
```

### Category Auto-Detection

Match description keywords against categories (see SKILL.md core decision logic). If ambiguous, default to `general` and inform the user.

## Overdue Follow-Up

**Triggers:** "unpaid", "overdue", "morosos", "facturas pendientes", "impagos", "cobrar"

### Steps

1. `list_invoices` — Filter by status `sent` or `overdue`.
2. For each, calculate days since due date.
3. Sort by amount (largest first).
4. Group by severity:
   - **Yellow** (1-15 days): Friendly reminder
   - **Orange** (16-30 days): Firm reminder
   - **Red** (31-60 days): Formal demand
   - **Critical** (60+ days): Legal notice warning
5. For each, suggest action and optionally draft reminder email text.

### Response Template

```
FACTURAS VENCIDAS — {Date}
═══════════════════════════════════════
🔴 MÁS DE 60 DÍAS
  #{number}  {client}  {amount} EUR  ({days}d)  → Reclamación formal

🟠 16-30 DÍAS
  #{number}  {client}  {amount} EUR  ({days}d)  → Segundo aviso

🟡 1-15 DÍAS
  #{number}  {client}  {amount} EUR  ({days}d)  → Recordatorio amable

───────────────────────────────────────
Total pendiente:    {total_overdue} EUR
Facturas vencidas:  {count}
```

## Quote to Invoice Conversion

**Triggers:** "convert quote", "quote accepted", "presupuesto aceptado", "convertir presupuesto"

### Steps

1. `get_quote` — Retrieve the full quote by ID or search by client/description.
2. Verify status is `sent` or `accepted`.
3. `create_invoice` — Copy from quote:
   - Client ID
   - Line items (products, quantities, prices)
   - Notes and conditions
   - Tax rates (verify they're still correct)
4. `update_quote` — Set status to `accepted` if not already.
5. Confirm: "Invoice #{inv_number} created from quote #{quote_number} for {client}. Total: {amount} EUR."

## Invoice List Display

**Triggers:** "list invoices", "mis facturas", "facturas del mes"

### Response Template

```
FACTURAS — {Period}
───────────────────────────────────────
#{number}  {client_name}        {amount} EUR  {STATUS}
#{number}  {client_name}        {amount} EUR  {STATUS}
#{number}  {client_name}        {amount} EUR  {STATUS}
───────────────────────────────────────
Total:     {total} EUR
Cobrado:   {paid} EUR
Pendiente: {unpaid} EUR
```

Status labels: `BORRADOR` / `ENVIADA` / `PAGADA` / `VENCIDA` / `ANULADA`

In English: `DRAFT` / `SENT` / `PAID` / `OVERDUE` / `CANCELLED`

## Expense Report Display

**Triggers:** "expense report", "gastos por categoría", "expense summary"

### Response Template

```
GASTOS — {Period}
───────────────────────────────────────
{category}       {subtotal} EUR  ({count} gastos)
{category}       {subtotal} EUR  ({count} gastos)
{category}       {subtotal} EUR  ({count} gastos)
───────────────────────────────────────
Total:           {total} EUR
Deducible:       {deductible} EUR ({pct}%)
```

## General Formatting Rules

- Currency: always EUR. Format `1,234.56 EUR` (dot for decimals, comma for thousands).
- Dates: `DD/MM/YYYY` for Spanish context, `YYYY-MM-DD` for API calls.
- Use box-drawing characters (`─`, `═`, `│`) for tables in terminal output.
- Align amounts to the right.
- Status labels in the user's language (Spanish by default).
- When presenting totals, always include the tax breakdown if relevant.

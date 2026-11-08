# Frihet ERP Tools for Vercel AI SDK

Native [Vercel AI SDK](https://sdk.vercel.ai/docs) Core Tool integration for [Frihet ERP](https://frihet.io). Add European business management, invoice drafting, and expense analytics to any Next.js, Node.js, or TypeScript AI agent with standard `generateText` or `streamText`.

Compatible with **Vercel AI SDK v4** (`parameters`) and **v5** (`inputSchema`).

---

## 1. Installation

```bash
# Recommended pinned versions
npm install ai@^4.1.0 @ai-sdk/openai@^1.1.0 zod@^3.23.0
# Or for AI SDK v5:
# npm install ai@^5.0.0 @ai-sdk/openai@^1.2.0 zod@^3.23.0
```

---

## 2. Quickstart (Next.js App Router)

See full secured route implementation in [example-nextjs.ts](./example-nextjs.ts).

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createFrihetTools } from './frihet-ai-sdk';

export async function POST(req: Request) {
  // Always authenticate caller & verify workspace in production routes
  const { prompt } = await req.json();

  const tools = createFrihetTools({
    apiKey: process.env.FRIHET_API_KEY,
  });

  const result = await generateText({
    model: openai('gpt-4o'),
    system: 'You are the Frihet ERP Copilot. Provide financial analysis and draft invoices.',
    prompt,
    tools,
    maxSteps: 5, // AI SDK v4 / v5 multi-step execution limit
  });

  return Response.json({ response: result.text });
}
```

---

## 3. Available Tools & Canonical Endpoints

All tools query canonical Frihet ERP REST endpoints:

| Tool Name | Type | Canonical Endpoint | Description |
| :--- | :--- | :--- | :--- |
| `frihet_get_business_context` | Read-only | `GET /context` | Operating summary, default currency, fiscal country. |
| `frihet_get_monthly_summary` | Read-only | `GET /monthly?month=YYYY-MM` | Monthly revenue, expenses, net margin, cash balance. |
| `frihet_get_quarterly_taxes` | Read-only | `GET /quarterly?quarter=YYYY-Q#` | Estimated VAT (Modelo 303) and IRPF withholdings (Modelo 130). |
| `frihet_list_invoices` | Read-only | `GET /invoices` | Invoices with status filter (`draft`, `sent`, `paid`, `overdue`). |
| `frihet_get_invoice` | Read-only | `GET /invoices/:id` | Detailed line items and totals for an invoice ID. |
| `frihet_create_draft_invoice` | **Draft Mutation** | `POST /invoices` | Creates a draft invoice with `status: "draft"`. Never auto-submits to tax authorities. |
| `frihet_list_expenses` | Read-only | `GET /expenses` | Category-filtered expense records. |
| `frihet_create_draft_expense` | **Draft Mutation** | `POST /expenses` | Records a new expense draft for bookkeeper review. |
| `frihet_list_clients` | Read-only | `GET /clients` | Customer profiles and contact details. |
| `frihet_create_client` | Mutation | `POST /clients` | Registers a new client record. |

---

## 4. Governance & Security Guarantees

- **Draft-Only Invariant:** AI tools can only create draft records. Direct tax authority reporting (VeriFactu / TicketBAI / FACe) is blocked by design in AI interfaces.
- **Strict Zod Validation:** Parameters are validated at runtime before making HTTP requests.
- **Idempotency Protection:** All mutating actions automatically send a unique `Idempotency-Key` header to prevent double charges or duplicate draft creation.
- **PII & Secret Redaction:** Sensitive tax identifiers (`taxId`), bank account numbers (`iban`), and API tokens are automatically sanitized in model responses.
- **Tenant Isolation:** The example route enforces caller Bearer authentication and explicit `x-frihet-workspace-id` tenant separation.

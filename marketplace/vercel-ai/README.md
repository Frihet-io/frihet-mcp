# Frihet ERP Tools for Vercel AI SDK

Native [Vercel AI SDK](https://sdk.vercel.ai/docs) Core Tool integration for [Frihet ERP](https://frihet.io). Add European business management, invoice drafting, and expense analytics to any Next.js, Node.js, or TypeScript AI agent with standard `generateText` or `streamText`.

---

## 1. Installation

```bash
npm install ai @ai-sdk/openai zod
```

---

## 2. Quickstart (Next.js App Router)

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createFrihetTools } from './frihet-ai-sdk';

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const tools = createFrihetTools({
    apiKey: process.env.FRIHET_API_KEY,
  });

  const result = await generateText({
    model: openai('gpt-4o'),
    system: 'You are the Frihet ERP Copilot. Provide financial analysis and draft invoices.',
    prompt,
    tools,
    maxSteps: 5,
  });

  return Response.json({ response: result.text });
}
```

---

## 3. Available Tools & Capabilities

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `frihet_get_business_context` | Read-only | Operating summary, default currency, fiscal country. |
| `frihet_get_monthly_summary` | Read-only | Monthly revenue, expenses, net margin, cash balance. |
| `frihet_get_quarterly_taxes` | Read-only | Estimated VAT/IRPF and quarterly filing deadlines. |
| `frihet_list_invoices` | Read-only | Invoices with status filter (`draft`, `sent`, `paid`, `overdue`). |
| `frihet_get_invoice` | Read-only | Detailed line items and totals for an invoice ID. |
| `frihet_create_draft_invoice` | **Draft Mutation** | Creates a draft invoice. Never auto-submits to tax authorities. |
| `frihet_list_expenses` | Read-only | Category-filtered expense records. |
| `frihet_create_draft_expense` | **Draft Mutation** | Records a new expense draft for bookkeeper review. |
| `frihet_list_clients` | Read-only | Customer profiles and contact details. |
| `frihet_create_client` | Mutation | Registers a new client record. |

---

## 4. Governance & Safety Guarantees

- **Draft-Only Invariant:** AI tools can only create draft records. Direct tax authority reporting (VeriFactu / TicketBAI / FACe) is blocked by design in AI interfaces.
- **Strict Zod Validation:** Parameters are validated at runtime before making HTTP requests.
- **Masking:** Sensitive tax IDs and account numbers are sanitized in conversational summaries.

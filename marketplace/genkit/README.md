# Frihet ERP Toolkit for Google Genkit

Official enterprise tools connecting [Google Genkit](https://firebase.google.com/docs/genkit) agents and flows to Frihet ERP.

## Features
- **Native Gemini Optimization:** Specially crafted for Gemini 1.5 Pro, Gemini 1.5 Flash, and Gemini 2.0.
- **Draft-Only Safeguards:** Invoices are generated strictly in `draft` status, preventing unapproved fiscal submissions.
- **European Fiscal Context:** Native support for VAT/IVA (21%, 10%, 4%), Canary Islands IGIC, and IRPF withholdings.
- **Type-Safe:** Built with Zod schemas for strict parameter validation.

## Installation

```bash
npm install genkit @genkit-ai/googleai zod
```

## Quickstart

```typescript
import { genkit } from 'genkit';
import { googleAI, gemini15Flash } from '@genkit-ai/googleai';
import { createFrihetGenkitTools } from './frihet-genkit.js';

const ai = genkit({
  plugins: [googleAI()],
  model: gemini15Flash,
});

// Register tools
const tools = createFrihetGenkitTools(ai, {
  apiKey: process.env.FRIHET_API_KEY,
});

// Generate with tools
const response = await ai.generate({
  prompt: 'Check our outstanding invoices and summarize Q3 taxes.',
  tools,
});

console.log(response.text);
```

## Available Tools

| Tool Name | Description | Safety Mode |
|---|---|---|
| `frihet_get_business_context` | Company legal profile, currency, fiscal regime | Read-Only |
| `frihet_get_monthly_summary` | Monthly revenue, expenses, net margin | Read-Only |
| `frihet_get_quarterly_taxes` | Estimated Modelo 303 (VAT) & Modelo 130 | Read-Only |
| `frihet_list_invoices` | Filter and paginate customer invoices | Read-Only |
| `frihet_get_invoice` | Full invoice details by ID | Read-Only |
| `frihet_create_draft_invoice` | Create draft invoice for human review | **Draft-Only** |
| `frihet_list_expenses` | View business expenses and tax deductions | Read-Only |
| `frihet_create_expense` | Log receipt or deductible operating expense | Creation |
| `frihet_list_clients` | Search customer directory | Read-Only |
| `frihet_create_client` | Register client with tax ID and billing email | Creation |

# Frihet ERP Tool Provider for Dify

Official enterprise tool integration for [Dify](https://dify.ai), enabling LLM-powered applications and autonomous multi-agent teams to manage financial records, monitor cash flow, and draft invoices safely.

## Features
- **Plug & Play:** Conforms to Dify Tool Provider specification (`provider.yaml`).
- **Human-in-the-Loop Safeguards:** Invoicing actions strictly default to `draft` mode.
- **European Fiscal Awareness:** Handles Spanish VAT/IVA rates and IRPF withholdings.

## How to Install in Dify

### Option A: Cloud / Workspace Integration
1. In your Dify Workspace, navigate to **Tools** > **Custom Tools**.
2. Select **Import from YAML/OpenAPI** and upload `provider.yaml`.
3. Provide your `FRIHET_API_KEY` from [https://app.frihet.io/settings/api-keys](https://app.frihet.io/settings/api-keys).

### Option B: Self-Hosted Dify Deployment
1. Copy the `marketplace/dify/` folder into your Dify backend's `api/core/tools/provider/builtin/frihet/`.
2. Restart Dify API container:
   ```bash
   docker compose restart api
   ```
3. The Frihet tool suite will appear in your workspace under Built-in Tools.

## Available Actions
- `get_business_context`: Overview of connected business entity and currencies.
- `get_monthly_summary`: Monthly revenue, expenses, and net margin.
- `get_quarterly_taxes`: Estimated Modelo 303 (VAT) & Modelo 130 balances.
- `list_invoices`: Filter and inspect customer invoices.
- `create_draft_invoice`: Generate reviewable draft invoice.
- `create_expense`: Record a deductible business receipt.

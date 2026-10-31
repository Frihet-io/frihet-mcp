# Frihet ERP Tools for CrewAI

Autonomous agent toolkit for financial management, invoicing, expense tracking, and collections workflows with [CrewAI](https://crewai.com).

## Highlights
- **Human-in-the-Loop Safeguards:** All generated invoices are created in strict `draft` status. Zero irreversible fiscal submissions without human approval.
- **European Fiscal Awareness:** Full support for Spanish/EU VAT rates (IVA/IGIC), IRPF withholdings, and compliant document schemas.
- **Unified Credentialing:** Inject credentials via `FRIHET_API_KEY` or through the `FrihetToolkit(api_key="...")` constructor.

## Installation
```bash
pip install crewai pydantic
# Clone or copy frihet_crewai.py into your project
```

## Quickstart

```python
from crewai import Agent, Task, Crew
from frihet_crewai import FrihetToolkit

# Load tools
toolkit = FrihetToolkit(api_key="fri_live_your_key")
tools = toolkit.get_tools()

# Create Invoicing Specialist Agent
billing_agent = Agent(
    role="Billing Operations Lead",
    goal="Ensure accurate customer invoicing and prompt billing cycle execution",
    backstory="Experienced billing manager ensuring all billable work is converted to reviewable drafts.",
    tools=tools,
)
```

## Available Tools

| Tool Name | Operation | Safety Policy |
|---|---|---|
| `frihet_get_business_context` | Company health KPIs, unpaid balances, plan limits | Read-only |
| `frihet_list_invoices` | List invoices filtered by status (`draft`, `issued`, `paid`, `overdue`) | Read-only |
| `frihet_draft_invoice` | Creates a new customer invoice draft | **Draft-only** (Requires human review) |
| `frihet_list_expenses` | Query expense register with tax breakdown | Read-only |
| `frihet_list_clients` | Search client directory by name, email, or tax ID | Read-only |

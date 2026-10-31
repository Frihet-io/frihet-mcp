# Frihet ERP Tools for Microsoft AutoGen

Official integration toolkit connecting [Microsoft AutoGen](https://microsoft.github.io/autogen/) multi-agent workflows to [Frihet ERP](https://frihet.io).

---

## 1. Quickstart

### Installation
```bash
pip install autogen-agentchat pydantic
```

### Usage
```python
import os
from autogen import ConversableAgent, UserProxyAgent
from frihet_autogen import register_frihet_tools

# Configure assistant
assistant = ConversableAgent(
    name="Frihet_Assistant",
    system_message="You manage accounting and draft invoices via Frihet ERP.",
    llm_config={"model": "gpt-4o", "api_key": os.getenv("OPENAI_API_KEY")},
)

user_proxy = UserProxyAgent(
    name="User_Proxy",
    human_input_mode="NEVER",
)

# Register all Frihet tools
register_frihet_tools(assistant, user_proxy)

# Execute query
user_proxy.initiate_chat(
    assistant,
    message="What were our total revenues in October 2026?"
)
```

---

## 2. Tools Provided

- `frihet_get_business_context`: Overview of current business setup and currency.
- `frihet_get_monthly_summary`: Monthly revenue, expenses, net margin, cash balance.
- `frihet_get_quarterly_taxes`: Estimated quarterly VAT and IRPF withholdings.
- `frihet_list_invoices`: Invoices with status filter (`draft`, `sent`, `paid`, `overdue`).
- `frihet_draft_invoice`: Strictly creates a draft invoice for human review.
- `frihet_list_expenses`: Paginated expense records with category filters.
- `frihet_list_clients`: Customer records and receivables.

---

## 3. Safety Invariants

- **Draft-Only Mutations:** `frihet_draft_invoice` forces `status="draft"`. AI agents cannot legally issue invoices or report to European fiscal authorities (VeriFactu / TicketBAI / FACe).
- **Redaction:** European tax IDs and bank accounts are sanitized in model context.

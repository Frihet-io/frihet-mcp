# Frihet ERP Tools for Microsoft AutoGen

Official integration toolkit connecting [Microsoft AutoGen](https://microsoft.github.io/autogen/) multi-agent workflows to [Frihet ERP](https://frihet.io).

Supports both **AutoGen v0.4+** (`autogen-agentchat`) and classic **AutoGen v0.2** (`pyautogen`).

---

## 1. Quickstart

### Installation

For modern **AutoGen v0.4+** (recommended):
```bash
pip install autogen-agentchat autogen-ext[openai] pydantic
```

For legacy **AutoGen v0.2**:
```bash
pip install pyautogen pydantic
```

---

### Usage

#### AutoGen v0.4+ (Event-Driven AgentChat API)
```python
import os
import asyncio
from autogen_agentchat.agents import AssistantAgent
from autogen_ext.models.openai import OpenAIChatCompletionClient
from frihet_autogen import get_frihet_tools

async def main():
    model_client = OpenAIChatCompletionClient(
        model="gpt-4o",
        api_key=os.getenv("OPENAI_API_KEY"),
    )

    assistant = AssistantAgent(
        name="Frihet_CFO",
        model_client=model_client,
        tools=get_frihet_tools(),
        system_message="You manage accounting and draft invoices via Frihet ERP.",
    )

    response = await assistant.run(task="What were our total revenues in October 2026?")
    print(response.messages[-1].content)

asyncio.run(main())
```

#### AutoGen v0.2 (Classic ConversableAgent Pattern)
```python
import os
from autogen import ConversableAgent, UserProxyAgent
from frihet_autogen import register_frihet_tools

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

- `frihet_get_business_context`: Overview of current business setup, currency, and active limits.
- `frihet_get_monthly_summary`: Monthly revenue, expenses, net margin, cash balance (`/monthly?month=YYYY-MM`).
- `frihet_get_quarterly_taxes`: Estimated quarterly VAT (Modelo 303) and IRPF withholdings (Modelo 130) (`/quarterly?quarter=YYYY-Q#`).
- `frihet_list_invoices`: Invoices with status filter (`draft`, `sent`, `paid`, `overdue`).
- `frihet_draft_invoice`: Strictly creates a draft invoice for human review.
- `frihet_list_expenses`: Paginated expense records with category filters.
- `frihet_list_clients`: Customer records and receivables.

---

## 3. Safety & Architectural Invariants

- **Draft-Only Mutations:** `frihet_draft_invoice` forces `status="draft"`. AI agents cannot legally issue invoices or report to European fiscal authorities (VeriFactu / TicketBAI / FACe).
- **Pydantic Validation:** Line items are strictly validated with `LineItem(description, quantity, unit_price, tax_rate)` before HTTP dispatch, preventing invalid negative values.
- **Idempotency:** Automatic `Idempotency-Key` UUIDv4 headers on all POST/PATCH/DELETE mutations prevent duplicate submissions.
- **PII & Secret Redaction:** Tax IDs (`taxId`), bank accounts (`iban`), API tokens, and secret keys are automatically redacted in model context.
- **Canonical API Endpoints:** All requests query canonical Frihet endpoints (`/monthly`, `/quarterly`) with URL-encoded query parameters.

# Frihet ERP ToolSpec for LlamaIndex

Enterprise integration connecting [LlamaIndex](https://www.llamaindex.ai/) data agents and RAG pipelines to Frihet ERP.

## Highlights
- **Human-in-the-Loop Safe:** Invoices are strictly created in `draft` mode.
- **European Fiscal Standards:** Handles VAT/IVA (21%, 10%, 4%), Canary Islands IGIC, and IRPF deductions.
- **Flexible Integration:** Supports both `BaseToolSpec` and `FunctionTool.from_defaults`.

## Installation

```bash
pip install llama-index-core requests pydantic
```

## Quickstart

```python
import os
from llama_index.llms.openai import OpenAI
from llama_index.core.agent import FunctionCallingAgent
from frihet_llamaindex import FrihetToolSpec

# Initialize Frihet Tools
toolkit = FrihetToolSpec(api_key=os.environ["FRIHET_API_KEY"])
tools = toolkit.to_tool_list()

# Setup Agent
llm = OpenAI(model="gpt-4o", temperature=0)
agent = FunctionCallingAgent.from_tools(tools, llm=llm, verbose=True)

# Run Query
response = agent.chat("Check uncollected invoices and summarize this month's revenue.")
print(response)
```

## Available Tools

| Tool | Purpose | Status |
|---|---|---|
| `frihet_get_business_context` | Business entity, tax regime, currency | Read-Only |
| `frihet_get_monthly_summary` | Revenue, deductible expenses, net margin | Read-Only |
| `frihet_get_quarterly_taxes` | Estimated Modelo 303 (VAT) & Modelo 130 | Read-Only |
| `frihet_list_invoices` | List invoices by status and client | Read-Only |
| `frihet_get_invoice` | Retrieve full invoice details | Read-Only |
| `frihet_create_draft_invoice` | Generate reviewable draft invoice | **Draft-Only** |
| `frihet_list_expenses` | Query expense records and VAT | Read-Only |
| `frihet_create_expense` | Log business expense for tax deduction | Creation |
| `frihet_list_clients` | Search customer directory | Read-Only |
| `frihet_create_client` | Register client with NIF/CIF tax ID | Creation |

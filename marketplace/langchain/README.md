# Frihet ERP Toolkit for LangChain & LangGraph

Enterprise integration toolkit connecting [LangChain](https://www.langchain.com/) and [LangGraph](https://langchain-ai.github.io/langgraph/) agents to Frihet ERP.

## Features
- **Built-in Guardrails:** Write operations create non-destructive drafts exclusively.
- **LangGraph Ready:** Ideal for Human-in-the-Loop workflows (`interrupt_before=["frihet_draft_invoice"]`).
- **European Compliance:** Native handling of VAT/IVA, IGIC, and withholding regimes.

## Quickstart (Python)

```python
import os
from langchain_openai import ChatOpenAI
from langchain.agents import create_openai_tools_agent, AgentExecutor
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from frihet_langchain import FrihetToolkit

# Configure tools
toolkit = FrihetToolkit(api_key=os.environ["FRIHET_API_KEY"])
tools = toolkit.get_tools()

# Setup Agent
llm = ChatOpenAI(model="gpt-4o", temperature=0)
prompt = ChatPromptTemplate.from_messages([
    ("system", "You are an AI financial copilot powered by Frihet ERP."),
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "{input}"),
    MessagesPlaceholder(variable_name="agent_scratchpad"),
])

agent = create_openai_tools_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

# Run Query
response = executor.invoke({"input": "What is our current unpaid invoice balance and top debtors?"})
print(response["output"])
```

## Available Tools

| Tool | Action | Mode |
|---|---|---|
| `frihet_business_context` | High-level company snapshot, withholdings & currency | Read-only |
| `frihet_list_invoices` | Search & paginate customer invoices by status | Read-only |
| `frihet_draft_invoice` | Generate invoice draft for human verification | **Draft-only** |
| `frihet_list_expenses` | Query expense register with tax categorization | Read-only |
| `frihet_search_clients` | Search client directory by business name or tax ID | Read-only |

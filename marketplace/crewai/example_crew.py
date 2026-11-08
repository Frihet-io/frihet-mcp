"""Example multi-agent accounting and collections crew using Frihet ERP tools."""

import os
from crewai import Agent, Crew, Process, Task
from frihet_crewai import FrihetToolkit

# Ensure API key is configured
os.environ.setdefault("FRIHET_API_KEY", "fri_live_your_api_key_here")

# Initialize Frihet Toolkit
toolkit = FrihetToolkit()
tools = toolkit.get_tools()

# Define Agents
cfo_agent = Agent(
    role="Chief Financial Officer",
    goal="Analyze company financial health, oversee quarterly VAT obligations, and optimize working capital",
    backstory="Senior corporate finance advisor specialized in European SME accounting, tax compliance, and cash management.",
    tools=tools,
    verbose=True,
)

collections_agent = Agent(
    role="Accounts Receivable Specialist",
    goal="Review unpaid invoices, detect overdue receivables, and draft client payment reminder notices",
    backstory="Detail-oriented financial controller dedicated to accelerating cash recovery while maintaining stellar client relationships.",
    tools=tools,
    verbose=True,
)

# Define Tasks
audit_task = Task(
    description="Query current business context and summary of unpaid invoices. Identify total outstanding debt and top 3 debtor clients.",
    expected_output="An executive financial brief summarizing open receivables and immediate liquidity risks.",
    agent=cfo_agent,
)

collections_task = Task(
    description="For every invoice that is overdue, inspect the client contact details and prepare a polite collection notice draft for human approval.",
    expected_output="A structured list of collection notice drafts containing invoice ID, client name, days overdue, and communication copy.",
    agent=collections_agent,
)

# Run Crew
crew = Crew(
    agents=[cfo_agent, collections_agent],
    tasks=[audit_task, collections_task],
    process=Process.sequential,
    verbose=True,
)

if __name__ == "__main__":
    result = crew.kickoff()
    print("### Crew Financial Report ###")
    print(result)

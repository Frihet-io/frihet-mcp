"""
Example AutoGen Multi-Agent workflow integrating Frihet ERP tools.
Demonstrates financial analysis and draft invoice proposal.
"""

import os
from autogen import ConversableAgent, UserProxyAgent
from frihet_autogen import (
    register_frihet_tools,
    frihet_get_business_context,
    frihet_get_monthly_summary,
    frihet_list_invoices,
    frihet_draft_invoice
)

def run_finance_workflow():
    llm_config = {
        "model": "gpt-4o",
        "api_key": os.environ.get("OPENAI_API_KEY"),
        "temperature": 0.0,
    }

    # 1. Virtual CFO Agent
    cfo = ConversableAgent(
        name="Virtual_CFO",
        system_message="""You are an expert CFO assistant powered by Frihet ERP.
Your task is to analyze company cashflow, inspect pending invoices, and draft customer bills.
Remember: You can only draft invoices. Final fiscal submission and sending to clients requires the founder's review.""",
        llm_config=llm_config,
    )

    # 2. User Proxy Agent (Executes functions locally)
    user_proxy = UserProxyAgent(
        name="Founder_Proxy",
        is_termination_msg=lambda x: x.get("content", "").rstrip().endswith("TERMINATE"),
        human_input_mode="NEVER",
        max_consecutive_auto_reply=5,
    )

    # Register Frihet tools with AutoGen agents
    register_frihet_tools(cfo, user_proxy)

    # Initiate conversation
    user_proxy.initiate_chat(
        cfo,
        message="Review our October 2026 performance and tell me if there are any overdue invoices that need follow-up."
    )

if __name__ == "__main__":
    run_finance_workflow()

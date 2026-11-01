"""
Example AutoGen Multi-Agent workflow integrating Frihet ERP tools.
Demonstrates financial analysis and reviewable draft invoice proposal.
Supports both modern AutoGen v0.4+ (autogen-agentchat) and v0.2 legacy (pyautogen).
"""

import os
import sys
from frihet_autogen import (
    get_frihet_tools,
    register_frihet_tools,
    frihet_get_business_context,
    frihet_get_monthly_summary,
    frihet_get_quarterly_taxes,
    frihet_list_invoices,
    frihet_draft_invoice,
)

# ---------------------------------------------------------------------------
# Modern AutoGen v0.4+ Pattern (autogen-agentchat)
# ---------------------------------------------------------------------------
async def run_autogen_v04():
    """Runs workflow with AutoGen v0.4+ event-driven AssistantAgent."""
    try:
        from autogen_agentchat.agents import AssistantAgent
        from autogen_ext.models.openai import OpenAIChatCompletionClient
    except ImportError:
        print("[!] autogen-agentchat not installed. Run: pip install autogen-agentchat autogen-ext[openai]")
        return

    model_client = OpenAIChatCompletionClient(
        model="gpt-4o",
        api_key=os.environ.get("OPENAI_API_KEY"),
    )

    cfo_agent = AssistantAgent(
        name="Virtual_CFO",
        model_client=model_client,
        tools=get_frihet_tools(),
        system_message="""You are an expert CFO assistant powered by Frihet ERP.
Your task is to analyze company cashflow, inspect pending invoices, and draft customer bills.
Remember: You can only draft invoices. Final fiscal submission requires human review.""",
    )

    response = await cfo_agent.run(task="Review our October 2026 performance and list pending draft invoices.")
    print("v0.4 CFO Response:", response.messages[-1].content)


# ---------------------------------------------------------------------------
# Classic AutoGen v0.2 Pattern (pyautogen)
# ---------------------------------------------------------------------------
def run_autogen_v02():
    """Runs workflow with AutoGen v0.2 ConversableAgent and UserProxyAgent."""
    try:
        from autogen import ConversableAgent, UserProxyAgent
    except ImportError:
        print("[!] pyautogen not installed. Run: pip install pyautogen")
        return

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
    if "--v02" in sys.argv:
        run_autogen_v02()
    else:
        import asyncio
        try:
            asyncio.run(run_autogen_v04())
        except Exception:
            print("[*] Falling back to v0.2 agent pattern...")
            run_autogen_v02()

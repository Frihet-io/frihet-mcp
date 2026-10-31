"""
Example: Running an autonomous financial assistant using LlamaIndex and Frihet ERP.

Requirements:
    pip install llama-index-core llama-index-llms-openai requests pydantic

Usage:
    export OPENAI_API_KEY="sk-..."
    export FRIHET_API_KEY="fri_live_..."
    python example_agent.py
"""

import os
from llama_index.llms.openai import OpenAI
from llama_index.core.agent import FunctionCallingAgent
from frihet_llamaindex import FrihetToolSpec

def main():
    api_key = os.environ.get("FRIHET_API_KEY")
    if not api_key:
        print("Set FRIHET_API_KEY to run live calls.")
        return

    # Initialize Frihet ToolSpec
    toolkit = FrihetToolSpec(api_key=api_key)
    tools = toolkit.to_tool_list()

    # Initialize LLM & Agent
    llm = OpenAI(model="gpt-4o", temperature=0)
    agent = FunctionCallingAgent.from_tools(tools, llm=llm, verbose=True)

    # Query agent
    response = agent.chat("What is our overall company context and how are Q3 taxes looking?")
    print("\n--- Agent Response ---")
    print(response)

if __name__ == "__main__":
    main()

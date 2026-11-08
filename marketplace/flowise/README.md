# Frihet ERP Custom Tool for Flowise

Connect [Flowise](https://flowiseai.com) AI agents, LangChain chatflows, and multi-agent assistants to Frihet ERP.

## Installation & Setup

1. In Flowise, create or open your Chatflow / Agentflow.
2. Drag a **Custom Tool** node onto the canvas.
3. Set the tool properties:
   - **Tool Name:** `frihet_erp`
   - **Tool Description:** `Query Frihet ERP for business context, monthly summaries, invoices, expenses, and draft reviewable invoices.`
   - **Javascript Function:** Paste the contents of [`frihet_custom_tool.js`](./frihet_custom_tool.js).
4. Configure your `FRIHET_API_KEY` in Flowise Environment Variables or pass it in credentials.

## Supported Invariant
- **Draft-Only Safeguard:** Any call to `create_draft_invoice` creates records strictly with `status: 'draft'`, preventing automated fiscal liability or premature tax declarations.

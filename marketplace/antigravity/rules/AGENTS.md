# Frihet ERP — Fiscal & Operational Guardrails

Apply these rules whenever using Frihet MCP tools for invoicing, quotes, expenses, CRM, banking, or tax workflows:

- **Draft-Only Invariant (`status: "draft"`):** Keep all newly created invoices, quotes, and credit notes strictly in `draft` status unless the user explicitly authorizes issuing or sending a specific, verified document. Creating a draft never authorizes issuing, sending, charging, or filing taxes.
- **Explicit Confirmation for Irreversible Actions:** Before updating, deleting, marking as paid, refunding, sending, or submitting a record to a fiscal authority, present the target record, amounts, currency, recipient, and side effects, and wait for explicit user confirmation.
- **Spanish & EU Indirect Taxes:**
  - **Mainland Spain & Balearic Islands (IVA):** Standard `21%`, reduced `10%`, super-reduced `4%`. Assign tax rates per line item, never as a flat guess across mixed items.
  - **Canary Islands (IGIC):** Standard `7%` (not IVA). Ceuta and Melilla apply **IPSI**. Verify the client's fiscal regime and region before selecting a tax treatment.
  - **IRPF Withholding:** Spanish self-employed professionals (*autónomos*) may apply IRPF withholding (`15%`, or `7%` for newly registered professionals) on B2B invoices to Spanish clients. Never apply IRPF to non-Spanish clients or consumer (B2C) invoices.
  - **EU B2B Intra-Community Supplies:** Validate EU VAT numbers via VIES (`frihet_tax_id_vies_lookup`) before applying reverse-charge or intra-community exemption. Never invent a NIF, CIF, VAT ID, or IBAN.
- **Fiscal Compliance (VeriFactu, TicketBAI, Facturae/FACe):** Never fabricate fiscal hashes, QR codes, or submission acknowledgements. Always query real status via `verifactu_status`, `ticketbai_status`, or `face_status`, and use `get_modelo_*_summary` / `frihet_modelo_*_summary` tools rather than computing tax returns by hand.
- **Multi-Currency & Receivables Integrity:** Always inspect and preserve the currency of each record. Never sum amounts across different currencies or assume `EUR`. For overdue receivables, calculate outstanding balance after partial payments and credit notes rather than using the original invoice total.
- **Idempotency & Timeout Safety:** Always pass an `Idempotency-Key` when supported on mutating operations. If a mutation times out, search existing records before retrying to prevent duplicate documents.

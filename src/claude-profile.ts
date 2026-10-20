/** Claude consultation candidate only: a reviewed read-only selection, not hosted acceptance or certification.
 * Explicit names pin the 156-operation inventory at 176de12; new names fail closed.
 * Handlers remain in the shared registry. OpenAI's frozen profile is independent.
 */
import { GROUPS, type GroupMeta, type ToolGroupId } from "./tool-exposure.js";
import { claudeOutputSchema, claudeResourceResult, claudeToolResult } from "./claude-output-privacy.js";

export const CLAUDE_GROUP_METADATA: Partial<Record<ToolGroupId, GroupMeta>> = {
  invoicing: { ...GROUPS.invoicing, blurb: "Read invoice and quote lists; proposals stay in the conversation and are saved in Frihet by the user." },
  expenses: { ...GROUPS.expenses, blurb: "Read expense and vendor lists; no expense creation or financial classification." },
  crm: { ...GROUPS.crm, blurb: "Read client lists; no contacts, invitations or account changes." },
  catalog: { ...GROUPS.catalog, blurb: "Read product and service lists; no catalog changes." },
};

export const CLAUDE_CANDIDATE_TOOLS: ReadonlySet<string> = new Set([
  "list_clients",
  "list_expenses",
  "list_invoices",
  "list_products",
  "list_quotes",
  "list_vendors",
]);

export const CLAUDE_EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  // Consultation scope is pinned separately from the unchanged ERP credential ceiling.
  ...Object.fromEntries([
    "anomaly_list",
    "apply_deposit",
    "apply_late_fee",
    "attendance_clock_in",
    "attendance_clock_out",
    "categorize_transaction",
    "create_client",
    "create_client_contact",
    "create_client_note",
    "create_credit_note",
    "create_deposit",
    "create_expense",
    "create_invoice",
    "create_product",
    "create_quote",
    "create_recurring_invoice",
    "create_time_entry",
    "create_vendor",
    "create_webhook",
    "delete_client_contact",
    "delete_client_note",
    "delete_deposit",
    "delete_invoice",
    "delete_product",
    "delete_quote",
    "delete_recurring_invoice",
    "delete_time_entry",
    "delete_vendor",
    "delete_webhook",
    "duplicate_invoice",
    "frihet_bank_rule_create",
    "frihet_bank_rules_list",
    "frihet_gl_entry_approve",
    "frihet_gl_entry_audit_log",
    "frihet_gl_entry_reject",
    "frihet_portal_domain_add",
    "frihet_portal_domain_remove",
    "frihet_portal_domain_verify",
    "frihet_portal_onboard_link_generate",
    "frihet_tax_id_vies_lookup",
    "gestoria_template_create",
    "get_bank_account",
    "get_business_context",
    "get_client",
    "get_deposit",
    "get_expense",
    "get_invoice",
    "get_kitchen_ticket",
    "get_modelo_130_summary",
    "get_modelo_303_summary",
    "get_modelo_347_summary",
    "get_modelo_390_summary",
    "get_monthly_summary",
    "get_product",
    "get_quarterly_taxes",
    "get_quote",
    "get_recurring_invoice",
    "get_reservation",
    "get_sale",
    "get_time_entry",
    "get_time_summary",
    "get_vendor",
    "get_webhook",
    "global_search",
    "invite_team_member",
    "kitchen_flow_summary",
    "leave_approve",
    "leave_cancel",
    "leave_list",
    "leave_reject",
    "leave_request_create",
    "list_bank_accounts",
    "list_client_activities",
    "list_client_contacts",
    "list_client_notes",
    "list_deposits",
    "list_kitchen_stations",
    "list_kitchen_tickets",
    "list_menu_items",
    "list_properties",
    "list_recurring_invoices",
    "list_reservations",
    "list_sales",
    "list_team_members",
    "list_terminals",
    "list_time_entries",
    "list_transactions",
    "list_webhooks",
    "log_client_activity",
    "mark_invoice_paid",
    "match_transaction_to_invoice",
    "overtime_report",
    "pause_recurring_invoice",
    "payroll_checklist",
    "payroll_export",
    "period_close_status",
    "permissions_matrix",
    "permissions_me",
    "refund_deposit",
    "remove_team_member",
    "resume_recurring_invoice",
    "run_recurring_now",
    "search_invoices",
    "send_invoice",
    "test_webhook",
    "update_client",
    "update_deposit",
    "update_expense",
    "update_invoice",
    "update_kitchen_ticket",
    "update_product",
    "update_quote",
    "update_recurring_invoice",
    "update_team_member_role",
    "update_time_entry",
    "update_vendor",
    "update_webhook",
    "verifactu_resubmit",
    "verifactu_status",
  ].map((name) => [name, "Outside the Claude consultation profile; use the Frihet app for this operation."])),
  "get_invoice_pdf": "Opaque invoice PDF bytes can contain sensitive fields and cannot be safely redacted by the Claude output boundary.",
  "get_invoice_einvoice": "Raw e-invoice XML and Factur-X PDF artifacts can contain sensitive fields and cannot be safely redacted by the Claude output boundary.",
  "create_reservation": "The handler deliberately defers execution; capability truth marks this deferred.",
  "delete_client": "Linked contacts, notes and activities are left stored but unreachable.",
  "delete_expense": "Linked attachment metadata/object cleanup is not established.",
  "frihet_aiem_calculate": "No deployed backing ERP route; capability truth marks this unavailable.",
  "frihet_modelo_200_summary": "No deployed backing ERP route; capability truth marks this unavailable.",
  "frihet_modelo_202_summary": "No deployed backing ERP route; capability truth marks this unavailable.",
  "frihet_modelo_415_summary": "No deployed backing ERP route; capability truth marks this unavailable.",
  "frihet_modelo_418_summary": "No deployed backing ERP route; capability truth marks this unavailable.",
  "frihet_modelo_425_summary": "No deployed backing ERP route; capability truth marks this unavailable.",
  "gestoria_aging_consolidated": "The handler deliberately defers execution; capability truth marks this deferred.",
  "gestoria_message_send": "The handler deliberately defers execution; capability truth marks this deferred.",
  "gestoria_messages_list": "The handler deliberately defers execution; capability truth marks this deferred.",
  "gestoria_template_bulk_send": "The handler deliberately defers execution; capability truth marks this deferred.",
  "get_modelo_180_summary": "No deployed backing ERP route; capability truth marks this unavailable.",
  "einvoice_export": "The Claude pilot credential carries no einvoice scope (M2, ERP #2477); the ERP returns 403 for this route.",
  "face_status": "The Claude pilot credential carries no einvoice scope (M2, ERP #2477); the ERP returns 403 for this route.",
  "face_submit": "The Claude pilot credential carries no einvoice scope (M2, ERP #2477); the ERP returns 403 for this route.",
  "ticketbai_status": "The Claude pilot credential carries no einvoice scope (M2, ERP #2477); the ERP returns 403 for this route.",
  "ticketbai_submit": "The Claude pilot credential carries no einvoice scope (M2, ERP #2477); the ERP returns 403 for this route.",
  "send_einvoice": "The Claude pilot credential carries no einvoice scope (M2, ERP #2477); no deployed backing ERP route: POST /einvoice/send is unavailable in the ERP (404).",
  "get_einvoice_status": "No deployed backing ERP route: GET /einvoice/status/:id is unavailable in the ERP (404).",
  "validate_einvoice_xml": "No deployed backing ERP route: POST /einvoice/validate is unavailable in the ERP (404).",
  "export_datev": "No deployed backing ERP route: POST /einvoice/export-datev is unavailable in the ERP (404).",
  "ksef_submit": "No deployed backing ERP route; capability truth marks this unavailable.",
  "period_close": "The handler deliberately defers execution; capability truth marks this deferred.",
  "period_reopen": "The handler deliberately defers execution; capability truth marks this deferred.",
  "refund_sale": "Executes an actual Stripe money transfer; excluded under Directory policy section 4.A.",
  "send_quote": "Previewed recipient is not atomically bound and delivery is not retry-safe.",
  "sync_channel": "The handler deliberately defers execution; capability truth marks this deferred."
};

export const CLAUDE_CANDIDATE_RESOURCES: ReadonlySet<string> = new Set([
  "frihet://config/currencies",
]);

export const CLAUDE_EXCLUDED_RESOURCES: Readonly<Record<string, string>> = {
  "frihet://business-profile": "Dynamic workspace context is outside the six-list consultation profile.",
  "frihet://monthly-snapshot": "Dynamic summaries are outside the six-list consultation profile.",
  "frihet://overdue-invoices": "Use the bounded invoice list; this dynamic resource is outside the consultation profile.",
  "frihet://status/plan-limits": "Dynamic account state is outside the six-list consultation profile.",
  "frihet://api/schema": "Reference advertises excluded deletion operations; not a profile-specific contract.",
  "frihet://tax/rates": "Simplified or unverified rates and blanket tax treatments need a source review.",
  "frihet://tax/calendar": "Generalized deadlines are not a verified current filing calendar.",
  "frihet://config/expense-categories": "Deductibility and amortization claims need a source review.",
  "frihet://config/countries": "Country-level tax defaults cannot establish transaction tax treatment.",
  "frihet://config/invoice-statuses": "Conflates sent with delivery and credit notes with payment refunds.",
};

export const CLAUDE_CANDIDATE_PROMPTS: ReadonlySet<string> = new Set();

export const CLAUDE_EXCLUDED_PROMPTS: Readonly<Record<string, string>> = {
  "overdue-followup": "Requires individual record tools outside the consultation profile.",
  "invoice-aging-review": "Requires individual record tools outside the consultation profile.",
  "monthly-close": "Depends on deferred tax/calendar and incomplete outstanding-balance assumptions.",
  "onboard-client": "Depends on deferred tax/rates and blanket location-based tax treatment.",
  "quarterly-tax-prep": "Depends on deferred tax/calendar and simplified tax calculation assumptions.",
  "new-client-invoice": "Depends on deferred tax/rates for location-based rate selection.",
  "expense-report": "Depends on deferred expense-categories and unverified amortization thresholds.",
  "year-end-close": "Depends on deferred expense-categories and tax/calendar.",
  "cash-flow-forecast": "Depends on deferred expense-categories/tax/calendar and arbitrary collection probabilities.",
  "expense-batch": "Depends on deferred expense-categories and blanket deductibility/receipt thresholds.",
};

export const CLAUDE_CANDIDATE_INSTRUCTIONS = `Frihet ERP — read-only Claude consultation profile; Directory acceptance requires separate evidence.
This profile exposes six business lists: clients, invoices, quotes, expenses, vendors and products. Grouped discovery adds list_tool_groups, search_tools and describe_tool. The only resource is frihet://config/currencies; no server prompts are available.
Discover the current session's tools and read each tool's description and io.frihet/capability metadata. Workspace permissions and backing endpoints still govern reads.
For a balance review, paginate list_invoices without a status filter and select relevant records client-side. State which periods, pages and currencies were read, and label incomplete coverage. A total invoice amount is not proof of the remaining unpaid balance; if payment fields are absent, the balance is unknown.
Prepare text proposals in the conversation. Saving drafts, creating or modifying records, sending messages, webhooks, payments and fiscal submissions are outside this connector; the user completes those actions in the Frihet app.
The currencies resource is formatting metadata, not tax advice. Sensitive output fields are omitted under the shared redaction policy, including documentNumber and verifactuHash; free-text fields still require appropriate care.
Do not infer delivery from invoice status, a money transfer from an accounting entry, or production acceptance from demo data. FRIHET_DEMO=1 is fixture-only. Hosting, OAuth, API availability and Directory acceptance require independent verification.`;

/** Install after discovery interception, before registration: denied names never
 * enter the SDK registry or the grouped catalog. Mirrors the OpenAI interceptor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyClaudeCandidateProfile(server: any): void {
  const registerTool = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool = (name: string, config: any, handler: any) => {
    if (!CLAUDE_CANDIDATE_TOOLS.has(name)) return undefined;
    const description = name === "list_clients"
      ? "List clients/customers with optional pagination and search. Returns available contact information and addresses; tax identifiers are omitted. / Lista clientes con paginacion y busqueda opcionales. Devuelve informacion de contacto y direcciones disponibles; omite identificadores fiscales."
      : name === "list_vendors"
        ? "List vendors/suppliers with optional pagination and search. Returns available contact information and addresses; tax identifiers are omitted. / Lista proveedores con paginacion y busqueda opcionales. Devuelve informacion de contacto y direcciones disponibles; omite identificadores fiscales."
        : config.description ?? "";
    return registerTool(name, {
      ...config,
      description: `${description} Claude omits sensitive output fields under the shared redaction policy.`,
      ...(config.outputSchema ? { outputSchema: claudeOutputSchema(config.outputSchema) } : {}),
    }, async (...args: any[]) => {
      try { return claudeToolResult(await handler(...args)); }
      catch {
        return claudeToolResult({ isError: true, _meta: { "io.frihet/operationOutcomeUnknown": true } });
      }
    });
  };

  const registerResource = server.registerResource.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerResource = (name: string, uri: unknown, config: any, handler: any) =>
    typeof uri === "string" && CLAUDE_CANDIDATE_RESOURCES.has(uri)
      ? registerResource(name, uri, config, async (...args: any[]) => {
        try { return claudeResourceResult(await handler(...args), uri); }
        catch { throw new Error("Claude resource response withheld by the privacy boundary"); }
      }) : undefined;

  const registerPrompt = server.registerPrompt.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerPrompt = (name: string, ...args: any[]) =>
    CLAUDE_CANDIDATE_PROMPTS.has(name) ? registerPrompt(name, ...args) : undefined;
}

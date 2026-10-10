/** Claude candidate only: a reviewed selection, not hosted acceptance or certification.
 * Explicit names pin the 158-operation inventory at 3852413; new names fail closed.
 * Handlers remain in the shared registry. OpenAI's frozen profile is independent.
 */
import { GROUPS, type GroupMeta, type ToolGroupId } from "./tool-exposure.js";

export const CLAUDE_GROUP_METADATA: Partial<Record<ToolGroupId, GroupMeta>> = {
  invoicing: { ...GROUPS.invoicing, blurb: "Invoice records and delivery, credit notes, quotes, recurring invoices and deposit bookkeeping; API availability and configured effects must be checked." },
  fiscal: { ...GROUPS.fiscal, blurb: "Modelo 303/130/390/347, VeriFactu, TicketBAI, Facturae/FACe e-invoicing, GL audit, period-close status and VIES; backing endpoints govern availability." },
  hr: { ...GROUPS.hr, blurb: "Leave, attendance, overtime, time tracking, payroll export, team and permissions." },
  stay: { ...GROUPS.stay, blurb: "Read vacation-rental reservations and properties." },
  pos: { ...GROUPS.pos, blurb: "Read terminals, sales and kitchen records; update kitchen ticket status." },
  intelligence: { ...GROUPS.intelligence, blurb: "Business context, monthly/quarterly summaries, search, invoice duplication and gestoría template creation." },
};

export const CLAUDE_CANDIDATE_TOOLS: ReadonlySet<string> = new Set([
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
  "einvoice_export",
  "export_datev",
  "face_status",
  "face_submit",
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
  "get_einvoice_status",
  "get_expense",
  "get_invoice",
  "get_invoice_einvoice",
  "get_invoice_pdf",
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
  "list_clients",
  "list_deposits",
  "list_expenses",
  "list_invoices",
  "list_kitchen_stations",
  "list_kitchen_tickets",
  "list_menu_items",
  "list_products",
  "list_properties",
  "list_quotes",
  "list_recurring_invoices",
  "list_reservations",
  "list_sales",
  "list_team_members",
  "list_terminals",
  "list_time_entries",
  "list_transactions",
  "list_vendors",
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
  "send_einvoice",
  "send_invoice",
  "test_webhook",
  "ticketbai_status",
  "ticketbai_submit",
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
  "validate_einvoice_xml",
  "verifactu_resubmit",
  "verifactu_status",
]);

export const CLAUDE_EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
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
  "ksef_submit": "No deployed backing ERP route; capability truth marks this unavailable.",
  "onboarding_persona_set": "Backend onboarding lifecycle unresolved (Frihet-io/frihet-mcp#124).",
  "onboarding_status": "Backend onboarding lifecycle unresolved (Frihet-io/frihet-mcp#124).",
  "period_close": "The handler deliberately defers execution; capability truth marks this deferred.",
  "period_reopen": "The handler deliberately defers execution; capability truth marks this deferred.",
  "refund_sale": "Executes an actual Stripe money transfer; excluded under Directory policy section 4.A.",
  "send_quote": "Previewed recipient is not atomically bound and delivery is not retry-safe.",
  "sync_channel": "The handler deliberately defers execution; capability truth marks this deferred."
};

export const CLAUDE_CANDIDATE_RESOURCES: ReadonlySet<string> = new Set([
  "frihet://config/currencies",
  "frihet://business-profile",
  "frihet://monthly-snapshot",
  "frihet://overdue-invoices",
  "frihet://status/plan-limits",
]);

export const CLAUDE_EXCLUDED_RESOURCES: Readonly<Record<string, string>> = {
  "frihet://api/schema": "Reference advertises excluded deletion operations; not a profile-specific contract.",
  "frihet://tax/rates": "Simplified or unverified rates and blanket tax treatments need a source review.",
  "frihet://tax/calendar": "Generalized deadlines are not a verified current filing calendar.",
  "frihet://config/expense-categories": "Deductibility and amortization claims need a source review.",
  "frihet://config/countries": "Country-level tax defaults cannot establish transaction tax treatment.",
  "frihet://config/invoice-statuses": "Conflates sent with delivery and credit notes with payment refunds.",
};

export const CLAUDE_CANDIDATE_PROMPTS: ReadonlySet<string> = new Set([
  "overdue-followup",
  "invoice-aging-review",
]);

export const CLAUDE_EXCLUDED_PROMPTS: Readonly<Record<string, string>> = {
  "monthly-close": "Depends on deferred tax/calendar and incomplete outstanding-balance assumptions.",
  "onboard-client": "Depends on deferred tax/rates and blanket location-based tax treatment.",
  "quarterly-tax-prep": "Depends on deferred tax/calendar and simplified tax calculation assumptions.",
  "new-client-invoice": "Depends on deferred tax/rates for location-based rate selection.",
  "expense-report": "Depends on deferred expense-categories and unverified amortization thresholds.",
  "year-end-close": "Depends on deferred expense-categories and tax/calendar.",
  "cash-flow-forecast": "Depends on deferred expense-categories/tax/calendar and arbitrary collection probabilities.",
  "expense-batch": "Depends on deferred expense-categories and blanket deductibility/receipt thresholds.",
};

export const CLAUDE_CANDIDATE_INSTRUCTIONS = `Frihet ERP — local Claude candidate profile, not a published Directory connector.
Discover available tools, resources and prompts from this session's MCP lists. In grouped mode use list_tool_groups, search_tools and describe_tool.
Read get_business_context for workspace context, not proof of tax treatment or endpoint availability.
Read each tool's io.frihet/capability metadata: api_dependent/runtime_checked means workspace permissions and backing endpoints still govern execution.
Resource payloads are workspace records or formatting examples, not authoritative tax advice. The overdue-invoices resource is a status-filtered first page; paginate list_invoices including partial records for a complete balance review.
Propose changes and obtain user approval before writes, email, webhooks or fiscal submission. A confirm input is a client interlock, not proof of authorization.
Read full descriptions and inspect configured external effects before executing. Do not infer delivery from invoice status, a money transfer from an accounting entry, or production acceptance from demo data.
On 409 IDEMPOTENCY_REQUEST_IN_PROGRESS, read the record before deciding; do not retry with a fresh key.
FRIHET_DEMO=1 is fixture-only and cannot verify live operations. No hosted Claude-profile endpoint is established by this package.`;

/** Install after discovery interception, before registration: denied names never
 * enter the SDK registry or the grouped catalog. Mirrors the OpenAI interceptor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyClaudeCandidateProfile(server: any): void {
  const registerTool = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool = (name: string, ...args: any[]) =>
    CLAUDE_CANDIDATE_TOOLS.has(name) ? registerTool(name, ...args) : undefined;

  const registerResource = server.registerResource.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerResource = (name: string, uri: unknown, ...args: any[]) =>
    typeof uri === "string" && CLAUDE_CANDIDATE_RESOURCES.has(uri)
      ? registerResource(name, uri, ...args) : undefined;

  const registerPrompt = server.registerPrompt.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerPrompt = (name: string, ...args: any[]) =>
    CLAUDE_CANDIDATE_PROMPTS.has(name) ? registerPrompt(name, ...args) : undefined;
}

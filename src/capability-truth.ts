/**
 * Public capability truth for the full Frihet MCP surfaces.
 *
 * Registration proves only that a tool name and handler exist. It does not
 * prove that the backing API family is deployed, enabled for a workspace, or
 * authorized for the caller. This profile adds a conservative, machine-readable
 * fact to tools/list and corrects action annotations on the non-OpenAI surface.
 *
 * The OpenAI review profile reuses the same annotation corrections so every
 * public surface reports side effects consistently.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const CAPABILITY_META_KEY = "io.frihet/capability";

export type CapabilityCallability =
  | "api_dependent"
  | "runtime_checked"
  | "deferred"
  | "unavailable"
  | "local";

export type ExternalSideEffect =
  | "email_or_invitation"
  | "webhook_delivery_or_configuration"
  | "fiscal_or_einvoice_submission"
  | "external_provider_read"
  | "external_provider_configuration"
  | "money_movement"
  | "channel_sync";

export interface PublicCapabilityTruth {
  readonly registered: true;
  readonly callability: CapabilityCallability;
  readonly canonicalOperation: string;
  readonly writesFrihet: boolean;
  readonly externalInteraction: boolean;
  readonly externalSideEffects: readonly ExternalSideEffect[];
}

const RUNTIME_CHECKED = new Set([
  "anomaly_list",
  "attendance_clock_in",
  "attendance_clock_out",
  "frihet_aiem_calculate",
  "frihet_bank_rule_create",
  "frihet_bank_rules_list",
  "frihet_gl_entry_approve",
  "frihet_gl_entry_audit_log",
  "frihet_gl_entry_reject",
  "frihet_modelo_200_summary",
  "frihet_modelo_202_summary",
  "frihet_modelo_415_summary",
  "frihet_modelo_418_summary",
  "frihet_modelo_425_summary",
  "frihet_portal_domain_add",
  "frihet_portal_domain_remove",
  "frihet_portal_domain_verify",
  "frihet_portal_onboard_link_generate",
  "frihet_tax_id_vies_lookup",
  "gestoria_template_create",
  "get_modelo_130_summary",
  "get_modelo_180_summary",
  "get_modelo_303_summary",
  "get_modelo_347_summary",
  "get_modelo_390_summary",
  "leave_approve",
  "leave_cancel",
  "leave_list",
  "leave_reject",
  "leave_request_create",
  "onboarding_persona_set",
  "onboarding_status",
  "overtime_report",
  "payroll_checklist",
  "payroll_export",
  "period_close_status",
  "permissions_matrix",
  "permissions_me",
  "verifactu_resubmit",
  "verifactu_status",
  "send_einvoice",
  "get_einvoice_status",
  "validate_einvoice_xml",
  "export_datev",
  "einvoice_export",
  "face_submit",
  "face_status",
  "ticketbai_submit",
  "ticketbai_status",
]);

const DEFERRED = new Set([
  "period_close",
  "period_reopen",
  "gestoria_message_send",
  "gestoria_messages_list",
  "gestoria_template_bulk_send",
  "gestoria_aging_consolidated",
  "create_reservation",
  "sync_channel",
]);

const UNAVAILABLE = new Set(["ksef_submit"]);

const DESTRUCTIVE_UPDATES = new Set([
  // These writes can synchronously enqueue delivery to workspace webhooks.
  // Once an external endpoint receives the event, that disclosure cannot be
  // recalled even if the Frihet record itself remains editable.
  "create_invoice",
  "duplicate_invoice",
  "create_credit_note",
  "create_expense",
  "create_quote",
  "create_client",
  "log_client_activity",
  "create_product",
  "frihet_gl_entry_approve",
  "frihet_gl_entry_reject",
  "send_einvoice",
  "categorize_transaction",
  "update_client",
  "update_deposit",
  "apply_deposit",
  "refund_deposit",
  "update_expense",
  "leave_approve",
  "leave_reject",
  "leave_cancel",
  "attendance_clock_out",
  "update_invoice",
  "send_invoice",
  "mark_invoice_paid",
  "update_kitchen_ticket",
  "onboarding_persona_set",
  "update_product",
  "update_quote",
  "send_quote",
  "update_recurring_invoice",
  "sync_channel",
  "update_team_member_role",
  "update_time_entry",
  "update_vendor",
  "update_webhook",
  "match_transaction_to_invoice",
  "verifactu_resubmit",
  "pause_recurring_invoice",
  "resume_recurring_invoice",
  "run_recurring_now",
  "frihet_portal_domain_verify",
  "face_submit",
  "ticketbai_submit",
  "frihet_portal_domain_add",
]);

const NON_IDEMPOTENT = new Set([
  "create_invoice",
  "duplicate_invoice",
  "create_credit_note",
  "update_invoice",
  "mark_invoice_paid",
  "delete_invoice",
  "create_expense",
  "update_expense",
  "create_quote",
  "update_quote",
  "delete_quote",
  "create_client",
  "log_client_activity",
  "update_client",
  "create_product",
  "update_product",
  "update_vendor",
  "send_invoice",
  "send_quote",
  "sync_channel",
  "verifactu_resubmit",
  "frihet_portal_domain_verify",
  "pause_recurring_invoice",
  "resume_recurring_invoice",
]);

const WRITE_OVERRIDES = new Set(["frihet_portal_domain_verify"]);

const EXTERNAL_SIDE_EFFECTS: Readonly<Record<string, readonly ExternalSideEffect[]>> = {
  create_invoice: ["webhook_delivery_or_configuration", "fiscal_or_einvoice_submission"],
  duplicate_invoice: ["webhook_delivery_or_configuration"],
  create_credit_note: ["webhook_delivery_or_configuration"],
  update_invoice: ["webhook_delivery_or_configuration", "fiscal_or_einvoice_submission"],
  mark_invoice_paid: ["webhook_delivery_or_configuration", "fiscal_or_einvoice_submission"],
  delete_invoice: ["webhook_delivery_or_configuration", "fiscal_or_einvoice_submission"],
  create_expense: ["webhook_delivery_or_configuration"],
  update_expense: ["webhook_delivery_or_configuration"],
  create_quote: ["webhook_delivery_or_configuration"],
  update_quote: ["webhook_delivery_or_configuration"],
  delete_quote: ["webhook_delivery_or_configuration"],
  create_client: ["webhook_delivery_or_configuration"],
  log_client_activity: ["webhook_delivery_or_configuration"],
  update_client: ["webhook_delivery_or_configuration"],
  create_product: ["webhook_delivery_or_configuration"],
  update_product: ["webhook_delivery_or_configuration"],
  send_invoice: [
    "email_or_invitation",
    "webhook_delivery_or_configuration",
    "fiscal_or_einvoice_submission",
  ],
  send_quote: ["email_or_invitation", "webhook_delivery_or_configuration"],
  invite_team_member: ["email_or_invitation"],
  create_webhook: ["webhook_delivery_or_configuration"],
  update_webhook: ["webhook_delivery_or_configuration"],
  delete_webhook: ["webhook_delivery_or_configuration"],
  test_webhook: ["webhook_delivery_or_configuration"],
  send_einvoice: ["fiscal_or_einvoice_submission"],
  face_submit: ["fiscal_or_einvoice_submission"],
  face_status: ["external_provider_read"],
  ticketbai_submit: ["fiscal_or_einvoice_submission"],
  verifactu_resubmit: ["fiscal_or_einvoice_submission"],
  gestoria_message_send: ["email_or_invitation"],
  gestoria_template_bulk_send: ["email_or_invitation"],
  frihet_tax_id_vies_lookup: ["external_provider_read"],
  frihet_portal_domain_add: ["external_provider_configuration"],
  frihet_portal_domain_verify: [
    "external_provider_read",
    "external_provider_configuration",
  ],
  frihet_portal_domain_remove: ["external_provider_configuration"],
  refund_sale: ["money_movement"],
  sync_channel: ["channel_sync"],
};

function callabilityFor(name: string): CapabilityCallability {
  if (UNAVAILABLE.has(name)) return "unavailable";
  if (DEFERRED.has(name)) return "deferred";
  if (RUNTIME_CHECKED.has(name)) return "runtime_checked";
  return "api_dependent";
}

export function correctToolAnnotations(
  name: string,
  annotations: ToolAnnotations | undefined,
): ToolAnnotations {
  const externalInteraction = Object.hasOwn(EXTERNAL_SIDE_EFFECTS, name);
  return {
    ...annotations,
    ...(WRITE_OVERRIDES.has(name) ? { readOnlyHint: false } : {}),
    ...(DESTRUCTIVE_UPDATES.has(name) ? { destructiveHint: true } : {}),
    ...(NON_IDEMPOTENT.has(name) ? { idempotentHint: false } : {}),
    ...(externalInteraction ? { openWorldHint: true } : {}),
  };
}

export function buildPublicCapabilityTruth(
  name: string,
  annotations: ToolAnnotations | undefined,
): PublicCapabilityTruth {
  const effects = Object.hasOwn(EXTERNAL_SIDE_EFFECTS, name)
    ? EXTERNAL_SIDE_EFFECTS[name]
    : [];
  return {
    registered: true,
    callability: callabilityFor(name),
    canonicalOperation: name,
    writesFrihet: annotations?.readOnlyHint !== true,
    externalInteraction: effects.length > 0,
    externalSideEffects: effects,
  };
}

export function buildLocalDiscoveryCapability(
  name: string,
): PublicCapabilityTruth {
  return {
    registered: true,
    callability: "local",
    canonicalOperation: name,
    writesFrihet: false,
    externalInteraction: false,
    externalSideEffects: [],
  };
}

/** Must run after grouped exposure (when grouped) and before registration. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyPublicCapabilityTruth(server: any): void {
  const originalRegisterTool = server.registerTool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool = (name: string, config: any, handler: any) => {
    const annotations = correctToolAnnotations(name, config?.annotations);
    const capability = buildPublicCapabilityTruth(name, annotations);
    config.annotations = annotations;
    config._meta = {
      ...(config?._meta ?? {}),
      [CAPABILITY_META_KEY]: capability,
    };
    return originalRegisterTool(name, config, handler);
  };
}

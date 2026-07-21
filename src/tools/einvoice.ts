/**
 * E-Invoicing tools for the Frihet MCP server.
 *
 * Wired to real CF endpoints at api.frihet.io/v1/invoices/:id/einvoice/*.
 *
 * The 5 per-invoice endpoints below are LIVE server-side (Frihet-ERP publicApi.ts):
 * einvoice/export, face/submit, face/status, ticketbai/submit, ticketbai/status.
 * On a successful fetch the tools return the real CF response unchanged.
 *
 * COMPLIANCE-CRITICAL 404-fallback contract: the stub is dispatched ONLY when the
 * CF returns a genuine 404 (jurisdiction without a deployed CF / endpoint not yet
 * shipped). Any other failure — 4xx auth/validation, 5xx signature/submission
 * error, network error — is RE-THROWN by isNotFoundError()=false and surfaced as a
 * tool error. A real FACe/TicketBAI signature or submission failure MUST NEVER be
 * masked as a successful (queued/accepted) stub.
 *
 * All 10 tools use the shared withToolLogging wrapper (Langfuse tracing applied
 * globally via patchServerWithTracing in register-all.ts).
 *
 * Trace names prefix: mcp.einvoice.*
 * Original 4 CF endpoints: https://api.frihet.io/v1/einvoice/{send,status,validate,export-datev}
 * Day 4 Wave 6 CF endpoints (PR #414 + FACe PR #411 + TicketBAI PR #356) — LIVE:
 *   POST /v1/invoices/:id/einvoice/export  — export XML in specific format (signed Facturae etc.)
 *   POST /v1/invoices/:id/face/submit      — Spain B2G FACe portal submission
 *   GET  /v1/invoices/:id/face/status      — FACe submission status
 *   POST /v1/invoices/:id/ticketbai/submit — Basque Country TicketBAI (Bizkaia/Gipuzkoa/Araba)
 *   GET  /v1/invoices/:id/ticketbai/status — TicketBAI submission status
 *   POST /v1/invoices/:id/ksef/submit      — Poland KSeF (stub — endpoint not yet exposed; returns unavailable)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  mutateContent,
  getContent,
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/*  Honest "backend endpoint not yet available" result                  */
/* ------------------------------------------------------------------ */

/**
 * Build an HONEST unavailable result for a tool whose backend endpoint is not
 * yet deployed.
 *
 * NORTH #2: a tool that returns a fake-success stub on a backend 404 is a HOLE —
 * an AI agent receives fabricated data (a queued workflow, a valid XML, a DATEV
 * file URL) and reports success. SOUL §16: removing that drama is the whole
 * point. So instead of fabricating a plausible-looking payload we return an
 * explicit error result:
 *   - `isError: true`            → the MCP client/agent treats it as a failure
 *   - `_unavailable: true`       → machine-readable marker (also drives the
 *                                  observability downgrade in observability.ts)
 *   - `_plannedEndpoint`         → which REST endpoint will back this when live
 *
 * The agent gets the truth ("not available yet"), never fabricated business data.
 */
function unavailableResult(opts: {
  tool: string;
  plannedEndpoint: string;
  what: string;
  workaround?: string;
}): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const note =
    `${opts.what} is not yet available: the backend endpoint ` +
    `${opts.plannedEndpoint} is not deployed. No data was produced — this is an ` +
    `honest "unavailable" response, NOT a stub success. ` +
    (opts.workaround ? opts.workaround + " " : "") +
    `/ Esta operación aún no está disponible: el endpoint ${opts.plannedEndpoint} ` +
    `no está desplegado. No se ha generado ningún dato.`;
  return {
    content: [{ type: "text" as const, text: `Unavailable — ${opts.what}.\n${note}` }],
    structuredContent: {
      _unavailable: true,
      _note: note,
      _plannedEndpoint: opts.plannedEndpoint,
      tool: opts.tool,
    },
    isError: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Shared format union                                                 */
/* ------------------------------------------------------------------ */

/**
 * All supported e-invoice formats.
 *
 * | Format                  | Standard  | Markets                  | Notes                                              |
 * |-------------------------|-----------|--------------------------|---------------------------------------------------|
 * | xrechnung-cii           | EN16931   | Germany (DE mandatory)   | CII syntax, official DE B2G format                |
 * | xrechnung-ubl           | EN16931   | Germany (DE mandatory)   | UBL 2.1 syntax, alternative DE B2G                |
 * | facturx-en16931         | EN16931   | France, EU               | PDF/A-3 embedded XML, Factur-X EN16931 profile     |
 * | facturx-extended        | EN16931+  | France, EU               | Factur-X Extended — extra logistics/trade fields   |
 * | facturx-basic           | EN16931   | France, EU               | Factur-X Basic — reduced field set                 |
 * | facturx-minimum         | EN16931   | France, EU               | Factur-X Minimum — summary invoices only           |
 * | fatturapa               | SDI       | Italy (IT mandatory)     | XML FatturaPA — sent via SDI interchange hub       |
 * | ubl                     | UBL 2.1   | EU/global                | Generic UBL — use when no country-specific needed  |
 * | cii                     | UN/CEFACT | EU/global                | Generic CII — Cross Industry Invoice XML           |
 * | peppol-bis-3            | PEPPOL    | EU/Nordic/AU/SG          | PEPPOL BIS Billing 3.0 — B2B/B2G network          |
 * | facturae               | Facturae  | Spain (ES B2G mandatory) | Facturae 3.2.x — AEAT/FACe submission              |
 */
export const eInvoiceFormatSchema = z.enum([
  "xrechnung-cii",
  "xrechnung-ubl",
  "facturx-en16931",
  "facturx-extended",
  "facturx-basic",
  "facturx-minimum",
  "fatturapa",
  "ubl",
  "cii",
  "peppol-bis-3",
  "facturae",
]);

export type EInvoiceFormat = z.infer<typeof eInvoiceFormatSchema>;

/* ------------------------------------------------------------------ */
/*  Output schemas                                                      */
/* ------------------------------------------------------------------ */

export const sendEInvoiceOutput = z.object({
  workflowRunId: z.string().describe("Hatchet workflow run ID for polling status"),
  status: z.literal("queued").describe("Always 'queued' for async dispatch"),
  estimatedCompletionSec: z.number().describe("Estimated seconds until the workflow completes"),
}).passthrough();

export const eInvoiceStatusOutput = z.object({
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  step: z.string().describe("Current or last workflow step name"),
  error: z.string().optional().describe("Error message if status is 'failed'"),
  ackId: z.string().optional().describe("Network acknowledgement ID (PEPPOL SBDH / SDI protocol ID / etc.)"),
  pdfA3Url: z.string().optional().describe("Signed URL to download the PDF/A-3 envelope (Factur-X only)"),
  xmlUrl: z.string().optional().describe("Signed URL to download the raw XML file"),
}).passthrough();

export const validateEInvoiceOutput = z.object({
  valid: z.boolean().describe("Whether the XML passes all validation rules"),
  errors: z.array(z.object({
    severity: z.string().describe("'error' | 'warning' | 'info'"),
    location: z.string().describe("XPath or element path where the issue was found"),
    message: z.string().describe("Human-readable validation message"),
    rule: z.string().describe("Rule ID (e.g. 'BR-01', 'PEPPOL-EN16931-R001')"),
  })).describe("List of validation findings (empty if valid)"),
  validator: z.enum(["kosit", "mustang", "xsd", "schematron"]).describe("Validation engine used"),
  durationMs: z.number().describe("Validation duration in milliseconds"),
}).passthrough();

export const exportDatevOutput = z.object({
  fileUrl: z.string().describe("Signed URL to download the DATEV EXTF file"),
  filename: z.string().describe("Suggested filename (e.g. EXTF_Buchungsstapel_2026-01.csv)"),
  rowCount: z.number().describe("Number of accounting rows in the export"),
  fiscalPeriod: z.string().describe("Fiscal period covered (e.g. '2026-01' or '2026-Q1')"),
  encoding: z.literal("cp1252").describe("File encoding — always CP1252 per DATEV EXTF spec"),
}).passthrough();

/* Day 4 Wave output schemas — fields match the LIVE CF response
 * (Frihet-ERP functions/src/publicApi.ts) exactly. No fabricated fields. */

export const einvoiceExportOutput = z.object({
  xml: z.string().describe("Raw e-invoice XML content (the document itself, returned inline by the CF)"),
  contentType: z.string().describe("MIME type of the XML payload (application/xml)"),
  filename: z.string().describe("Suggested filename (e.g. INV-2026-001_Facturae.xml)"),
  signed: z.boolean().describe("Whether XAdES signature was applied (Facturae + signed=true only)"),
  format: z.string().describe("E-invoice format used (echoes the requested format)"),
}).passthrough();

export const faceSubmitOutput = z.object({
  status: z.literal("submitted").describe("Submission accepted by FACe (the CF returns an error otherwise)"),
  numeroRegistro: z.string().describe("FACe registration number (número de registro) returned by the portal"),
  codigo: z.string().describe("FACe result code returned by the portal (resultado.codigo)"),
  descripcion: z.string().describe("Human-readable FACe result description (resultado.descripcion)"),
  idempotent: z.boolean().optional().describe("True if this echoes a prior already-registered submission (no resubmission occurred)"),
}).passthrough();

export const faceStatusOutput = z.object({
  numeroRegistro: z.string().describe("FACe registration number for this submission"),
  estadoTramitacion: z.string().nullable().describe("FACe processing-state code (estado de tramitación)"),
  codigo: z.string().nullable().describe("FACe status code (e.g. '1200'=Registrada, '1400'=Contabilizada, '3100'=Rechazada)"),
  descripcion: z.string().nullable().describe("Human-readable FACe status description"),
  motivo: z.string().nullable().describe("Reason/motive associated with the current status (e.g. rejection motive)"),
}).passthrough();

export const ticketbaiSubmitOutput = z.object({
  accepted: z.boolean().describe("Whether the hacienda foral accepted the submission"),
  csv: z.string().describe("CSV (Código Seguro de Verificación) returned by the hacienda foral"),
  tbaiIdentifier: z.string().describe("TicketBAI identifier (TBAI-XXXXX) returned by the hacienda foral"),
  qrUrl: z.string().describe("QR code URL to print on the invoice (TBAI compliance)"),
  idempotent: z.boolean().optional().describe("True if this echoes a prior already-accepted submission (no resubmission occurred)"),
}).passthrough();

export const ticketbaiStatusOutput = z.object({
  accepted: z.boolean().describe("Whether the submission has been accepted by the hacienda foral"),
  csv: z.string().describe("CSV (Código Seguro de Verificación) for the submission"),
  tbaiIdentifier: z.string().describe("TicketBAI identifier"),
  estado: z.string().describe("Current submission status stored server-side (e.g. 'accepted', 'rejected')"),
  qrUrl: z.string().nullable().describe("QR code URL to print on the invoice (null if not yet available)"),
  submittedAt: z.string().nullable().describe("ISO 8601 timestamp the submission was recorded (null if unknown)"),
  errors: z.array(z.string()).nullable().describe("Hacienda error messages if rejected (null if none)"),
}).passthrough();

export const kSeFSubmitOutput = z.object({
  _notImplemented: z.boolean().optional().describe("Always true — KSeF endpoint not yet exposed as a live API"),
  _note: z.string().optional().describe("Guidance on when the tool activates"),
  _plannedEndpoint: z.string().optional().describe("Planned REST endpoint path"),
  invoiceId: z.string().optional(),
  mode: z.string().optional(),
}).passthrough();

/* ------------------------------------------------------------------ */
/*  Tool registration                                                   */
/* ------------------------------------------------------------------ */

export function registerEInvoiceTools(server: McpServer, _client: IFrihetClient): void {
  // -- send_einvoice --

  server.registerTool(
    "send_einvoice",
    {
      title: "Send E-Invoice",
      description:
        "Dispatch an e-invoice to the recipient via the selected transport channel. " +
        "Returns immediately with a workflowRunId — use get_einvoice_status to poll until completion. " +
        "\n\n" +
        "Supported formats (11 total):\n" +
        "  • xrechnung-cii — XRechnung CII syntax (Germany B2G mandatory)\n" +
        "  • xrechnung-ubl — XRechnung UBL 2.1 syntax (Germany B2G alternative)\n" +
        "  • facturx-en16931 — Factur-X EN16931 PDF/A-3 (France, EU)\n" +
        "  • facturx-extended — Factur-X Extended with trade/logistics fields (France, EU)\n" +
        "  • facturx-basic — Factur-X Basic reduced field set (France, EU)\n" +
        "  • facturx-minimum — Factur-X Minimum for summary invoices (France, EU)\n" +
        "  • fatturapa — FatturaPA XML via SDI hub (Italy mandatory)\n" +
        "  • ubl — Generic UBL 2.1 XML (EU/global)\n" +
        "  • cii — Generic CII Cross Industry Invoice (EU/global)\n" +
        "  • peppol-bis-3 — PEPPOL BIS Billing 3.0 network (EU/Nordic/AU/SG)\n" +
        "  • facturae — Facturae 3.2.x (Spain B2G via FACe/AEAT mandatory)\n" +
        "\n" +
        "Dispatch modes:\n" +
        "  • email — attach XML/PDF and send via Resend to client email on file\n" +
        "  • chorus_pro — submit to French Chorus Pro portal (facturx-* only)\n" +
        "  • sdi — submit to Italian SDI hub (fatturapa only)\n" +
        "  • peppol — transmit via PEPPOL access point (peppol-bis-3 only)\n" +
        "  • download — generate and return a signed download URL only\n" +
        "\n" +
        "If the dispatch backend is not deployed for this workspace, returns an honest 'unavailable' response — never fabricated workflow data. " +
        "/ Envia una factura electronica al destinatario mediante el canal de transporte seleccionado. " +
        "Devuelve de forma asincrona — consultar get_einvoice_status para seguimiento.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("Frihet invoice ID to dispatch / ID de la factura a enviar"),
        format: eInvoiceFormatSchema.describe(
          "E-invoice format. Choose based on recipient country and channel: " +
          "DE→xrechnung-cii/ubl, FR→facturx-*, IT→fatturapa, ES B2G→facturae, EU PEPPOL→peppol-bis-3, " +
          "generic→ubl or cii / Formato de factura electronica.",
        ),
        dispatchMode: z.enum(["email", "chorus_pro", "sdi", "peppol", "download"]).describe(
          "Transport channel: email=send via Resend, chorus_pro=French portal, sdi=Italian SDI hub, " +
          "peppol=PEPPOL network, download=generate URL only / Canal de transporte.",
        ),
      },
      outputSchema: sendEInvoiceOutput,
    },
    async ({ invoiceId, format, dispatchMode }) =>
      withToolLogging("send_einvoice", async () => {
        const plannedEndpoint = "/v1/einvoice/send";
        try {
          const result = await (_client as IFrihetClientWithEInvoice).sendEInvoice({ invoiceId, format, dispatchMode });
          return {
            content: [
              mutateContent(
                `E-invoice queued:\n` +
                `  Invoice: ${invoiceId}\n` +
                `  Format: ${format}\n` +
                `  Dispatch: ${dispatchMode}\n` +
                `  WorkflowRunId: ${result.workflowRunId}\n` +
                `  Status: ${result.status}\n` +
                `  Estimated: ~${result.estimatedCompletionSec}s\n\n` +
                `Use get_einvoice_status with the workflowRunId to poll for completion.`,
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — the /v1/einvoice/send transport endpoint is
            // genuinely absent (not deployed). Do NOT fabricate a queued workflow.
            return unavailableResult({
              tool: "send_einvoice",
              plannedEndpoint,
              what: "E-invoice dispatch",
              workaround:
                "Use einvoice_export to produce the XML, then face_submit (Spain B2G) " +
                "or ticketbai_submit (Basque Country) — those endpoints are live.",
            });
          }
          throw err;
        }
      }),
  );

  // -- get_einvoice_status --

  server.registerTool(
    "get_einvoice_status",
    {
      title: "Get E-Invoice Status",
      description:
        "Poll the status of an e-invoice dispatch workflow. " +
        "Returns current step, ack ID (network confirmation), and download URLs once complete. " +
        "Poll every 5–10 seconds until status is 'succeeded', 'failed', or 'cancelled'. " +
        "\n\n" +
        "If the status backend is not deployed for this workspace, returns an honest 'unavailable' response — never a fabricated status. " +
        "/ Consulta el estado de un flujo de envio de factura electronica.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        workflowRunId: z.string().describe("Hatchet workflow run ID returned by send_einvoice / ID del run de workflow"),
      },
      outputSchema: eInvoiceStatusOutput,
    },
    async ({ workflowRunId }) =>
      withToolLogging("get_einvoice_status", async () => {
        const plannedEndpoint = `/v1/einvoice/status/${workflowRunId}`;
        try {
          const result = await (_client as IFrihetClientWithEInvoice).getEInvoiceStatus(workflowRunId);
          return {
            content: [
              getContent(
                `E-invoice status:\n` +
                `  WorkflowRunId: ${workflowRunId}\n` +
                `  Status: ${result.status}\n` +
                `  Step: ${result.step}\n` +
                (result.ackId ? `  AckId: ${result.ackId}\n` : "") +
                (result.xmlUrl ? `  XML URL: ${result.xmlUrl}\n` : "") +
                (result.pdfA3Url ? `  PDF/A-3 URL: ${result.pdfA3Url}\n` : ""),
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — the /v1/einvoice/status endpoint is genuinely
            // absent. Do NOT fabricate a "succeeded" status + fake XML URL.
            return unavailableResult({
              tool: "get_einvoice_status",
              plannedEndpoint,
              what: "E-invoice dispatch status polling",
            });
          }
          throw err;
        }
      }),
  );

  // -- validate_einvoice_xml --

  server.registerTool(
    "validate_einvoice_xml",
    {
      title: "Validate E-Invoice XML",
      description:
        "Validate an e-invoice XML document against the specified format's schema and schematron rules. " +
        "Returns a list of errors with severity, XPath location, message, and rule ID. " +
        "Runs KOSIT validator (XRechnung), Mustang (EN16931), XSD, or Schematron depending on format. " +
        "\n\n" +
        "Use before dispatch to catch errors early without incurring network transmission costs. " +
        "A valid=true response means the document passes all schema + business rule checks. " +
        "\n\n" +
        "If the validation backend is not deployed for this workspace, returns an honest 'unavailable' response — never a fabricated valid=true. " +
        "/ Valida un documento XML de factura electronica contra el esquema y reglas schematron del formato especificado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        xml: z.string().describe("Raw XML string of the e-invoice document to validate / Contenido XML de la factura electronica"),
        format: eInvoiceFormatSchema.describe(
          "Format to validate against. Determines which validator and ruleset to apply. " +
          "/ Formato a validar. Determina el validador y conjunto de reglas a aplicar.",
        ),
      },
      outputSchema: validateEInvoiceOutput,
    },
    async ({ xml, format }) =>
      withToolLogging("validate_einvoice_xml", async () => {
        const plannedEndpoint = "/v1/einvoice/validate";
        try {
          const result = await (_client as IFrihetClientWithEInvoice).validateEInvoiceXml({ xml, format });
          return {
            content: [
              getContent(
                `E-invoice validation result:\n` +
                `  Format: ${format}\n` +
                `  Valid: ${result.valid}\n` +
                `  Errors: ${result.errors.length}\n` +
                `  Validator: ${result.validator}\n` +
                `  Duration: ${result.durationMs}ms`,
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — the /v1/einvoice/validate endpoint is
            // genuinely absent. Do NOT fabricate valid=true (a fabricated
            // "passes validation" is the most dangerous stub of all: an agent
            // would dispatch an unvalidated invoice believing it is compliant).
            return unavailableResult({
              tool: "validate_einvoice_xml",
              plannedEndpoint,
              what: "E-invoice XML validation",
            });
          }
          throw err;
        }
      }),
  );

  // -- export_datev --

  server.registerTool(
    "export_datev",
    {
      title: "Export DATEV",
      description:
        "Export accounting data in DATEV EXTF format for import into DATEV Kanzlei-Rechnungswesen or compatible systems. " +
        "Returns a signed download URL valid for 24 hours. " +
        "\n\n" +
        "Supported EXTF formats:\n" +
        "  • extf-buchungsstapel — Journal entries (Buchungsstapel) — most common, use for P&L/tax\n" +
        "  • extf-debitoren — Accounts receivable master data (Debitoren-/Kreditorenstamm AR)\n" +
        "  • extf-kreditoren — Accounts payable master data (Debitoren-/Kreditorenstamm AP)\n" +
        "\n" +
        "Output encoding is always CP1252 per DATEV EXTF specification. " +
        "Date range: both periodStart and periodEnd must be ISO 8601 dates (YYYY-MM-DD). " +
        "\n\n" +
        "If the DATEV export backend is not deployed for this workspace, returns an honest 'unavailable' response — never a fabricated file URL. " +
        "/ Exporta datos contables en formato DATEV EXTF para importacion en DATEV o sistemas compatibles.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        periodStart: z.string().describe(
          "Start of the export period (ISO 8601 YYYY-MM-DD). Inclusive. " +
          "/ Inicio del periodo de exportacion (YYYY-MM-DD). Inclusivo.",
        ),
        periodEnd: z.string().describe(
          "End of the export period (ISO 8601 YYYY-MM-DD). Inclusive. " +
          "/ Fin del periodo de exportacion (YYYY-MM-DD). Inclusivo.",
        ),
        format: z.enum(["extf-buchungsstapel", "extf-debitoren", "extf-kreditoren"]).describe(
          "DATEV EXTF export format: extf-buchungsstapel (journal entries), " +
          "extf-debitoren (AR master), extf-kreditoren (AP master) / Formato EXTF de DATEV.",
        ),
      },
      outputSchema: exportDatevOutput,
    },
    async ({ periodStart, periodEnd, format }) =>
      withToolLogging("export_datev", async () => {
        const plannedEndpoint = "/v1/einvoice/export-datev";
        try {
          const result = await (_client as IFrihetClientWithEInvoice).exportDatev({ periodStart, periodEnd, format });
          return {
            content: [
              getContent(
                `DATEV export ready:\n` +
                `  Format: ${format}\n` +
                `  Period: ${periodStart} → ${periodEnd}\n` +
                `  Filename: ${result.filename}\n` +
                `  Rows: ${result.rowCount}\n` +
                `  Encoding: ${result.encoding}\n` +
                `  Download URL: ${result.fileUrl}`,
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — the /v1/einvoice/export-datev endpoint is
            // genuinely absent. Do NOT fabricate a fileUrl pointing at a stub
            // path with rowCount=0 (an agent would hand a broken/empty link to
            // an accountant).
            return unavailableResult({
              tool: "export_datev",
              plannedEndpoint,
              what: "DATEV EXTF export",
            });
          }
          throw err;
        }
      }),
  );

  // -- einvoice_export --

  server.registerTool(
    "einvoice_export",
    {
      title: "Export E-Invoice XML",
      description:
        "Export an invoice as e-invoicing XML in a specific format. " +
        "Supports Facturae (ES B2G), XRechnung-CII (DE), XRechnung-UBL (DE), " +
        "Factur-X profiles (FR), FatturaPA (IT), PEPPOL-BIS-3 (EU network), UBL and CII (generic). " +
        "For Facturae, set signed=true to get XAdES-enveloped XML for FACe/AEAT submission. " +
        "Returns a signed download URL valid for 24 hours. " +
        "\n\n" +
        "/ Exporta una factura como XML de facturacion electronica en el formato especificado. " +
        "Para Facturae con signed=true devuelve XML firmado XAdES para envio a FACe/AEAT.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("Frihet invoice ID to export / ID de la factura a exportar"),
        format: eInvoiceFormatSchema.describe(
          "E-invoice format. Choose based on recipient country: " +
          "ES B2G→facturae, DE→xrechnung-cii/ubl, FR→facturx-*, IT→fatturapa, EU PEPPOL→peppol-bis-3, " +
          "generic→ubl or cii / Formato de factura electronica.",
        ),
        signed: z.boolean().optional().describe(
          "If true, returns XAdES-enveloped signed XML (Facturae only). Requires workspace signing certificate configured. " +
          "/ Si true, devuelve XML firmado XAdES (solo Facturae). Requiere certificado de firma configurado.",
        ),
      },
      outputSchema: einvoiceExportOutput,
    },
    async ({ invoiceId, format, signed }) =>
      withToolLogging("einvoice_export", async () => {
        const plannedEndpoint = `/v1/invoices/${invoiceId}/einvoice/export`;
        try {
          const result = await (_client as IFrihetClientWithDay4EInvoice).exportEInvoice({ invoiceId, format, signed });
          return {
            content: [
              getContent(
                `E-invoice export ready:\n` +
                `  Invoice: ${invoiceId}\n` +
                `  Format: ${format}\n` +
                `  Signed: ${signed ?? false}\n` +
                `  Filename: ${result.filename}\n` +
                `  Download URL: ${result.xmlUrl}`,
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — the export CF is genuinely absent. Do NOT
            // fabricate a download URL pointing at a non-existent stub file.
            return unavailableResult({
              tool: "einvoice_export",
              plannedEndpoint,
              what: "E-invoice XML export",
            });
          }
          throw err;
        }
      }),
  );

  // -- face_submit --

  server.registerTool(
    "face_submit",
    {
      title: "Submit to FACe (Spain B2G)",
      description:
        "Submit a Facturae-formatted invoice to the Spanish FACe (Punto General de Entrada de Facturas Electrónicas) B2G portal. " +
        "The invoice must have a recipient with DIR3 administrative unit codes (órgano gestor, unidad tramitadora, oficina contable). " +
        "Returns a submission reference (registro) that can be used with face_status to poll the portal. " +
        "\n\n" +
        "Modes:\n" +
        "  • mock — local simulation only, no network call (safe for dev/test)\n" +
        "  • sandbox — FACe pre-production endpoint (requires sandbox credentials)\n" +
        "  • production — live FACe SOAP endpoint (default)\n" +
        "\n" +
        "/ Envía una factura Facturae al portal FACe del Estado español. " +
        "Requiere códigos DIR3 en el destinatario (órgano gestor, unidad tramitadora, oficina contable). " +
        "Devuelve el número de registro para consulta de estado con face_status.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("Frihet invoice ID to submit / ID de la factura a enviar a FACe"),
        mode: z.enum(["mock", "sandbox", "production"]).optional().describe(
          "Submission mode: mock (local sim), sandbox (FACe pre-prod), production (live). Default: production. " +
          "/ Modo de envío: mock (simulación local), sandbox (pre-producción FACe), production (real). Por defecto: production.",
        ),
      },
      outputSchema: faceSubmitOutput,
    },
    async ({ invoiceId, mode }) =>
      withToolLogging("face_submit", async () => {
        const plannedEndpoint = `/v1/invoices/${invoiceId}/face/submit`;
        const resolvedMode = mode ?? "production";
        try {
          const result = await (_client as IFrihetClientWithDay4EInvoice).faceSubmit({ invoiceId, mode: resolvedMode });
          return {
            content: [
              mutateContent(
                `FACe submission queued:\n` +
                `  Invoice: ${invoiceId}\n` +
                `  Mode: ${resolvedMode}\n` +
                `  Registro: ${result.registroFACe}\n` +
                `  Status: ${result.status}\n\n` +
                `Use face_status with invoiceId to poll the portal for confirmation.`,
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — the FACe submit CF is genuinely absent. Do
            // NOT fabricate a registro: a fake "submitted" B2G reference would
            // make an agent report a filing that never happened.
            return unavailableResult({
              tool: "face_submit",
              plannedEndpoint,
              what: "FACe (Spain B2G) submission",
              workaround: "No registro was created — do not treat this as an accepted submission.",
            });
          }
          throw err;
        }
      }),
  );

  // -- face_status --

  server.registerTool(
    "face_status",
    {
      title: "Get FACe Submission Status",
      description:
        "Poll the status of a FACe (Spain B2G) invoice submission. " +
        "Returns the current FACe portal state code, description, and the registro number. " +
        "\n\n" +
        "Common FACe status codes:\n" +
        "  • 1200 — Registrada / Registered (submission received)\n" +
        "  • 1300 — En proceso de contabilización / In accounting (being processed)\n" +
        "  • 1400 — Contabilizada / Accounted (approved, awaiting payment)\n" +
        "  • 2400 — Anulada / Cancelled\n" +
        "  • 3100 — Rechazada / Rejected (check rejectionReason)\n" +
        "\n" +
        "/ Consulta el estado de un envío a FACe. Devuelve el código de estado, descripción y número de registro.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("Frihet invoice ID (same as used in face_submit) / ID de la factura"),
      },
      outputSchema: faceStatusOutput,
    },
    async ({ invoiceId }) =>
      withToolLogging("face_status", async () => {
        const plannedEndpoint = `/v1/invoices/${invoiceId}/face/status`;
        try {
          const result = await (_client as IFrihetClientWithDay4EInvoice).faceStatus({ invoiceId });
          return {
            content: [
              getContent(
                `FACe status:\n` +
                `  Invoice: ${invoiceId}\n` +
                `  Registro: ${result.registroFACe}\n` +
                `  Status code: ${result.statusCode}\n` +
                `  Description: ${result.statusDescription}\n` +
                (result.rejectionReason ? `  Rejection reason: ${result.rejectionReason}\n` : ""),
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — do NOT fabricate a "Registrada" (1200) state
            // for a submission that was never made.
            return unavailableResult({
              tool: "face_status",
              plannedEndpoint,
              what: "FACe submission status",
            });
          }
          throw err;
        }
      }),
  );

  // -- ticketbai_submit --

  server.registerTool(
    "ticketbai_submit",
    {
      title: "Submit TicketBAI (Basque Country)",
      description:
        "Submit an invoice to the Basque Country TicketBAI e-invoicing system. " +
        "Territory is auto-detected from the workspace address (Bizkaia → BATUZ/LROE, Gipuzkoa → Gipuzkoa TicketBAI, Araba → Araba TicketBAI). " +
        "Returns the submission TicketBAI ID (TBAI identifier) and QR code URL for printing on the invoice. " +
        "\n\n" +
        "Use sandbox=true for test submissions against the hacienda test endpoints. " +
        "Production submissions require a valid TicketBAI certificate configured in workspace settings. " +
        "\n\n" +
        "/ Envía una factura al sistema TicketBAI del País Vasco. " +
        "El territorio se detecta automáticamente (Bizkaia→BATUZ/LROE, Gipuzkoa, Álava). " +
        "Devuelve el identificador TBAI y URL del código QR para imprimir en la factura.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("Frihet invoice ID to submit / ID de la factura a enviar"),
        sandbox: z.boolean().optional().describe(
          "If true, submits to the hacienda test endpoint instead of production. Default: false. " +
          "/ Si true, envía al entorno de pruebas de la hacienda. Por defecto: false.",
        ),
      },
      outputSchema: ticketbaiSubmitOutput,
    },
    async ({ invoiceId, sandbox }) =>
      withToolLogging("ticketbai_submit", async () => {
        const plannedEndpoint = `/v1/invoices/${invoiceId}/ticketbai/submit`;
        const isSandbox = sandbox ?? false;
        try {
          const result = await (_client as IFrihetClientWithDay4EInvoice).ticketbaiSubmit({ invoiceId, sandbox: isSandbox });
          return {
            content: [
              mutateContent(
                `TicketBAI submitted:\n` +
                `  Invoice: ${invoiceId}\n` +
                `  Territory: ${result.territory}\n` +
                `  TBAI ID: ${result.tbaiId}\n` +
                `  Sandbox: ${isSandbox}\n` +
                `  QR URL: ${result.qrUrl ?? "N/A"}\n\n` +
                `Use ticketbai_status with invoiceId to poll for hacienda acknowledgement.`,
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — do NOT fabricate a TBAI identifier + QR URL.
            // A fake TicketBAI id printed on an invoice is a fiscal forgery.
            return unavailableResult({
              tool: "ticketbai_submit",
              plannedEndpoint,
              what: "TicketBAI (Basque Country) submission",
              workaround: "No TBAI identifier was issued — do not print a QR or treat this as filed.",
            });
          }
          throw err;
        }
      }),
  );

  // -- ticketbai_status --

  server.registerTool(
    "ticketbai_status",
    {
      title: "Get TicketBAI Submission Status",
      description:
        "Poll the hacienda acknowledgement status for a TicketBAI submission. " +
        "Returns the TBAI identifier, territory, and hacienda's confirmation or rejection state. " +
        "\n\n" +
        "Common status values:\n" +
        "  • submitted — sent, awaiting hacienda response (check again in 30-60s)\n" +
        "  • accepted — hacienda confirmed the submission (AEAT/foral treasury received)\n" +
        "  • rejected — hacienda rejected (check rejectionReason for correction guidance)\n" +
        "  • error — internal processing error (see error field)\n" +
        "\n" +
        "/ Consulta el estado de acuse de recibo de la hacienda foral para un envío TicketBAI. " +
        "Devuelve el identificador TBAI, territorio y estado de confirmación o rechazo.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("Frihet invoice ID (same as used in ticketbai_submit) / ID de la factura"),
      },
      outputSchema: ticketbaiStatusOutput,
    },
    async ({ invoiceId }) =>
      withToolLogging("ticketbai_status", async () => {
        const plannedEndpoint = `/v1/invoices/${invoiceId}/ticketbai/status`;
        try {
          const result = await (_client as IFrihetClientWithDay4EInvoice).ticketbaiStatus({ invoiceId });
          return {
            content: [
              getContent(
                `TicketBAI status:\n` +
                `  Invoice: ${invoiceId}\n` +
                `  TBAI ID: ${result.tbaiId}\n` +
                `  Territory: ${result.territory}\n` +
                `  Status: ${result.status}\n` +
                (result.rejectionReason ? `  Rejection reason: ${result.rejectionReason}\n` : "") +
                (result.error ? `  Error: ${result.error}\n` : ""),
              ),
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            // HONEST unavailable — do NOT fabricate an "accepted" hacienda
            // acknowledgement for a TicketBAI that was never submitted.
            return unavailableResult({
              tool: "ticketbai_status",
              plannedEndpoint,
              what: "TicketBAI submission status",
            });
          }
          throw err;
        }
      }),
  );

  // -- ksef_submit --
  // STUB ONLY — depends on the public api.frihet.io/v1/invoices/:id/ksef/submit endpoint,
  // which is not yet exposed. The KSeF transport is infra-ready in Frihet-ERP (submitKsef CF,
  // builder, encryption); production is gated on live KSeF cert issuance.
  // When the endpoint goes live, remove the NotImplementedYet throw and wire to client.kSeFSubmit().

  server.registerTool(
    "ksef_submit",
    {
      title: "Submit to KSeF (Poland)",
      description:
        "Submit an invoice to the Polish KSeF (Krajowy System e-Faktur) national e-invoicing system. " +
        "Poland requires e-invoicing for B2B transactions (mandatory phase rolling out 2025). " +
        "\n\n" +
        "Modes:\n" +
        "  • mock — local simulation (no network call, safe for dev/test)\n" +
        "  • sandbox — KSeF test environment (demo.ksef.mf.gov.pl)\n" +
        "  • production — live KSeF endpoint (ksef.mf.gov.pl)\n" +
        "\n\n" +
        "NOTE: This tool is a forward-compatible stub. The KSeF transport is infra-ready in Frihet-ERP but not yet exposed as a live public endpoint (production gated on KSeF cert issuance). " +
        "Until activated, all calls return a NotImplementedYet error with guidance. " +
        "/ NOTA: Este tool es un stub anticipatorio. El transporte KSeF está infra-ready en Frihet-ERP pero aún no expuesto como endpoint público (producción pendiente del certificado KSeF). " +
        "Hasta su activación, todas las llamadas devuelven un error NotImplementedYet con instrucciones.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("Frihet invoice ID to submit to KSeF / ID de la factura a enviar a KSeF"),
        mode: z.enum(["mock", "sandbox", "production"]).optional().describe(
          "Submission mode: mock (local sim), sandbox (KSeF test), production (live KSeF). Default: production. " +
          "/ Modo de envío: mock (simulación), sandbox (test KSeF), production (KSeF real).",
        ),
      },
      outputSchema: kSeFSubmitOutput,
    },
    async ({ invoiceId, mode }) =>
      withToolLogging("ksef_submit", async () => {
        // HONEST unavailable: the public KSeF submit endpoint is not yet exposed
        // (transport is infra-ready in Frihet-ERP; production gated on KSeF cert).
        // Returns isError:true + _unavailable so an AI agent treats this as a
        // failure, NOT as a (successful) tool result it can act on. When the endpoint
        // goes live (api.frihet.io/v1/invoices/:id/ksef/submit), replace this
        // block with: await (_client as IFrihetClientWithDay4EInvoice).kSeFSubmit({ invoiceId, mode })
        const resolvedMode = mode ?? "production";
        const result = unavailableResult({
          tool: "ksef_submit",
          plannedEndpoint: `/v1/invoices/${invoiceId}/ksef/submit`,
          what: "KSeF (Poland) submission",
          workaround:
            "It will activate once the KSeF submit endpoint is exposed (transport is infra-ready in Frihet-ERP; production gated on cert). " +
            "In the meantime, use einvoice_export with format='ubl' + manual KSeF portal " +
            "upload at ksef.mf.gov.pl.",
        });
        // Preserve the forward-compat marker + echo the request for callers/tests.
        result.structuredContent._notImplemented = true;
        result.structuredContent.invoiceId = invoiceId;
        result.structuredContent.mode = resolvedMode;
        return result;
      }),
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Returns true ONLY for a genuine 404 Not Found, indicating the CF endpoint is
 * not deployed for this jurisdiction / not yet shipped. This is the single gate
 * that authorises the stub fallback.
 *
 * COMPLIANCE INVARIANT: it MUST stay strict on 404. Any other status — 401/403
 * (auth), 422 (validation), 5xx (signature/submission failure on the live FACe or
 * TicketBAI CF), or a network/timeout error — returns false, so the caller
 * re-throws and the failure surfaces as a tool error. Widening this predicate
 * would let a real e-invoice signature/submission failure be masked as a
 * successful stub (e.g. status="submitted"/"accepted"), which is non-compliant.
 *
 * Detects both FrihetApiError shape (statusCode) and generic HTTP errors (status).
 */
function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e["statusCode"] === 404) return true;
    if (e["status"] === 404) return true;
  }
  return false;
}

/**
 * Extended client interface for e-invoice operations.
 * Tools call these methods; FrihetClient implements them.
 * Falls back to 404-stub if method is missing (older client version).
 */
interface IFrihetClientWithEInvoice extends IFrihetClient {
  sendEInvoice(params: {
    invoiceId: string;
    format: string;
    dispatchMode: string;
  }): Promise<{ workflowRunId: string; status: "queued"; estimatedCompletionSec: number }>;

  getEInvoiceStatus(workflowRunId: string): Promise<{
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    step: string;
    error?: string;
    ackId?: string;
    pdfA3Url?: string;
    xmlUrl?: string;
  }>;

  validateEInvoiceXml(params: {
    xml: string;
    format: string;
  }): Promise<{
    valid: boolean;
    errors: Array<{ severity: string; location: string; message: string; rule: string }>;
    validator: "kosit" | "mustang" | "xsd" | "schematron";
    durationMs: number;
  }>;

  exportDatev(params: {
    periodStart: string;
    periodEnd: string;
    format: string;
  }): Promise<{
    fileUrl: string;
    filename: string;
    rowCount: number;
    fiscalPeriod: string;
    encoding: "cp1252";
  }>;
}

/**
 * Extended client interface for Day 4 e-invoice tools.
 * Wraps /v1/invoices/:id/einvoice/export, /face/*, /ticketbai/*, /ksef/*.
 * Falls back to 404-stub if CF endpoints not yet deployed.
 */
interface IFrihetClientWithDay4EInvoice extends IFrihetClient {
  exportEInvoice(params: {
    invoiceId: string;
    format: string;
    signed?: boolean;
  }): Promise<{
    xmlUrl: string;
    filename: string;
    format: string;
    signed: boolean;
  }>;

  faceSubmit(params: {
    invoiceId: string;
    mode: "mock" | "sandbox" | "production";
  }): Promise<{
    registroFACe: string;
    status: "submitted" | "error";
    submittedAt: string;
    mode: string;
  }>;

  faceStatus(params: {
    invoiceId: string;
  }): Promise<{
    registroFACe: string;
    statusCode: string;
    statusDescription: string;
    rejectionReason?: string;
  }>;

  ticketbaiSubmit(params: {
    invoiceId: string;
    sandbox: boolean;
  }): Promise<{
    tbaiId: string;
    territory: "bizkaia" | "gipuzkoa" | "araba";
    status: "submitted" | "accepted" | "rejected" | "error";
    sandbox: boolean;
    qrUrl?: string;
  }>;

  ticketbaiStatus(params: {
    invoiceId: string;
  }): Promise<{
    tbaiId: string;
    territory: "bizkaia" | "gipuzkoa" | "araba";
    status: "submitted" | "accepted" | "rejected" | "error";
    rejectionReason?: string;
    error?: string;
  }>;

  // kSeFSubmit intentionally omitted — always-stub (public KSeF endpoint not yet exposed).
}

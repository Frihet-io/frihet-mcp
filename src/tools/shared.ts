/**
 * Shared utilities for MCP tool handlers.
 *
 * This module is used by both the local (stdio) and remote (Cloudflare Workers)
 * MCP servers. It must NOT import concrete classes from either client — error
 * detection uses duck-typing (checking for `statusCode`/`errorCode` properties)
 * so it works regardless of which FrihetApiError class threw the error.
 */

import type { ToolAnnotations, Annotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import type { PaginatedResponse } from "../types.js";
import { log, logToolCall } from "../logger.js";
import { recordToolCall } from "../metrics.js";

/* ------------------------------------------------------------------ */
/*  Safety annotations for MCP tool registrations                      */
/* ------------------------------------------------------------------ */

export const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const CREATE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
export const UPDATE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const DELETE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

/* ------------------------------------------------------------------ */
/*  Content annotations for tool responses                             */
/* ------------------------------------------------------------------ */

/** List operations: useful to both user and assistant for navigation, medium priority. */
export const LIST_CONTENT_ANNOTATIONS: Annotations = {
  audience: ["user", "assistant"],
  priority: 0.5,
} as const;

/** Get/read operations: useful to both, higher priority as specifically requested data. */
export const GET_CONTENT_ANNOTATIONS: Annotations = {
  audience: ["user", "assistant"],
  priority: 0.7,
} as const;

/** Mutating operations (create/update/delete): primarily for the user, highest priority. */
export const MUTATE_CONTENT_ANNOTATIONS: Annotations = {
  audience: ["user"],
  priority: 1.0,
} as const;

/** Error responses: always high priority, always for the user. */
export const ERROR_CONTENT_ANNOTATIONS: Annotations = {
  audience: ["user"],
  priority: 1.0,
} as const;

/* ------------------------------------------------------------------ */
/*  Content block type                                                 */
/* ------------------------------------------------------------------ */

export interface AnnotatedTextContent {
  type: "text";
  text: string;
  annotations?: Annotations;
}

/* ------------------------------------------------------------------ */
/*  Response size guard                                                */
/* ------------------------------------------------------------------ */

const MAX_RESPONSE_CHARS = 80_000; // ~20,000 tokens safety margin

export function truncateResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return text.slice(0, MAX_RESPONSE_CHARS) +
    '\n\n[Response truncated. Use pagination (limit/offset) to retrieve smaller result sets.]';
}

/** Shape of errors thrown by any FrihetClient implementation. */
interface FrihetApiErrorLike {
  statusCode: number;
  errorCode: string;
  message: string;
}

function isFrihetApiError(error: unknown): error is FrihetApiErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "errorCode" in error &&
    typeof (error as FrihetApiErrorLike).statusCode === "number"
  );
}

/**
 * Maps an error to a user-friendly MCP tool response with error annotations.
 * Emits structured log entries for all errors.
 */
export function handleToolError(error: unknown, toolName?: string): {
  content: AnnotatedTextContent[];
  isError: true;
} {
  if (isFrihetApiError(error)) {
    log({
      level: "error",
      message: `API error: ${error.statusCode} ${error.errorCode}: ${error.message}`,
      tool: toolName,
      operation: "tool_error",
      error: {
        message: error.message,
        code: error.errorCode,
        statusCode: error.statusCode,
      },
    });

    const messages: Record<number, string> = {
      400: "Bad request. Check your input parameters. / Solicitud incorrecta. Revisa los parametros.",
      401: "Authentication failed. Check your API key. / Autenticacion fallida. Revisa tu API key.",
      403: "Access denied. Your API key does not have permission for this action. / Acceso denegado.",
      404: "Resource not found. / Recurso no encontrado.",
      405: "Method not allowed. / Metodo no permitido.",
      413: "Request body too large (max 1MB). / Cuerpo de la solicitud demasiado grande (max 1MB).",
      429: "Rate limit exceeded. Try again later. / Limite de peticiones excedido. Intenta mas tarde.",
      500: "Internal server error. Try again later. / Error interno del servidor.",
    };

    const friendlyMessage =
      messages[error.statusCode] ?? `API error ${error.statusCode}. Contact support if this persists.`;

    return {
      content: [
        {
          type: "text",
          text: `Error: ${friendlyMessage}`,
          annotations: ERROR_CONTENT_ANNOTATIONS,
        },
      ],
      isError: true,
    };
  }

  const errMsg = error instanceof Error ? error.stack ?? error.message : String(error);
  log({
    level: "error",
    message: `Unexpected error: ${errMsg}`,
    tool: toolName,
    operation: "tool_error",
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof Error ? error.name : "unknown",
    },
  });

  return {
    content: [{ type: "text", text: "Error: An unexpected error occurred. Contact support if this persists.", annotations: ERROR_CONTENT_ANNOTATIONS }],
    isError: true,
  };
}

/**
 * Formats a paginated API response into readable text.
 */
export function formatPaginatedResponse(
  resourceName: string,
  response: PaginatedResponse<Record<string, unknown>>,
): string {
  const lines: string[] = [
    `Found ${response.total} ${resourceName} (showing ${response.data.length}, offset ${response.offset}):`,
    "",
  ];

  for (const item of response.data) {
    lines.push(JSON.stringify(item, null, 2));
    lines.push("---");
  }

  if (response.total > response.offset + response.data.length) {
    const nextOffset = response.offset + response.data.length;
    lines.push(
      `More results available. Use offset=${nextOffset} to see the next page.`,
    );
    if (response.nextCursor) {
      lines.push(
        `Cursor pagination: use after='${response.nextCursor}' for efficient cursor-based pagination.`,
      );
    }
  }

  return truncateResponse(lines.join("\n"));
}

/**
 * Formats a single record for display.
 */
export function formatRecord(
  label: string,
  record: Record<string, unknown>,
): string {
  return truncateResponse(`${label}:\n${JSON.stringify(record, null, 2)}`);
}

/**
 * Builds an annotated content block for list/search responses.
 */
export function listContent(text: string): AnnotatedTextContent {
  return { type: "text", text, annotations: LIST_CONTENT_ANNOTATIONS };
}

/**
 * Builds an annotated content block for get/read responses.
 */
export function getContent(text: string): AnnotatedTextContent {
  return { type: "text", text, annotations: GET_CONTENT_ANNOTATIONS };
}

/**
 * Builds an annotated content block for create/update/delete responses.
 */
export function mutateContent(text: string): AnnotatedTextContent {
  return { type: "text", text, annotations: MUTATE_CONTENT_ANNOTATIONS };
}

/* ------------------------------------------------------------------ */
/*  Contextual enrichment — _suggestions and _warnings                 */
/* ------------------------------------------------------------------ */

/**
 * Adds contextual suggestions and warnings to tool responses.
 * Helps AI agents know what to do next without guessing.
 */
export function enrichResponse(
  resource: string,
  operation: string,
  data: unknown,
): { _suggestions?: string[]; _warnings?: string[] } {
  const suggestions: string[] = [];
  const warnings: string[] = [];

  // After creating an invoice
  if (operation === "create" && resource === "invoices") {
    suggestions.push("update_invoice — Update this invoice (e.g. change status to 'sent')");
    suggestions.push("get_invoice — View the full invoice with calculated totals");
    const rec = data as Record<string, unknown> | undefined;
    if (rec?.status === "draft") {
      suggestions.push('update_invoice — Change status to "sent" when ready');
    }
  }

  // After listing invoices
  if (operation === "list" && resource === "invoices") {
    const items = (data as Record<string, unknown>[] | undefined);
    if (Array.isArray(items)) {
      const overdue = items.filter((i) => i.status === "overdue");
      if (overdue.length > 0) {
        warnings.push(`${overdue.length} overdue invoice(s) need attention`);
        suggestions.push("Use the overdue-followup prompt to draft payment reminders");
      }
      const drafts = items.filter((i) => i.status === "draft");
      if (drafts.length > 0) {
        suggestions.push(`${drafts.length} draft invoice(s) — review and send when ready`);
      }
    }
  }

  // After creating an expense
  if (operation === "create" && resource === "expenses") {
    suggestions.push("get_monthly_summary — Check how this affects your monthly P&L");
    suggestions.push("list_expenses — View all expenses for the period");
  }

  // After listing expenses
  if (operation === "list" && resource === "expenses") {
    const items = (data as Record<string, unknown>[] | undefined);
    if (Array.isArray(items)) {
      const uncategorized = items.filter((i) => !i.category);
      if (uncategorized.length > 0) {
        warnings.push(`${uncategorized.length} expense(s) without a category — categorize for tax deductions`);
        suggestions.push("Use the expense-batch prompt to categorize expenses in bulk");
      }
    }
  }

  // After creating a client
  if (operation === "create" && resource === "clients") {
    suggestions.push("create_invoice — Create the first invoice for this client");
    suggestions.push("create_quote — Send a quote to this new client");
  }

  // After creating a vendor
  if (operation === "create" && resource === "vendors") {
    suggestions.push("create_expense — Record an expense from this vendor");
    suggestions.push("list_vendors — View all vendors");
  }

  // After creating a quote
  if (operation === "create" && resource === "quotes") {
    suggestions.push("get_quote — View the quote with calculated totals");
    suggestions.push("create_invoice — Convert this quote to an invoice when accepted");
  }

  // After updating an invoice to paid
  if (operation === "update" && resource === "invoices") {
    const rec = data as Record<string, unknown> | undefined;
    if (rec?.status === "paid") {
      suggestions.push("get_monthly_summary — Review updated monthly revenue");
    }
  }

  // After duplicating an invoice
  if (operation === "duplicate" && resource === "invoices") {
    suggestions.push("update_invoice — Adjust line items or dates on the new invoice");
    suggestions.push("get_invoice — Review the duplicated invoice before sending");
  }

  // After deleting anything
  if (operation === "delete") {
    warnings.push("This action cannot be undone / Esta accion no se puede deshacer");
  }

  return {
    ...(suggestions.length > 0 ? { _suggestions: suggestions } : {}),
    ...(warnings.length > 0 ? { _warnings: warnings } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Output schemas (MCP spec 2025-11-25: outputSchema + structuredContent) */
/* ------------------------------------------------------------------ */

/**
 * Wraps an item schema in a paginated envelope for list/search tools.
 */
export function paginatedOutput<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    nextCursor: z.string().optional(),
  });
}

/** Schema for delete operation results. */
export const deleteResultOutput = z.object({
  success: z.boolean(),
  id: z.string(),
});

/* --- Per-resource item schemas ------------------------------------ */

const lineItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
});

export const invoiceItemOutput = z.object({
  id: z.string(),
  clientName: z.string(),
  items: z.array(lineItemSchema),
  issueDate: z.string().optional(),
  dueDate: z.string().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
  taxRate: z.number().optional(),
  total: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const expenseItemOutput = z.object({
  id: z.string(),
  description: z.string(),
  amount: z.number(),
  category: z.string().optional(),
  date: z.string().optional(),
  vendor: z.string().optional(),
  taxDeductible: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

const addressOutputSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
}).optional();

export const clientItemOutput = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  taxId: z.string().optional(),
  address: addressOutputSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const productItemOutput = z.object({
  id: z.string(),
  name: z.string(),
  unitPrice: z.number(),
  description: z.string().optional(),
  taxRate: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const quoteItemOutput = z.object({
  id: z.string(),
  clientName: z.string(),
  items: z.array(lineItemSchema),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
  total: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const vendorItemOutput = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  taxId: z.string().optional(),
  address: addressOutputSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const webhookItemOutput = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean().optional(),
  secret: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

/* --- CRM subcollection item schemas -------------------------------- */

export const contactItemOutput = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
  isPrimary: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const activityItemOutput = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  description: z.string().optional(),
  date: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const noteItemOutput = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const depositItemOutput = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string().optional(),
  amount: z.number(),
  currency: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  paymentMethod: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

/* --- Stay item schemas ----------------------------------------------------- */

export const reservationItemOutput = z.object({
  id: z.string(),
  propertyId: z.string(),
  guestId: z.string().optional(),
  status: z.enum(["confirmed", "pending", "cancelled", "completed", "no_show"]),
  checkIn: z.string(),
  checkOut: z.string(),
  nights: z.number().int().min(1).optional(),
  guestCount: z.number().int().min(1),
  channelId: z.string().optional(),
  totalAmount: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const propertyItemOutput = z.object({
  id: z.string(),
  name: z.string(),
  address: z.object({
    street: z.string().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
  }).optional(),
  capacity: z.number().int().min(1).optional(),
  ownerName: z.string().optional(),
  licenseNumber: z.string().optional(),
  isActive: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

/* --- POS item schemas ------------------------------------------------------ */

export const posTerminalItemOutput = z.object({
  id: z.string(),
  label: z.string().optional(),
  deviceType: z.string().optional(),
  locationId: z.string().optional(),
  status: z.enum(["online", "offline", "unknown"]).optional(),
  stripeReaderId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const posSaleItemOutput = z.object({
  id: z.string(),
  terminalId: z.string().optional(),
  status: z.enum(["succeeded", "pending", "cancelled", "refunded", "partially_refunded"]).optional(),
  amountCents: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  paymentMethod: z.string().optional(),
  items: z.array(z.object({
    description: z.string(),
    quantity: z.number(),
    unitPriceCents: z.number().int(),
  })).optional(),
  refundedAmountCents: z.number().int().nonnegative().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

/** Schema for action results (send, mark paid, etc.) */
export const actionResultOutput = z.object({
  success: z.boolean(),
  id: z.string(),
  message: z.string().optional(),
}).passthrough();

/* --- Banking item schemas -------------------------------------------------- */

export const bankAccountItemOutput = z.object({
  id: z.string(),
  alias: z.string().optional(),
  ibanLast4: z.string().optional().describe("Last 4 digits of IBAN (security masked)"),
  currency: z.string().optional(),
  balance: z.number().optional(),
  lastSyncedAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

export const bankTransactionItemOutput = z.object({
  id: z.string(),
  accountId: z.string().optional(),
  amount: z.number(),
  currency: z.string().optional(),
  description: z.string().optional(),
  postedAt: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(["pending", "posted", "excluded"]).optional(),
  matchedDocId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

/* --- Fiscal item schemas --------------------------------------------------- */

export const fiscalModeloSummaryOutput = z.object({
  modeloCode: z.string(),
  period: z.string().optional(),
  totalsByRate: z.record(z.string(), z.number()).optional(),
  totalDeductible: z.number().optional(),
  totalDue: z.number().optional(),
  deadline: z.string().optional(),
}).passthrough();

export const verifactuStatusOutput = z.object({
  invoiceId: z.string(),
  lastSubmissionAt: z.string().optional(),
  hash: z.string().optional(),
  status: z.enum(["success", "pending", "failed"]).optional(),
  aeatResponse: z.string().optional(),
  qrUrl: z.string().optional(),
}).passthrough();

export const ticketbaiStatusOutput = z.object({
  invoiceId: z.string(),
  lastSubmissionAt: z.string().optional(),
  hash: z.string().optional(),
  status: z.enum(["success", "pending", "failed"]).optional(),
  aeatResponse: z.string().optional(),
  qrUrl: z.string().optional(),
  province: z.enum(["araba", "bizkaia", "gipuzkoa"]).optional(),
}).passthrough();

/* --- Time entry item schemas ----------------------------------------------- */

export const timeEntryItemOutput = z.object({
  id: z.string(),
  userId: z.string().optional(),
  projectId: z.string().optional(),
  hours: z.number(),
  description: z.string().optional(),
  billable: z.boolean().optional(),
  date: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

/* --- Recurring invoice item schemas ---------------------------------------- */

export const recurringInvoiceItemOutput = z.object({
  id: z.string(),
  templateName: z.string().optional(),
  frequency: z.string().optional(),
  nextRun: z.string().optional(),
  recipient: z.string().optional(),
  lineItems: z.array(z.object({
    description: z.string(),
    quantity: z.number(),
    unitPrice: z.number(),
  })).optional(),
  status: z.enum(["active", "paused"]).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

/** Schema for PDF results */
export const pdfResultOutput = z.object({
  id: z.string(),
  url: z.string().optional(),
  contentType: z.string().optional(),
}).passthrough();

/* ------------------------------------------------------------------ */
/*  Tool execution wrapper with logging + metrics                      */
/* ------------------------------------------------------------------ */

/** Return type of a tool handler — index signature required by MCP SDK */
interface ToolResult {
  [x: string]: unknown;
  content: AnnotatedTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Wraps a tool handler to automatically log execution time, success/failure,
 * and record metrics. Catches errors and routes them through handleToolError.
 *
 * Usage in tool registration files:
 * ```ts
 * async ({ id }) => withToolLogging("get_invoice", async () => {
 *   const result = await client.getInvoice(id);
 *   return { content: [getContent(formatRecord("Invoice", result))], structuredContent: result };
 * })
 * ```
 */
export async function withToolLogging(
  toolName: string,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const startTime = Date.now();
  try {
    const result = await fn();
    const durationMs = Math.round(Date.now() - startTime);
    logToolCall(toolName, startTime, true);
    recordToolCall(toolName, durationMs, true);
    return result;
  } catch (error) {
    const durationMs = Math.round(Date.now() - startTime);
    logToolCall(toolName, startTime, false, error instanceof Error ? error as Error & { statusCode?: number; errorCode?: string } : new Error(String(error)));
    recordToolCall(toolName, durationMs, false);
    return handleToolError(error, toolName);
  }
}

import { z } from "zod/v4";

/** Locally generated guidance only: never includes input values or provider text. */
export class DepositInputError extends Error {
  readonly statusCode = 400;
  readonly errorCode = "invalid_deposit_input";
  constructor(message: string) {
    super(message);
    this.name = "DepositInputError";
  }
}

/** Writable fields accepted by publicApi v132's strict deposits schema. */
export const depositFields = {
  clientId: z.string().min(1).max(128),
  clientName: z.string().min(1).max(500),
  amount: z.number().positive(),
  currency: z.string().length(3),
  description: z.string().min(1).max(2000),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.string().max(200).optional(),
  paymentReference: z.string().max(200).optional(),
};

/** Writable fields accepted by publicApi v132's strict /deposits/:id/apply schema. */
export const applyDepositFields = {
  invoiceId: z.string().min(1).max(128),
  invoiceNumber: z.string().min(1).max(200),
  amount: z.number().positive(),
};

const applyDepositBody = z.object(applyDepositFields).strict();

/** Validate deposit application payload against the strict backend contract before request I/O. */
export function normalizeApplyDepositBody(
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(input, "notes")) {
    throw new DepositInputError("Deposit application field 'notes' is not writable; the API does not accept it. / El campo 'notes' no se puede guardar al aplicar el depósito.");
  }
  const parsed = applyDepositBody.safeParse(input);
  if (!parsed.success) {
    const known = new Set(Object.keys(applyDepositFields));
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter(
      (field): field is string => typeof field === "string" && known.has(field),
    ))];
    throw new DepositInputError(
      `Invalid deposit application input${fields.length ? ` (${fields.join(", ")})` : ""}. Provide invoiceId, invoiceNumber and a positive amount. / Indica invoiceId, invoiceNumber y un importe positivo.`,
    );
  }
  return parsed.data;
}

const createDepositBody = z.object({
  ...depositFields,
  currency: depositFields.currency.default("EUR"),
}).strict();

// PATCH must not inject the create default or turn an empty update into a write.
const updateDepositBody = z.object(depositFields).partial().strict().refine(
  (fields) => Object.values(fields).some((value) => value !== undefined),
  { message: "Provide at least one writable deposit field / Indica al menos un campo del depósito" },
);

/** Preserve the established MCP date/reference names on the canonical API wire. */
export function normalizeDepositBody(
  input: Record<string, unknown>,
  partial: boolean,
): Record<string, unknown> {
  const body = { ...input };
  for (const unsupported of ["status", "notes"] as const) {
    if (Object.prototype.hasOwnProperty.call(body, unsupported)) {
      throw new DepositInputError(`Deposit field '${unsupported}' is not writable; the API does not accept it. / El campo '${unsupported}' no se puede guardar en el depósito.`);
    }
  }
  for (const [alias, canonical] of [["date", "receivedDate"], ["reference", "paymentReference"]] as const) {
    if (body[alias] !== undefined) {
      if (body[canonical] !== undefined && body[canonical] !== body[alias]) {
        throw new DepositInputError(`Conflicting deposit fields '${alias}' and '${canonical}'. / Los campos '${alias}' y '${canonical}' no coinciden.`);
      }
      body[canonical] = body[alias];
    }
    delete body[alias];
  }
  const parsed = (partial ? updateDepositBody : createDepositBody).safeParse(body);
  if (!parsed.success) {
    const known = new Set(Object.keys(depositFields));
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter(
      (field): field is string => typeof field === "string" && known.has(field),
    ))];
    const guidance = partial
      ? "Provide at least one valid writable deposit field; date uses YYYY-MM-DD. / Indica al menos un campo editable válido; date usa YYYY-MM-DD."
      : "Provide clientId, clientName, a positive amount, description and receivedDate (date) in YYYY-MM-DD format. / Indica clientId, clientName, un importe positivo, description y receivedDate (date) con formato YYYY-MM-DD.";
    throw new DepositInputError(`Invalid deposit input${fields.length ? ` (${fields.join(", ")})` : ""}. ${guidance}`);
  }
  return parsed.data;
}

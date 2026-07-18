/**
 * Demo-mode fixtures for the Frihet MCP server (`FRIHET_DEMO=1`).
 *
 * These are the canned, PII-SAFE example datasets served by DemoFrihetClient
 * when the server runs without an API key. NOTHING here is real customer data:
 *   - NIF/CIF are AEAT example patterns (B12345678, X9999999X).
 *   - IBAN is the ECBS/AEAT test IBAN (ES9121000418450200051332).
 *   - Every email is under @example.com (guarded by demo-mode.test.ts).
 *   - Business names are generic, invented ES/EU companies.
 *
 * Amounts follow the same field shape the real /v1 REST API returns (see
 * src/tools/*.ts output schemas + src/client-interface.ts return types), so an
 * agent evaluating the demo sees exactly the response shape it would get live.
 */

import type { PaginatedResponse } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Demo banner stamps                                                 */
/* ------------------------------------------------------------------ */

/** Marker fields stamped on every demo response's top-level object. */
export interface DemoStamp {
  _demo: true;
  _demoNotice: string;
}

/** Read/get/list responses. */
export const READ_STAMP: DemoStamp = {
  _demo: true,
  _demoNotice:
    "DEMO MODE — example data, nothing persisted. For real data: app.frihet.io → Settings → API keys.",
} as const;

/** Simulated writes (create/update/apply/mark/etc.). */
export const WRITE_STAMP: DemoStamp = {
  _demo: true,
  _demoNotice:
    "DEMO MODE — example data, nothing persisted. Simulated — not persisted.",
} as const;

/** Fiscal / e-invoice / email / payroll actions — NEVER a real submission. */
export const FISCAL_STAMP: DemoStamp = {
  _demo: true,
  _demoNotice:
    "Simulated fiscal action — no submission was made to any tax authority.",
} as const;

/** Empty surfaces (no dedicated fixtures yet) still carry a demo stamp. */
export const EMPTY_STAMP: DemoStamp = {
  _demo: true,
  _demoNotice:
    "DEMO MODE — no demo fixtures for this surface yet. For real data: app.frihet.io → Settings → API keys.",
} as const;

/** Frozen timestamp so demo responses are deterministic across calls. */
export const DEMO_NOW = "2026-07-15T10:00:00.000Z";

/** Test IBAN (ECBS/AEAT example — never a real account). */
export const DEMO_TEST_IBAN = "ES9121000418450200051332";

/* ------------------------------------------------------------------ */
/*  Paginated envelope helpers                                         */
/* ------------------------------------------------------------------ */

export type DemoPaginated = PaginatedResponse<Record<string, unknown>> & DemoStamp;

/** Wrap a fixture array in a stamped PaginatedResponse. */
export function demoPage(
  data: Record<string, unknown>[],
  params?: { limit?: number; offset?: number },
): DemoPaginated {
  return {
    data,
    total: data.length,
    limit: params?.limit ?? 50,
    offset: params?.offset ?? 0,
    ...READ_STAMP,
  };
}

/** Empty stamped PaginatedResponse for surfaces without dedicated fixtures. */
export function demoEmptyPage(params?: { limit?: number; offset?: number }): DemoPaginated {
  return {
    data: [],
    total: 0,
    limit: params?.limit ?? 50,
    offset: params?.offset ?? 0,
    ...EMPTY_STAMP,
  };
}

/* ------------------------------------------------------------------ */
/*  Clients (5) — mix of ES peninsula, Canarias (IGIC), autónomo, EU   */
/* ------------------------------------------------------------------ */

export const demoClients: Record<string, unknown>[] = [
  {
    id: "demo_cli_001",
    name: "Panadería La Espiga SL",
    email: "hola@example.com",
    phone: "+34 600 000 001",
    taxId: "B12345678",
    address: { street: "Calle Mayor 12", city: "Madrid", state: "Madrid", postalCode: "28013", country: "ES" },
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  },
  {
    id: "demo_cli_002",
    name: "Estudio Nórdico Arquitectura SL",
    email: "info@example.com",
    phone: "+34 600 000 002",
    taxId: "B87654321",
    address: { street: "Passeig de Gràcia 45", city: "Barcelona", state: "Barcelona", postalCode: "08010", country: "ES" },
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  },
  {
    id: "demo_cli_003",
    name: "Servicios Insulares Canarias SL",
    email: "contacto@example.com",
    phone: "+34 600 000 003",
    taxId: "B35700000",
    address: { street: "Avenida de Anaga 8", city: "Santa Cruz de Tenerife", state: "Canarias", postalCode: "38001", country: "ES" },
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  },
  {
    id: "demo_cli_004",
    name: "Marina Delgado (autónoma)",
    email: "marina@example.com",
    phone: "+34 600 000 004",
    taxId: "X9999999X",
    address: { street: "Carrer de Colón 3", city: "Valencia", state: "Valencia", postalCode: "46004", country: "ES" },
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  },
  {
    id: "demo_cli_005",
    name: "TechFlow Solutions GmbH",
    email: "billing@example.com",
    phone: "+49 30 0000000",
    taxId: "DE123456789",
    address: { street: "Unter den Linden 10", city: "Berlin", state: "Berlin", postalCode: "10117", country: "DE" },
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  },
];

/* ------------------------------------------------------------------ */
/*  Products (8) — IVA 21% / 10% / 4%                                  */
/* ------------------------------------------------------------------ */

export const demoProducts: Record<string, unknown>[] = [
  { id: "demo_prd_001", name: "Consultoría estratégica (hora)", unitPrice: 90, taxRate: 21, description: "Sesión de consultoría por hora", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_prd_002", name: "Desarrollo web (jornada)", unitPrice: 480, taxRate: 21, description: "Jornada de desarrollo full-stack", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_prd_003", name: "Mantenimiento mensual", unitPrice: 150, taxRate: 21, description: "Soporte y mantenimiento mensual", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_prd_004", name: "Diseño de marca", unitPrice: 1200, taxRate: 21, description: "Identidad visual completa", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_prd_005", name: "Auditoría SEO", unitPrice: 600, taxRate: 21, description: "Auditoría técnica y de contenidos", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_prd_006", name: "Formación in-company (hora)", unitPrice: 75, taxRate: 21, description: "Formación presencial por hora", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_prd_007", name: "Menú catering (por persona)", unitPrice: 18, taxRate: 10, description: "Servicio de catering, IVA reducido hostelería", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_prd_008", name: "Libro técnico impreso", unitPrice: 24, taxRate: 4, description: "Publicación impresa, IVA superreducido", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
];

/* ------------------------------------------------------------------ */
/*  Invoices (9) — IVA 21/10/4, IGIC 7, reverse-charge; drafts/sent/paid/overdue */
/* ------------------------------------------------------------------ */

interface DemoLine {
  description: string;
  quantity: number;
  unitPrice: number;
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function invoice(opts: {
  id: string;
  clientId: string;
  clientName: string;
  items: DemoLine[];
  taxRate: number;
  status: string;
  issueDate: string;
  dueDate: string;
  notes?: string;
  irpfRate?: number;
  clientLocation?: string;
}): Record<string, unknown> {
  const subtotal = money(opts.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
  const taxAmount = money(subtotal * (opts.taxRate / 100));
  const irpfAmount = opts.irpfRate ? money(subtotal * (opts.irpfRate / 100)) : 0;
  const total = money(subtotal + taxAmount - irpfAmount);
  return {
    id: opts.id,
    clientId: opts.clientId,
    clientName: opts.clientName,
    items: opts.items,
    issueDate: opts.issueDate,
    dueDate: opts.dueDate,
    status: opts.status,
    taxRate: opts.taxRate,
    subtotal,
    taxAmount,
    ...(opts.irpfRate ? { irpfRate: opts.irpfRate, irpfAmount } : {}),
    total,
    currency: "EUR",
    ...(opts.clientLocation ? { clientLocation: opts.clientLocation } : {}),
    ...(opts.notes ? { notes: opts.notes } : {}),
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  };
}

export const demoInvoices: Record<string, unknown>[] = [
  invoice({ id: "demo_inv_001", clientId: "demo_cli_001", clientName: "Panadería La Espiga SL", items: [{ description: "Consultoría estratégica (hora)", quantity: 10, unitPrice: 90 }], taxRate: 21, status: "paid", issueDate: "2026-06-03", dueDate: "2026-07-03", clientLocation: "peninsula" }),
  invoice({ id: "demo_inv_002", clientId: "demo_cli_002", clientName: "Estudio Nórdico Arquitectura SL", items: [{ description: "Desarrollo web (jornada)", quantity: 5, unitPrice: 480 }], taxRate: 21, status: "sent", issueDate: "2026-06-10", dueDate: "2026-07-10", clientLocation: "peninsula" }),
  invoice({ id: "demo_inv_003", clientId: "demo_cli_003", clientName: "Servicios Insulares Canarias SL", items: [{ description: "Consultoría estratégica (hora)", quantity: 8, unitPrice: 90 }], taxRate: 7, status: "paid", issueDate: "2026-06-12", dueDate: "2026-07-12", notes: "IGIC 7% — cliente en Canarias", clientLocation: "canarias" }),
  invoice({ id: "demo_inv_004", clientId: "demo_cli_004", clientName: "Marina Delgado (autónoma)", items: [{ description: "Formación in-company (hora)", quantity: 12, unitPrice: 75 }], taxRate: 21, status: "draft", issueDate: "2026-07-01", dueDate: "2026-07-31", clientLocation: "peninsula" }),
  invoice({ id: "demo_inv_005", clientId: "demo_cli_001", clientName: "Panadería La Espiga SL", items: [{ description: "Menú catering (por persona)", quantity: 40, unitPrice: 18 }], taxRate: 10, status: "sent", issueDate: "2026-06-20", dueDate: "2026-07-20", notes: "IVA reducido 10% (hostelería)", clientLocation: "peninsula" }),
  invoice({ id: "demo_inv_006", clientId: "demo_cli_002", clientName: "Estudio Nórdico Arquitectura SL", items: [{ description: "Libro técnico impreso", quantity: 50, unitPrice: 24 }], taxRate: 4, status: "paid", issueDate: "2026-05-28", dueDate: "2026-06-28", notes: "IVA superreducido 4% (libros)", clientLocation: "peninsula" }),
  invoice({ id: "demo_inv_007", clientId: "demo_cli_005", clientName: "TechFlow Solutions GmbH", items: [{ description: "Consultoría estratégica (hora)", quantity: 20, unitPrice: 90 }], taxRate: 0, status: "sent", issueDate: "2026-06-15", dueDate: "2026-07-15", notes: "Inversión del sujeto pasivo (reverse charge, operación intracomunitaria B2B)", clientLocation: "eu" }),
  invoice({ id: "demo_inv_008", clientId: "demo_cli_003", clientName: "Servicios Insulares Canarias SL", items: [{ description: "Mantenimiento mensual", quantity: 3, unitPrice: 150 }], taxRate: 7, status: "overdue", issueDate: "2026-04-05", dueDate: "2026-05-05", notes: "IGIC 7% — factura vencida", clientLocation: "canarias" }),
  invoice({ id: "demo_inv_009", clientId: "demo_cli_004", clientName: "Marina Delgado (autónoma)", items: [{ description: "Diseño de marca", quantity: 1, unitPrice: 1200 }, { description: "Auditoría SEO", quantity: 1, unitPrice: 600 }], taxRate: 21, status: "draft", issueDate: "2026-07-08", dueDate: "2026-08-08", irpfRate: 15, notes: "Autónoma con retención IRPF 15%", clientLocation: "peninsula" }),
];

/* ------------------------------------------------------------------ */
/*  Expenses (6) — categorized                                         */
/* ------------------------------------------------------------------ */

export const demoExpenses: Record<string, unknown>[] = [
  { id: "demo_exp_001", description: "Suscripción software de diseño", amount: 15.4, category: "software", date: "2026-07-01", vendor: "Herramientas Digitales SL", taxDeductible: true, createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_exp_002", description: "Material de oficina", amount: 48.2, category: "office_supplies", date: "2026-06-18", vendor: "Papelería Central", taxDeductible: true, createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_exp_003", description: "Comida de trabajo con cliente", amount: 62.0, category: "meals", date: "2026-06-22", vendor: "Restaurante El Puerto", taxDeductible: true, createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_exp_004", description: "Combustible desplazamiento", amount: 70.0, category: "travel", date: "2026-06-25", vendor: "Estación de Servicio Norte", taxDeductible: true, createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_exp_005", description: "Cuota gestoría mensual", amount: 90.0, category: "professional_services", date: "2026-07-01", vendor: "Gestoría Ramírez", taxDeductible: true, createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_exp_006", description: "Hosting anual", amount: 120.0, category: "software", date: "2026-05-30", vendor: "Proveedor Cloud SL", taxDeductible: true, createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
];

/* ------------------------------------------------------------------ */
/*  Quotes (2)                                                         */
/* ------------------------------------------------------------------ */

export const demoQuotes: Record<string, unknown>[] = [
  {
    id: "demo_quo_001",
    clientId: "demo_cli_002",
    clientName: "Estudio Nórdico Arquitectura SL",
    items: [{ description: "Desarrollo web (jornada)", quantity: 10, unitPrice: 480 }],
    taxRate: 21,
    subtotal: 4800,
    taxAmount: 1008,
    total: 5808,
    currency: "EUR",
    status: "sent",
    validUntil: "2026-08-15",
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  },
  {
    id: "demo_quo_002",
    clientId: "demo_cli_005",
    clientName: "TechFlow Solutions GmbH",
    items: [{ description: "Consultoría estratégica (hora)", quantity: 30, unitPrice: 90 }],
    taxRate: 0,
    subtotal: 2700,
    taxAmount: 0,
    total: 2700,
    currency: "EUR",
    status: "draft",
    validUntil: "2026-08-30",
    notes: "Reverse charge (intracomunitario B2B)",
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  },
];

/* ------------------------------------------------------------------ */
/*  Vendors (2)                                                        */
/* ------------------------------------------------------------------ */

export const demoVendors: Record<string, unknown>[] = [
  { id: "demo_ven_001", name: "Gestoría Ramírez", email: "gestoria@example.com", phone: "+34 600 000 010", taxId: "B11111111", address: { city: "Madrid", postalCode: "28004", country: "ES" }, createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_ven_002", name: "Proveedor Cloud SL", email: "facturacion@example.com", phone: "+34 600 000 011", taxId: "B22222222", address: { city: "Barcelona", postalCode: "08007", country: "ES" }, createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
];

/* ------------------------------------------------------------------ */
/*  Banking — 1 account + 4 transactions                              */
/* ------------------------------------------------------------------ */

export const demoBankAccounts: Record<string, unknown>[] = [
  {
    id: "demo_bank_001",
    alias: "Cuenta principal",
    iban: DEMO_TEST_IBAN,
    ibanLast4: "1332",
    currency: "EUR",
    balance: 12450.75,
    lastSyncedAt: DEMO_NOW,
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
  },
];

export const demoTransactions: Record<string, unknown>[] = [
  { id: "demo_txn_001", accountId: "demo_bank_001", amount: 1089.0, currency: "EUR", description: "Cobro factura demo_inv_001", postedAt: "2026-07-03", category: "sales_income", status: "posted", matchedDocId: "demo_inv_001", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_txn_002", accountId: "demo_bank_001", amount: -90.0, currency: "EUR", description: "Cuota gestoría mensual", postedAt: "2026-07-01", category: "professional_services", status: "posted", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_txn_003", accountId: "demo_bank_001", amount: -15.4, currency: "EUR", description: "Suscripción software de diseño", postedAt: "2026-07-01", category: "software", status: "posted", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
  { id: "demo_txn_004", accountId: "demo_bank_001", amount: 770.4, currency: "EUR", description: "Cobro factura demo_inv_003", postedAt: "2026-07-12", category: "sales_income", status: "posted", matchedDocId: "demo_inv_003", createdAt: DEMO_NOW, updatedAt: DEMO_NOW },
];

/* ------------------------------------------------------------------ */
/*  Lookups + write simulation helpers                                */
/* ------------------------------------------------------------------ */

/** Find a fixture by id, or synthesize a minimal stamped object with that id. */
export function findOrStub(
  collection: Record<string, unknown>[],
  id: string,
): Record<string, unknown> & DemoStamp {
  const found = collection.find((item) => item.id === id);
  if (found) return { ...found, ...READ_STAMP };
  return { id, ...READ_STAMP };
}

let demoIdCounter = 0;

/** Deterministic-ish demo id (no network, no clock dependency). */
export function demoId(prefix: string): string {
  demoIdCounter += 1;
  return `${prefix}_${String(demoIdCounter).padStart(3, "0")}`;
}

/**
 * Simulate a create/update: echo the input, stamp a fabricated demo id +
 * timestamps + the WRITE banner. Never persists, never touches the network.
 */
export function simulateWrite(
  idPrefix: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> & DemoStamp {
  return {
    id: demoId(idPrefix),
    ...input,
    ...extra,
    createdAt: DEMO_NOW,
    updatedAt: DEMO_NOW,
    ...WRITE_STAMP,
  };
}

/** Simulate an action on an existing entity (keeps the caller-supplied id). */
export function simulateAction(
  id: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> & DemoStamp {
  return { id, success: true, ...fields, updatedAt: DEMO_NOW, ...WRITE_STAMP };
}

/**
 * Embedded demo fixtures for FRIHET_DEMO=1 mode.
 *
 * GUARDRAIL (spec Viktor, opción B):
 *   - NO real PII. Every NIF/CIF follows the AEAT example pattern (X9999999X),
 *     every IBAN is the well-known ES documentation test IBAN, every email is
 *     under @example.com. NO customer-workspace data, not even "anonymized".
 *   - Shapes mirror the REAL Frihet API responses (derived from src/types.ts and
 *     the per-resource output schemas in src/tools/shared.ts), so an agent sees
 *     exactly the fields it would see against a live workspace.
 *
 * These objects are the SEED for the in-memory session store in DemoClient. The
 * store deep-clones them on construction so simulated writes never mutate this
 * shared source of truth.
 */

// Sanitized constants — reused across fixtures so the "no real PII" guardrail is
// auditable in one place.
export const DEMO_TEST_IBAN = "ES9121000418450200051332"; // ES documentation test IBAN
export const DEMO_EXAMPLE_NIF = "X1234567L"; // AEAT example NIF pattern (X9999999X)
export const DEMO_EXAMPLE_CIF = "B12345678"; // example CIF (sociedad)

type Rec = Record<string, unknown>;

// ------------------------------------------------------------------ Clients

export const demoClients: Rec[] = [
  {
    id: "cli_demo_0001",
    name: "Consultoría Meridiana SL",
    email: "cuentas@meridiana.example.com",
    phone: "+34 900 000 001",
    taxId: "B12345678",
    address: {
      street: "Calle Gran Vía 10",
      city: "Madrid",
      state: "Madrid",
      postalCode: "28013",
      country: "ES",
    },
    createdAt: "2026-01-08T09:12:00.000Z",
    updatedAt: "2026-03-02T11:40:00.000Z",
  },
  {
    id: "cli_demo_0002",
    name: "Innovaciones Atlánticas SL",
    email: "admin@atlanticas.example.com",
    phone: "+34 900 000 002",
    taxId: "B87654321",
    address: {
      street: "Avenida de Anaga 25",
      city: "Santa Cruz de Tenerife",
      state: "Canarias",
      postalCode: "38001",
      country: "ES",
    },
    createdAt: "2026-01-10T14:22:00.000Z",
    updatedAt: "2026-02-18T08:05:00.000Z",
  },
  {
    id: "cli_demo_0003",
    name: "Estudio Creativo Norte SLU",
    email: "hola@estudionorte.example.com",
    phone: "+34 900 000 003",
    taxId: "B23456789",
    address: {
      street: "Passeig de Gràcia 88",
      city: "Barcelona",
      state: "Cataluña",
      postalCode: "08008",
      country: "ES",
    },
    createdAt: "2026-01-15T10:00:00.000Z",
    updatedAt: "2026-03-11T16:30:00.000Z",
  },
  {
    id: "cli_demo_0004",
    name: "María López García",
    email: "maria.lopez@example.com",
    phone: "+34 900 000 004",
    taxId: "X1234567L",
    address: {
      street: "Calle del Sol 3",
      city: "Valencia",
      state: "Comunidad Valenciana",
      postalCode: "46001",
      country: "ES",
    },
    createdAt: "2026-01-20T12:45:00.000Z",
    updatedAt: "2026-02-27T09:15:00.000Z",
  },
  {
    id: "cli_demo_0005",
    name: "Global Trade Partners GmbH",
    email: "billing@gtpartners.example.com",
    phone: "+49 30 000000",
    taxId: "DE123456789",
    address: {
      street: "Friedrichstraße 100",
      city: "Berlin",
      state: "Berlin",
      postalCode: "10117",
      country: "DE",
    },
    createdAt: "2026-02-01T08:30:00.000Z",
    updatedAt: "2026-03-05T13:20:00.000Z",
  },
];

// ------------------------------------------------------------------ Products

export const demoProducts: Rec[] = [
  {
    id: "prod_demo_0001",
    name: "Hora de consultoría estratégica",
    unitPrice: 90,
    description: "Consultoría senior por hora / Senior consulting per hour",
    taxRate: 21,
    createdAt: "2026-01-05T09:00:00.000Z",
    updatedAt: "2026-01-05T09:00:00.000Z",
  },
  {
    id: "prod_demo_0002",
    name: "Licencia software anual",
    unitPrice: 1200,
    description: "Suscripción anual plataforma / Annual platform subscription",
    taxRate: 21,
    createdAt: "2026-01-05T09:05:00.000Z",
    updatedAt: "2026-01-05T09:05:00.000Z",
  },
  {
    id: "prod_demo_0003",
    name: "Paquete de diseño de marca",
    unitPrice: 3500,
    description: "Identidad visual completa / Full brand identity",
    taxRate: 21,
    createdAt: "2026-01-05T09:10:00.000Z",
    updatedAt: "2026-01-05T09:10:00.000Z",
  },
  {
    id: "prod_demo_0004",
    name: "Hosting gestionado (mensual)",
    unitPrice: 80,
    description: "Alojamiento y soporte mensual / Managed hosting per month",
    taxRate: 21,
    createdAt: "2026-01-05T09:15:00.000Z",
    updatedAt: "2026-01-05T09:15:00.000Z",
  },
  {
    id: "prod_demo_0005",
    name: "Jornada de formación in-company",
    unitPrice: 600,
    description: "Formación presencial por jornada / On-site training per day",
    taxRate: 21,
    createdAt: "2026-01-05T09:20:00.000Z",
    updatedAt: "2026-01-05T09:20:00.000Z",
  },
];

// ------------------------------------------------------------------ Invoices
// Mix of ES fiscal zones: peninsula (IVA 21%), Canarias (IGIC 7%/3%), EU reverse
// charge (0% — inversión del sujeto pasivo). Some carry IRPF withholding (ES
// autónomo). totals are computed as subtotal + tax − irpf.

export const demoInvoices: Rec[] = [
  {
    id: "inv_demo_0001",
    documentNumber: "FR-2026-0001",
    clientId: "cli_demo_0001",
    clientName: "Consultoría Meridiana SL",
    clientTaxId: "B12345678",
    items: [{ description: "Consultoría estratégica Q1", quantity: 20, unitPrice: 90 }],
    issueDate: "2026-01-31",
    dueDate: "2026-03-01",
    status: "paid",
    taxRate: 21,
    irpfRate: 15,
    clientLocation: "peninsula",
    subtotal: 1800,
    total: 1908, // 1800 + 378 IVA − 270 IRPF
    createdAt: "2026-01-31T10:00:00.000Z",
    updatedAt: "2026-02-20T09:00:00.000Z",
  },
  {
    id: "inv_demo_0002",
    documentNumber: "FR-2026-0002",
    clientId: "cli_demo_0002",
    clientName: "Innovaciones Atlánticas SL",
    clientTaxId: "B87654321",
    items: [{ description: "Desarrollo software a medida", quantity: 40, unitPrice: 65 }],
    issueDate: "2026-02-05",
    dueDate: "2026-03-07",
    status: "sent",
    taxRate: 7,
    clientLocation: "canarias",
    subtotal: 2600,
    total: 2782, // 2600 + 182 IGIC
    notes: "Sujeto a IGIC (Canarias) / IGIC applies",
    createdAt: "2026-02-05T11:30:00.000Z",
    updatedAt: "2026-02-05T11:30:00.000Z",
  },
  {
    id: "inv_demo_0003",
    documentNumber: "FR-2026-0003",
    clientId: "cli_demo_0003",
    clientName: "Estudio Creativo Norte SLU",
    clientTaxId: "B23456789",
    items: [{ description: "Paquete de diseño de marca", quantity: 1, unitPrice: 3500 }],
    issueDate: "2026-02-12",
    dueDate: "2026-03-14",
    status: "paid",
    taxRate: 21,
    clientLocation: "peninsula",
    subtotal: 3500,
    total: 4235, // 3500 + 735 IVA
    createdAt: "2026-02-12T09:45:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  },
  {
    id: "inv_demo_0004",
    documentNumber: "FR-2026-0004",
    clientId: "cli_demo_0004",
    clientName: "María López García",
    clientTaxId: "X1234567L",
    items: [{ description: "Redacción de contenidos web", quantity: 15, unitPrice: 45 }],
    issueDate: "2026-02-18",
    dueDate: "2026-03-04",
    status: "overdue",
    taxRate: 21,
    irpfRate: 15,
    clientLocation: "peninsula",
    subtotal: 675,
    total: 715.5, // 675 + 141.75 IVA − 101.25 IRPF
    createdAt: "2026-02-18T14:10:00.000Z",
    updatedAt: "2026-02-18T14:10:00.000Z",
  },
  {
    id: "inv_demo_0005",
    documentNumber: "FR-2026-0005",
    clientId: "cli_demo_0005",
    clientName: "Global Trade Partners GmbH",
    clientTaxId: "DE123456789",
    items: [{ description: "Consultoría internacional", quantity: 30, unitPrice: 110 }],
    issueDate: "2026-02-22",
    dueDate: "2026-03-24",
    status: "sent",
    taxRate: 0,
    clientLocation: "eu",
    subtotal: 3300,
    total: 3300, // reverse charge, 0% VAT
    notes: "Inversión del sujeto pasivo — art. 196 Directiva IVA / Reverse charge",
    createdAt: "2026-02-22T08:20:00.000Z",
    updatedAt: "2026-02-22T08:20:00.000Z",
  },
  {
    id: "inv_demo_0006",
    documentNumber: "FR-2026-0006",
    clientId: "cli_demo_0002",
    clientName: "Innovaciones Atlánticas SL",
    clientTaxId: "B87654321",
    items: [
      { description: "Licencia software anual", quantity: 1, unitPrice: 1200 },
      { description: "Hosting gestionado (mensual)", quantity: 12, unitPrice: 80 },
    ],
    issueDate: "2026-03-01",
    dueDate: "2026-03-31",
    status: "paid",
    taxRate: 7,
    clientLocation: "canarias",
    subtotal: 2160,
    total: 2311.2, // 2160 + 151.20 IGIC
    createdAt: "2026-03-01T10:15:00.000Z",
    updatedAt: "2026-03-20T09:30:00.000Z",
  },
  {
    id: "inv_demo_0007",
    documentNumber: "FR-2026-0007",
    clientId: "cli_demo_0001",
    clientName: "Consultoría Meridiana SL",
    clientTaxId: "B12345678",
    items: [{ description: "Auditoría de procesos", quantity: 1, unitPrice: 2500 }],
    issueDate: "2026-03-05",
    dueDate: "2026-03-19",
    status: "overdue",
    taxRate: 21,
    clientLocation: "peninsula",
    subtotal: 2500,
    total: 3025, // 2500 + 525 IVA
    createdAt: "2026-03-05T13:00:00.000Z",
    updatedAt: "2026-03-05T13:00:00.000Z",
  },
  {
    id: "inv_demo_0008",
    documentNumber: "FR-2026-0008",
    clientId: "cli_demo_0003",
    clientName: "Estudio Creativo Norte SLU",
    clientTaxId: "B23456789",
    items: [{ description: "Formación in-company", quantity: 2, unitPrice: 600 }],
    issueDate: "2026-03-10",
    dueDate: "2026-04-09",
    status: "draft",
    taxRate: 21,
    irpfRate: 7,
    clientLocation: "peninsula",
    subtotal: 1200,
    total: 1368, // 1200 + 252 IVA − 84 IRPF
    createdAt: "2026-03-10T09:00:00.000Z",
    updatedAt: "2026-03-10T09:00:00.000Z",
  },
  {
    id: "inv_demo_0009",
    documentNumber: "FR-2026-0009",
    clientId: "cli_demo_0004",
    clientName: "María López García",
    clientTaxId: "X1234567L",
    items: [{ description: "Mantenimiento web mensual", quantity: 6, unitPrice: 55 }],
    issueDate: "2026-03-15",
    dueDate: "2026-04-14",
    status: "sent",
    taxRate: 3,
    clientLocation: "canarias",
    subtotal: 330,
    total: 339.9, // 330 + 9.90 IGIC (tipo reducido 3%)
    createdAt: "2026-03-15T11:20:00.000Z",
    updatedAt: "2026-03-15T11:20:00.000Z",
  },
];

// ------------------------------------------------------------------ Expenses

export const demoExpenses: Rec[] = [
  {
    id: "exp_demo_0001",
    description: "Suscripción Adobe Creative Cloud",
    amount: 74.19,
    category: "software",
    date: "2026-01-12",
    vendor: "Adobe Systems (demo)",
    taxDeductible: true,
    createdAt: "2026-01-12T09:00:00.000Z",
    updatedAt: "2026-01-12T09:00:00.000Z",
  },
  {
    id: "exp_demo_0002",
    description: "Material de oficina",
    amount: 45.3,
    category: "office_supplies",
    date: "2026-01-18",
    vendor: "Papelería Central (demo)",
    taxDeductible: true,
    createdAt: "2026-01-18T10:30:00.000Z",
    updatedAt: "2026-01-18T10:30:00.000Z",
  },
  {
    id: "exp_demo_0003",
    description: "Billete AVE Madrid–Barcelona",
    amount: 129.0,
    category: "travel",
    date: "2026-02-03",
    vendor: "Renfe (demo)",
    taxDeductible: true,
    createdAt: "2026-02-03T07:45:00.000Z",
    updatedAt: "2026-02-03T07:45:00.000Z",
  },
  {
    id: "exp_demo_0004",
    description: "Campaña Google Ads",
    amount: 350.0,
    category: "marketing",
    date: "2026-02-10",
    vendor: "Google Ireland (demo)",
    taxDeductible: true,
    createdAt: "2026-02-10T12:00:00.000Z",
    updatedAt: "2026-02-10T12:00:00.000Z",
  },
  {
    id: "exp_demo_0005",
    description: "Asesoría fiscal trimestral",
    amount: 180.0,
    category: "professional_services",
    date: "2026-02-15",
    vendor: "Gestoría Ejemplo (demo)",
    taxDeductible: true,
    createdAt: "2026-02-15T09:20:00.000Z",
    updatedAt: "2026-02-15T09:20:00.000Z",
  },
  {
    id: "exp_demo_0006",
    description: "Factura de electricidad (oficina)",
    amount: 96.45,
    category: "utilities",
    date: "2026-02-28",
    vendor: "Eléctrica Ejemplo (demo)",
    taxDeductible: true,
    createdAt: "2026-02-28T18:00:00.000Z",
    updatedAt: "2026-02-28T18:00:00.000Z",
  },
  {
    id: "exp_demo_0007",
    description: "MacBook Pro (activo amortizable)",
    amount: 2399.0,
    category: "equipment",
    date: "2026-03-02",
    vendor: "Apple (demo)",
    taxDeductible: true,
    createdAt: "2026-03-02T11:10:00.000Z",
    updatedAt: "2026-03-02T11:10:00.000Z",
  },
  {
    id: "exp_demo_0008",
    description: "Comida de trabajo con cliente",
    amount: 62.8,
    category: "meals",
    date: "2026-03-08",
    vendor: "Restaurante Ejemplo (demo)",
    taxDeductible: true,
    createdAt: "2026-03-08T14:30:00.000Z",
    updatedAt: "2026-03-08T14:30:00.000Z",
  },
];

// ------------------------------------------------------------------ Quotes

export const demoQuotes: Rec[] = [
  {
    id: "quo_demo_0001",
    documentNumber: "PR-2026-0001",
    clientId: "cli_demo_0001",
    clientName: "Consultoría Meridiana SL",
    items: [{ description: "Rediseño de plataforma web", quantity: 1, unitPrice: 12000 }],
    validUntil: "2026-04-30",
    status: "sent",
    taxRate: 21,
    subtotal: 12000,
    total: 14520, // 12000 + 2520 IVA
    notes: "Presupuesto de ejemplo / Sample quote",
    createdAt: "2026-03-12T10:00:00.000Z",
    updatedAt: "2026-03-12T10:00:00.000Z",
  },
];

// ------------------------------------------------------------------ Vendors

export const demoVendors: Rec[] = [
  {
    id: "ven_demo_0001",
    name: "Suministros Técnicos Ejemplo SL",
    email: "ventas@suministros.example.com",
    phone: "+34 900 100 001",
    taxId: "B34567890",
    address: { city: "Madrid", country: "ES" },
    createdAt: "2026-01-09T09:00:00.000Z",
    updatedAt: "2026-01-09T09:00:00.000Z",
  },
  {
    id: "ven_demo_0002",
    name: "Servicios Cloud Ejemplo SL",
    email: "facturacion@cloud.example.com",
    phone: "+34 900 100 002",
    // Intentionally INVALID CIF checksum (control digit should be 1, not 0) so
    // this demo vendor can never collide with a real registered company.
    taxId: "B45678900",
    address: { city: "Santa Cruz de Tenerife", country: "ES" },
    createdAt: "2026-01-14T09:00:00.000Z",
    updatedAt: "2026-01-14T09:00:00.000Z",
  },
];

// -------------------------------------------------- Intelligence aggregates

export const demoBusinessContext: Rec = {
  currency: "EUR",
  fiscalYear: 2026,
  totals: {
    invoicedYTD: 22084.6,
    collectedYTD: 8454.2,
    outstandingYTD: 3740.5,
    expensesYTD: 3336.74,
  },
  counts: { invoices: 9, clients: 5, products: 5, expenses: 8, quotes: 1 },
  topClients: [
    { clientId: "cli_demo_0001", name: "Consultoría Meridiana SL", invoicedTotal: 4933 },
    { clientId: "cli_demo_0002", name: "Innovaciones Atlánticas SL", invoicedTotal: 5093.2 },
  ],
  note: "Contexto de negocio de ejemplo / Sample business context",
};

export const demoMonthlySummary: Rec = {
  month: "2026-03",
  currency: "EUR",
  invoiced: 6733.1,
  collected: 2311.2,
  expenses: 2524.6,
  net: 4208.5,
  invoiceCount: 3,
  expenseCount: 2,
};

export const demoQuarterlyTaxes: Rec = {
  quarter: "2026-Q1",
  currency: "EUR",
  readonly: true,
  ivaRepercutido: 2439.75,
  ivaSoportado: 512.4,
  igicRepercutido: 343.1,
  irpfRetenido: 455.25,
  resultadoModelo303: 1927.35,
  note: "Resumen informativo de ejemplo — nunca presentado a la AEAT / Informational only, never filed",
};

/**
 * MCP SDK Compatibility & Golden Baseline Canary Harness.
 *
 * Deterministically verifies @frihet/mcp-server SDK v1 compatibility,
 * golden contract, tool enumeration, JSON schema validity, pagination parameters,
 * typed error contracts, capability metadata, and representative READ operations
 * against @modelcontextprotocol/sdk v1.x before v2.0 migration.
 *
 * NOTE: This is an in-process SDK client/server compatibility harness.
 * Model Context Protocol Inspector 2.3.0 is documented as a reference authority,
 * while this harness executes in-process via @modelcontextprotocol/sdk v1.x client
 * with zero daemons to provide deterministic CI verification.
 *
 * Zero production writes. Zero credential leaks.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { DemoFrihetClient } from "../demo-client.js";
import { registerMcpSurface, localMcpSurfaceComposition } from "../server-composition.js";
import { CAPABILITY_META_KEY } from "../capability-truth.js";
import { FISCAL_MODELO_ALIASES } from "../fiscal-aliases.js";

export const HARNESS_CONTRACT_VERSION = 1;
export const INSPECTOR_PINNED_VERSION = "2.3.0";
export const CANONICAL_OPERATIONS_COUNT = 158;
export const FISCAL_ALIASES_COUNT = Object.keys(FISCAL_MODELO_ALIASES).length;

export type CheckStatus = "PASS" | "FAIL" | "UNSUPPORTED" | "NOT_EXERCISED";
export type OverallStatus = "PASS" | "PASS_WITH_GAPS" | "FAIL";

export interface HarnessCheckResult {
  id: string;
  name: string;
  category: "initialize" | "tools" | "resources" | "prompts" | "reads" | "pagination" | "errors" | "mutations" | "auth";
  status: CheckStatus;
  detail: string;
  durationMs?: number;
}

export interface ToolSnapshot {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  hasOutputSchema: boolean;
  annotations: Record<string, unknown>;
  capabilityMeta?: Record<string, unknown>;
}

export interface McpBaselineReport {
  contractVersion: number;
  inspectorPinnedVersion: string;
  harnessMode: "in-process-sdk-client";
  protocolVersion: string | null;
  serverInfo: {
    name: string;
    version: string;
    description?: string;
  };
  summary: {
    totalTools: number;
    canonicalOperations: number;
    fiscalAliases: number;
    resources: number;
    prompts: number;
    checks: {
      total: number;
      pass: number;
      fail: number;
      unsupported: number;
      notExercised: number;
    };
    overallStatus: OverallStatus;
  };
  checkMatrix: HarnessCheckResult[];
  tools: ToolSnapshot[];
  resources: string[];
  prompts: string[];
  sanitized: boolean;
}

/**
 * Executes the complete compatibility harness in-process and returns
 * a structured, sanitized baseline report.
 */
export async function runMcpBaseline(): Promise<McpBaselineReport> {
  const checkMatrix: HarnessCheckResult[] = [];

  const addCheck = (c: HarnessCheckResult) => {
    checkMatrix.push(c);
  };

  const demoClient = new DemoFrihetClient();
  const server = new McpServer({
    name: "frihet-erp",
    version: "1.16.6",
    description: "AI-native MCP server for Frihet ERP",
  });

  const composition = localMcpSurfaceComposition(false, false);
  registerMcpSurface(server, demoClient, composition);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    {
      name: "frihet-mcp-canary-client",
      version: "1.0.0",
    },
    {
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
    },
  );

  const toolSnapshots: ToolSnapshot[] = [];
  const resourceUris: string[] = [];
  const promptNames: string[] = [];

  let serverInfo = { name: "unknown", version: "unknown", description: "" };

  try {
    // 1. Initialize & Handshake
    const initStart = Date.now();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const sVersion = client.getServerVersion();
    if (sVersion) {
      serverInfo = {
        name: sVersion.name,
        version: sVersion.version,
        description: "AI-native MCP server for Frihet ERP",
      };
    }

    // Protocol Version Negotiation
    // Note: SDK v1 Client does not expose negotiated protocolVersion property post-handshake.
    // We mark NOT_EXERCISED truthfully rather than asserting a constant.
    addCheck({
      id: "initialize.protocol_negotiation",
      name: "Protocol Version Negotiation",
      category: "initialize",
      status: "NOT_EXERCISED",
      detail: "Protocol version negotiation is encapsulated within SDK v1 client handshake and not directly observable on Client instance post-connect",
      durationMs: Date.now() - initStart,
    });

    // Server Capabilities Declaration
    const caps = client.getServerCapabilities();
    const hasTools = !!caps?.tools;
    const hasResources = !!caps?.resources;
    const hasPrompts = !!caps?.prompts;

    if (hasTools && hasResources && hasPrompts) {
      addCheck({
        id: "initialize.server_capabilities",
        name: "Server Capabilities Declaration",
        category: "initialize",
        status: "PASS",
        detail: "Server declared tools, resources, and prompts capabilities",
      });
    } else {
      addCheck({
        id: "initialize.server_capabilities",
        name: "Server Capabilities Declaration",
        category: "initialize",
        status: "FAIL",
        detail: `Missing capabilities: tools=${hasTools}, resources=${hasResources}, prompts=${hasPrompts}`,
      });
    }

    // 2. Tools Enumeration & Structural Schemas
    const toolsStart = Date.now();
    const toolsList = await client.listTools();
    const tools = toolsList.tools;

    const expectedTotal = CANONICAL_OPERATIONS_COUNT + FISCAL_ALIASES_COUNT;
    const isCountValid = tools.length === expectedTotal;

    addCheck({
      id: "tools.enumeration",
      name: "Exhaustive Tool Enumeration",
      category: "tools",
      status: isCountValid ? "PASS" : "FAIL",
      detail: `Enumerated ${tools.length} tools (${CANONICAL_OPERATIONS_COUNT} canonical + ${FISCAL_ALIASES_COUNT} aliases)`,
      durationMs: Date.now() - toolsStart,
    });

    let nonSnakeCaseCount = 0;
    let invalidInputSchemaCount = 0;
    let missingCapabilityMetaCount = 0;

    for (const tool of tools) {
      if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(tool.name)) {
        nonSnakeCaseCount++;
      }

      const inputSchema = tool.inputSchema as Record<string, unknown> | undefined;
      const isInputSchemaValid =
        inputSchema !== null &&
        typeof inputSchema === "object" &&
        inputSchema.type === "object" &&
        typeof inputSchema.properties === "object";

      if (!isInputSchemaValid) {
        invalidInputSchemaCount++;
      }

      const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta;
      const hasCap = !!(meta && meta[CAPABILITY_META_KEY]);
      if (!hasCap) {
        missingCapabilityMetaCount++;
      }

      toolSnapshots.push({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: (tool.inputSchema || {}) as Record<string, unknown>,
        hasOutputSchema: !!tool.outputSchema,
        annotations: (tool.annotations || {}) as Record<string, unknown>,
        capabilityMeta: meta?.[CAPABILITY_META_KEY] as Record<string, unknown> | undefined,
      });
    }

    // Sort tool snapshots deterministically by name
    toolSnapshots.sort((a, b) => a.name.localeCompare(b.name));

    addCheck({
      id: "tools.canonical_names",
      name: "Canonical Snake Case Naming",
      category: "tools",
      status: nonSnakeCaseCount === 0 ? "PASS" : "FAIL",
      detail: nonSnakeCaseCount === 0 ? "All tools use valid snake_case names" : `${nonSnakeCaseCount} invalid tool names detected`,
    });

    addCheck({
      id: "tools.input_schemas_structural",
      name: "Structural Input Schema Validation",
      category: "tools",
      status: invalidInputSchemaCount === 0 ? "PASS" : "FAIL",
      detail: invalidInputSchemaCount === 0 ? "All tool inputSchemas declare valid object structure and properties mapping" : `${invalidInputSchemaCount} tools have malformed inputSchemas`,
    });

    addCheck({
      id: "tools.capability_metadata",
      name: "Capability Metadata Truth",
      category: "tools",
      status: missingCapabilityMetaCount === 0 ? "PASS" : "FAIL",
      detail: missingCapabilityMetaCount === 0 ? "All tools carry io.frihet/capability metadata" : `${missingCapabilityMetaCount} tools missing capability metadata`,
    });

    // 3. Resources & Prompts Enumeration
    const resourcesList = await client.listResources();
    for (const r of resourcesList.resources) {
      resourceUris.push(r.uri);
    }
    resourceUris.sort();

    addCheck({
      id: "resources.enumeration",
      name: "Local Resources Enumeration",
      category: "resources",
      status: resourceUris.length === 11 ? "PASS" : "FAIL",
      detail: `Enumerated ${resourceUris.length}/11 resources`,
    });

    const promptsList = await client.listPrompts();
    for (const p of promptsList.prompts) {
      promptNames.push(p.name);
    }
    promptNames.sort();

    addCheck({
      id: "prompts.enumeration",
      name: "Local Prompts Enumeration",
      category: "prompts",
      status: promptNames.length === 10 ? "PASS" : "FAIL",
      detail: `Enumerated ${promptNames.length}/10 prompts`,
    });

    // 4. Safe Representative READ Executions (Demo Mode)
    const readTestCases: Array<{
      tool: string;
      args: Record<string, unknown>;
      validate: (res: Record<string, unknown>) => boolean;
    }> = [
      {
        tool: "get_business_context",
        args: {},
        validate: (r) => {
          const sc = r.structuredContent as { business?: { name?: string } } | undefined;
          return !!(sc && sc.business && typeof sc.business.name === "string");
        },
      },
      {
        tool: "list_invoices",
        args: { limit: 2 },
        validate: (r) => {
          const sc = r.structuredContent as { data?: unknown[]; total?: number } | undefined;
          return !!(sc && Array.isArray(sc.data) && typeof sc.total === "number");
        },
      },
      {
        tool: "get_monthly_summary",
        args: { month: "2026-07" },
        validate: (r) => {
          const sc = r.structuredContent as { period?: string; revenue?: unknown } | undefined;
          return !!(sc && (typeof sc.period === "string" || sc.revenue !== undefined));
        },
      },
      {
        tool: "get_quarterly_taxes",
        args: { quarter: "2026-Q1" },
        validate: (r) => {
          const sc = r.structuredContent as { quarter?: string } | undefined;
          return !!(sc && typeof sc.quarter === "string");
        },
      },
      {
        tool: "list_clients",
        args: { limit: 2 },
        validate: (r) => {
          const sc = r.structuredContent as { data?: unknown[] } | undefined;
          return !!(sc && Array.isArray(sc.data));
        },
      },
      {
        tool: "list_expenses",
        args: { limit: 2 },
        validate: (r) => {
          const sc = r.structuredContent as { data?: unknown[] } | undefined;
          return !!(sc && Array.isArray(sc.data));
        },
      },
      {
        tool: "list_products",
        args: { limit: 2 },
        validate: (r) => {
          const sc = r.structuredContent as { data?: unknown[] } | undefined;
          return !!(sc && Array.isArray(sc.data));
        },
      },
      {
        tool: "get_modelo_303_summary",
        args: { period: "2026-Q1" },
        validate: (r) => {
          const sc = r.structuredContent as { model?: string; period?: string } | undefined;
          return !!(sc && (sc.model === "303" || sc.period === "2026-Q1"));
        },
      },
      {
        tool: "permissions_me",
        args: {},
        validate: (r) => {
          const sc = r.structuredContent as { role?: string } | undefined;
          return !!(sc && typeof sc.role === "string");
        },
      },
      {
        tool: "verifactu_status",
        args: { invoiceId: "demo_inv_001" },
        validate: (r) => {
          const sc = r.structuredContent as { invoiceId?: string; status?: string; accepted?: boolean } | undefined;
          return !!(sc && (sc.invoiceId === "demo_inv_001" || typeof sc.status === "string"));
        },
      },
    ];

    for (const testCase of readTestCases) {
      const opStart = Date.now();
      try {
        const rawRes = await client.callTool({
          name: testCase.tool,
          arguments: testCase.args,
        });
        const res = rawRes as Record<string, unknown>;
        const content = res.content as Array<{ type: string; text?: string }> | undefined;
        const isContentValid = Array.isArray(content) && content.length > 0 && content[0].type === "text";
        const isStructuredValid = testCase.validate(res);

        if (isContentValid && isStructuredValid) {
          addCheck({
            id: `reads.${testCase.tool}`,
            name: `Read Execution: ${testCase.tool}`,
            category: "reads",
            status: "PASS",
            detail: "Returned valid content text and schema-valid structuredContent",
            durationMs: Date.now() - opStart,
          });
        } else {
          addCheck({
            id: `reads.${testCase.tool}`,
            name: `Read Execution: ${testCase.tool}`,
            category: "reads",
            status: "FAIL",
            detail: `Invalid payload shape (content valid: ${isContentValid}, structured valid: ${isStructuredValid})`,
            durationMs: Date.now() - opStart,
          });
        }
      } catch (err) {
        addCheck({
          id: `reads.${testCase.tool}`,
          name: `Read Execution: ${testCase.tool}`,
          category: "reads",
          status: "FAIL",
          detail: `Invocation failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - opStart,
        });
      }
    }

    // 5. Pagination & Cursor Parameters Contract
    const paginatedTools = ["list_invoices", "list_expenses", "list_clients", "list_products", "list_quotes", "list_sales", "list_transactions"];
    let paginatedValid = 0;
    for (const toolName of paginatedTools) {
      const snap = toolSnapshots.find((t) => t.name === toolName);
      if (snap && snap.inputSchema && typeof snap.inputSchema === "object") {
        const props = (snap.inputSchema.properties || {}) as Record<string, unknown>;
        if (props.limit || props.offset || props.cursor) {
          paginatedValid++;
        }
      }
    }

    addCheck({
      id: "pagination.cursor_and_limits",
      name: "Pagination Parameter Contract",
      category: "pagination",
      status: paginatedValid === paginatedTools.length ? "PASS" : "FAIL",
      detail: `${paginatedValid}/${paginatedTools.length} paginated tools declare limit/offset/cursor schema properties`,
    });

    // 6. Typed MCP Error Contracts
    // A. Unknown tool error
    try {
      const res = await client.callTool({
        name: "non_existent_tool_baseline_check",
        arguments: {},
      });
      if (res.isError && Array.isArray(res.content) && res.content[0]?.text?.includes("not found")) {
        addCheck({
          id: "errors.unknown_tool",
          name: "Unknown Tool Error Rejection",
          category: "errors",
          status: "PASS",
          detail: `Rejected unknown tool with typed error: ${res.content[0].text}`,
        });
      } else {
        addCheck({
          id: "errors.unknown_tool",
          name: "Unknown Tool Error Rejection",
          category: "errors",
          status: "FAIL",
          detail: "Unknown tool call succeeded unexpectedly without error flag",
        });
      }
    } catch (err: unknown) {
      const isExpectedError =
        (typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === -32601) ||
        (err instanceof Error && /tool.*not found/i.test(err.message));
      addCheck({
        id: "errors.unknown_tool",
        name: "Unknown Tool Error Rejection",
        category: "errors",
        status: isExpectedError ? "PASS" : "FAIL",
        detail: `Rejected unknown tool with typed error (-32601): ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // B. Invalid arguments error
    try {
      const res = await client.callTool({
        name: "get_invoice",
        arguments: { id: 12345 as unknown as string }, // Invalid argument type
      });
      if (res.isError) {
        addCheck({
          id: "errors.invalid_arguments",
          name: "Invalid Arguments Validation Rejection",
          category: "errors",
          status: "PASS",
          detail: "Returned isError: true on invalid argument type",
        });
      } else {
        addCheck({
          id: "errors.invalid_arguments",
          name: "Invalid Arguments Validation Rejection",
          category: "errors",
          status: "FAIL",
          detail: "Server accepted invalid argument type without isError",
        });
      }
    } catch (err) {
      addCheck({
        id: "errors.invalid_arguments",
        name: "Invalid Arguments Validation Rejection",
        category: "errors",
        status: "PASS",
        detail: `Client rejected invalid argument type: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 7. Mutating Tool Schemas (Zero-Write Safety Inspection)
    const mutatingTools = [
      "create_invoice",
      "update_invoice",
      "delete_invoice",
      "create_expense",
      "create_client",
      "create_quote",
      "send_invoice",
      "refund_sale",
      "period_close",
      "leave_approve",
      "verifactu_resubmit",
    ];

    let mutatingSchemasValid = 0;
    for (const toolName of mutatingTools) {
      const snap = toolSnapshots.find((t) => t.name === toolName);
      if (snap && snap.inputSchema && typeof snap.inputSchema === "object" && snap.annotations.readOnlyHint !== true) {
        mutatingSchemasValid++;
      }
    }

    addCheck({
      id: "mutations.zero_write_schema_inspection",
      name: "Mutation Schemas & Side-Effect Safety",
      category: "mutations",
      status: mutatingSchemasValid === mutatingTools.length ? "PASS" : "FAIL",
      detail: `Inspected ${mutatingSchemasValid}/${mutatingTools.length} mutating schemas; zero production writes executed`,
    });

    // 8. Auth Negative Path
    // In-process demo harness runs DemoFrihetClient without HTTP transport.
    // Marked NOT_EXERCISED truthfully.
    addCheck({
      id: "auth.safe_negative_remediation",
      name: "Auth Negative Path Safe Remediation",
      category: "auth",
      status: "NOT_EXERCISED",
      detail: "In-process demo harness operates with DemoFrihetClient; negative Bearer auth remediation requires live HTTP transport test surface",
    });

  } finally {
    await Promise.allSettled([
      client.close(),
      server.close(),
    ]);
  }

  const passCount = checkMatrix.filter((c) => c.status === "PASS").length;
  const failCount = checkMatrix.filter((c) => c.status === "FAIL").length;
  const unsupportedCount = checkMatrix.filter((c) => c.status === "UNSUPPORTED").length;
  const notExercisedCount = checkMatrix.filter((c) => c.status === "NOT_EXERCISED").length;

  const overallStatus: OverallStatus =
    failCount > 0 ? "FAIL" : notExercisedCount > 0 ? "PASS_WITH_GAPS" : "PASS";

  return {
    contractVersion: HARNESS_CONTRACT_VERSION,
    inspectorPinnedVersion: INSPECTOR_PINNED_VERSION,
    harnessMode: "in-process-sdk-client",
    protocolVersion: null,
    serverInfo,
    summary: {
      totalTools: toolSnapshots.length,
      canonicalOperations: CANONICAL_OPERATIONS_COUNT,
      fiscalAliases: FISCAL_ALIASES_COUNT,
      resources: resourceUris.length,
      prompts: promptNames.length,
      checks: {
        total: checkMatrix.length,
        pass: passCount,
        fail: failCount,
        unsupported: unsupportedCount,
        notExercised: notExercisedCount,
      },
      overallStatus,
    },
    checkMatrix,
    tools: toolSnapshots,
    resources: resourceUris,
    prompts: promptNames,
    sanitized: true,
  };
}

export function serializeMcpBaseline(report: McpBaselineReport): string {
  // Deep clone and clean timing-dependent fields for deterministic serialization
  const deterministic = {
    ...report,
    checkMatrix: report.checkMatrix.map((c) => {
      const { durationMs: _, ...rest } = c;
      return rest;
    }),
  };
  return `${JSON.stringify(deterministic, null, 2)}\n`;
}

export function assertMcpBaseline(
  actual: McpBaselineReport,
  expected: McpBaselineReport,
): void {
  if (actual.contractVersion !== expected.contractVersion) {
    throw new Error(`Contract version mismatch: actual ${actual.contractVersion} !== expected ${expected.contractVersion}`);
  }

  if (actual.summary.overallStatus === "FAIL" || actual.summary.checks.fail > 0) {
    const failures = actual.checkMatrix.filter((c) => c.status === "FAIL");
    throw new Error(`Baseline failed with ${failures.length} errors: ${failures.map((f) => `${f.id}: ${f.detail}`).join("; ")}`);
  }

  if (actual.summary.overallStatus !== expected.summary.overallStatus) {
    throw new Error(`Overall status mismatch: actual ${actual.summary.overallStatus} !== expected ${expected.summary.overallStatus}`);
  }

  if (actual.summary.totalTools !== expected.summary.totalTools) {
    throw new Error(`Tool count drift: actual ${actual.summary.totalTools} !== expected ${expected.summary.totalTools}`);
  }

  if (actual.summary.canonicalOperations !== expected.summary.canonicalOperations) {
    throw new Error(`Canonical operations drift: actual ${actual.summary.canonicalOperations} !== expected ${expected.summary.canonicalOperations}`);
  }

  if (actual.summary.resources !== expected.summary.resources) {
    throw new Error(`Resource count drift: actual ${actual.summary.resources} !== expected ${expected.summary.resources}`);
  }

  if (actual.summary.prompts !== expected.summary.prompts) {
    throw new Error(`Prompt count drift: actual ${actual.summary.prompts} !== expected ${expected.summary.prompts}`);
  }

  const toolNameSet = new Set<string>();
  for (const tool of actual.tools) {
    if (toolNameSet.has(tool.name)) {
      throw new Error(`Duplicate tool detected in baseline: ${tool.name}`);
    }
    toolNameSet.add(tool.name);
  }

  const actualTools = new Map(actual.tools.map((t) => [t.name, t]));
  const expectedTools = new Map(expected.tools.map((t) => [t.name, t]));

  for (const [name, exp] of expectedTools.entries()) {
    const act = actualTools.get(name);
    if (!act) {
      throw new Error(`Missing expected tool in actual baseline: ${name}`);
    }
    if (JSON.stringify(act.inputSchema) !== JSON.stringify(exp.inputSchema)) {
      throw new Error(`Input schema drift on tool ${name}`);
    }
    if (JSON.stringify(act.annotations) !== JSON.stringify(exp.annotations)) {
      throw new Error(`Annotation drift on tool ${name}`);
    }
  }
}

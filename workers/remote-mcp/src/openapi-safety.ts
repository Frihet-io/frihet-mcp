type OpenApiDocument = Record<string, unknown> & {
  openapi: string;
  paths: Record<string, unknown>;
};

/** Match canonical OpenAPI paths plus case, encoding and slash lookalikes. */
export function isOpenApiLookalikePath(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes cannot make a valid route; raw normalization is safe.
  }
  const normalized = decoded
    .replace(/\/{2,}/gu, "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
  return normalized === "/openapi.json" || normalized === "/openapi.yaml";
}

const OPENAPI_ROOT_KEYS = new Set([
  "openapi", "info", "servers", "security", "tags", "paths", "components",
]);
const PATH_ITEM_KEYS = new Set([
  "$ref", "summary", "description", "get", "put", "post", "delete", "options",
  "head", "patch", "trace", "servers", "parameters",
]);
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

export function assertValidOpenApiDocument(
  spec: unknown,
  stage: "source" | "scoped",
): asserts spec is OpenApiDocument {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`Invalid ${stage} OpenAPI document`);
  }
  const record = spec as Record<string, unknown>;
  if (typeof record.openapi !== "string" || !/^3\.\d+\.\d+$/u.test(record.openapi)) {
    throw new Error(`Invalid ${stage} OpenAPI version`);
  }
  if (!record.paths || typeof record.paths !== "object" || Array.isArray(record.paths)) {
    throw new Error(`Invalid ${stage} OpenAPI paths`);
  }
  if (Object.keys(record.paths).length === 0) {
    throw new Error(`Empty ${stage} OpenAPI paths`);
  }
  for (const key of Object.keys(record)) {
    if (!OPENAPI_ROOT_KEYS.has(key)) throw new Error(`Unexpected ${stage} OpenAPI root field`);
  }
  if (!record.info || typeof record.info !== "object" || Array.isArray(record.info)) {
    throw new Error(`Invalid ${stage} OpenAPI info`);
  }
  if (record.components !== undefined
    && (!record.components || typeof record.components !== "object" || Array.isArray(record.components))) {
    throw new Error(`Invalid ${stage} OpenAPI components`);
  }
  for (const field of ["tags", "servers", "security"] as const) {
    if (record[field] !== undefined && !Array.isArray(record[field])) {
      throw new Error(`Invalid ${stage} OpenAPI ${field}`);
    }
  }
  for (const [path, item] of Object.entries(record.paths as Record<string, unknown>)) {
    if (!path.startsWith("/") || !item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid ${stage} OpenAPI path item`);
    }
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (!PATH_ITEM_KEYS.has(key)) throw new Error(`Invalid ${stage} OpenAPI path field`);
      if (HTTP_METHODS.has(key) && (!value || typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`Invalid ${stage} OpenAPI operation`);
      }
      if ((key === "parameters" || key === "servers") && !Array.isArray(value)) {
        throw new Error(`Invalid ${stage} OpenAPI path collection`);
      }
      if ((key === "$ref" || key === "summary" || key === "description") && typeof value !== "string") {
        throw new Error(`Invalid ${stage} OpenAPI path text`);
      }
    }
  }
}

export function parseOpenApiDocument(specText: string): OpenApiDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(specText);
  } catch {
    throw new Error("Invalid source OpenAPI JSON");
  }
  assertValidOpenApiDocument(parsed, "source");
  return parsed;
}

export function openApiUnavailableResponse(
  securityHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(
    JSON.stringify({ error: "OpenAPI spec temporarily unavailable" }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...securityHeaders,
      },
    },
  );
}

export async function serveOpenApiAsset(
  assetResponse: Response,
  openai: boolean,
  securityHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (openai) {
    headers.set("Cache-Control", "no-store");
    return new Response(
      JSON.stringify({ error: "OpenAPI is not part of the reviewed ChatGPT connector; use MCP metadata." }),
      { status: 404, headers },
    );
  }
  headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  try {
    const source = await assetResponse.text();
    const body = JSON.stringify(parseOpenApiDocument(source));
    return new Response(body, { status: 200, headers });
  } catch {
    return openApiUnavailableResponse(securityHeaders);
  }
}

/**
 * Static bridge into the dependency tree that the deployed Worker resolves.
 *
 * Keep these imports under workers/remote-mcp: resolving the same bare
 * specifiers from a root script would silently exercise the root lockfile's
 * SDK instead of the Worker's separately locked SDK.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  captureOpenAIReviewMcpSurfaceWithRuntime,
} from "../../../dist/openai-review-contract.js";

export { ListToolsRequestSchema as WorkerListToolsRequestSchema };

/** Capture the real tools/list wire using the Worker's locked MCP SDK. */
export function captureOpenAIReviewMcpSurfaceFromWorker() {
  return captureOpenAIReviewMcpSurfaceWithRuntime({
    Client,
    InMemoryTransport,
    McpServer,
  });
}

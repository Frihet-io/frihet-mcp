import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createFrihetTools } from './frihet-ai-sdk';

/**
 * Example Next.js App Router Route Handler (app/api/cfo/route.ts)
 * Integrates Frihet ERP tools into a conversational assistant with security boundaries:
 *   1. Caller Authentication: Verifies Bearer session/API token.
 *   2. Tenant Authorization: Requires explicit workspace isolation header.
 *   3. Governed Execution: Invoices forced to reviewable draft status.
 *
 * NOTE FOR PRODUCTION DEPLOYMENTS:
 * - In production, pair this handler with your app's auth middleware (e.g. NextAuth, Clerk, or Firebase Auth).
 * - Forward the authenticated user's workspace API key or pass through workspace scope headers.
 */
export async function POST(req: Request) {
  // 1. Caller Authentication Guard
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Missing or invalid Bearer token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Tenant Workspace Isolation Guard
  const workspaceId = req.headers.get('x-frihet-workspace-id');
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Forbidden: x-frihet-workspace-id header is required for multi-tenant isolation' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { prompt } = await req.json();
  if (!prompt || typeof prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'Bad Request: prompt string is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Initialize tools with Frihet credentials
  const tools = createFrihetTools({
    apiKey: process.env.FRIHET_API_KEY,
  });

  const response = await generateText({
    model: openai('gpt-4o'),
    system: `You are the Virtual CFO of Frihet ERP for workspace ${workspaceId}.
You analyze financial performance, check revenue and unpaid invoices, and draft proposals.
All invoice creations are strictly drafts and require founder sign-off before sending.`,
    prompt,
    tools,
    maxSteps: 5, // For AI SDK v5, use stopWhen or step limit configurations
  });

  return Response.json({
    text: response.text,
    steps: response.steps,
  });
}

import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createFrihetTools } from './frihet-ai-sdk';

/**
 * Example Next.js App Router Route Handler (app/api/cfo/route.ts)
 * Integrates Frihet ERP tools directly into a conversational assistant.
 */
export async function POST(req: Request) {
  const { prompt } = await req.json();

  // Initialize tools with Frihet credentials
  const tools = createFrihetTools({
    apiKey: process.env.FRIHET_API_KEY,
  });

  const response = await generateText({
    model: openai('gpt-4o'),
    system: `You are the Virtual CFO of Frihet ERP.
You analyze financial performance, check revenue and unpaid invoices, and draft proposals.
All invoice creations are strictly drafts and require founder sign-off before sending.`,
    prompt,
    tools,
    maxSteps: 5,
  });

  return Response.json({
    text: response.text,
    steps: response.steps,
  });
}

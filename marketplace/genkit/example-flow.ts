/**
 * Example: Using Frihet ERP with Google Genkit and Gemini 1.5/2.0
 *
 * Requirements:
 *   npm install genkit @genkit-ai/googleai zod
 *
 * Environment:
 *   export GEMINI_API_KEY="your-gemini-key"
 *   export FRIHET_API_KEY="your-frihet-key"
 */

import { genkit, z } from 'genkit';
import { googleAI, gemini15Flash } from '@genkit-ai/googleai';
import { createFrihetGenkitTools } from './frihet-genkit.js';

// Initialize Genkit with Google AI plugin
const ai = genkit({
  plugins: [googleAI()],
  model: gemini15Flash,
});

// Register Frihet tools with Genkit
const frihetTools = createFrihetGenkitTools(ai);

// Define an AI financial assistant flow
export const financialCopilotFlow = ai.defineFlow(
  {
    name: 'financialCopilot',
    inputSchema: z.string().describe('User financial inquiry or task'),
    outputSchema: z.string(),
  },
  async (prompt) => {
    const response = await ai.generate({
      prompt: `You are an AI financial copilot powered by Frihet ERP.
Help the business owner manage invoicing, tax overviews, and expenses.
Rule: Any invoice creation is strictly a DRAFT for review.
User request: ${prompt}`,
      tools: frihetTools,
    });

    return response.text;
  }
);

// If executed directly:
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('example-flow.ts')) {
  financialCopilotFlow('What is our revenue and estimated tax for Q3?')
    .then((result) => console.log('Copilot Answer:\n', result))
    .catch((err) => console.error('Error running flow:', err));
}

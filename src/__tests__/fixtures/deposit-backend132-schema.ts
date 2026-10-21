import { z } from "zod/v4";

// Independent wire oracle copied from deployed publicApi v132, lines929–938.
// replacements.zip SHA256: 02bb8a6e0980f14cbace9b42ff35f162fdee44418762b3abd0748cba17796c73
// src/publicApi.ts SHA256: 5226670957c4b586818ce3da188f7a6d8dc8126a55ba4e995ca66ba7528b5d5b
export const backend132DepositSchema = z.object({
  clientId: z.string().min(1).max(128),
  clientName: z.string().min(1).max(500),
  amount: z.number().positive(),
  currency: z.string().length(3).default('EUR'),
  description: z.string().min(1).max(2000),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.string().max(200).optional(),
  paymentReference: z.string().max(200).optional(),
}).strict();

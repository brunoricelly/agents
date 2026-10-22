import { z } from "zod";

export const CustomerProfileSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  chatwootContactId: z.number().int().positive().nullable().optional(),
  fullName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  preferredChannel: z
    .enum(["whatsapp", "web_widget", "instagram", "email", "api"])
    .default("whatsapp"),
  sentimentScore: z.number().min(-1).max(1).default(0),
  tags: z.array(z.string()).default([]),
  customAttributes: z.record(z.string(), z.unknown()).default({}),
  summary: z.string().nullable().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;

export const CustomerMemorySchema = z.object({
  id: z.string().uuid().optional(),
  tenantId: z.string().uuid(),
  customerId: z.string().uuid(),
  channel: z.string().min(1),
  sessionId: z.string().nullable().optional(),
  content: z.string().min(1),
  summary: z.string().nullable().optional(),
  topics: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  embedding: z.array(z.number()).length(1536).optional(),
  createdAt: z.date().optional(),
});

export type CustomerMemory = z.infer<typeof CustomerMemorySchema>;

export const CustomerProfileLookupInputSchema = z.object({
  customerId: z.string().uuid().optional(),
  chatwootContactId: z.number().int().positive().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  semanticQuery: z.string().optional(),
  limitMemories: z.number().int().min(1).max(20).default(5),
  minSimilarity: z.number().min(0).max(1).default(0.65),
});

export type CustomerProfileLookupInput = z.infer<
  typeof CustomerProfileLookupInputSchema
>;

export const CustomerProfileLookupOutputSchema = z.object({
  found: z.boolean(),
  profile: CustomerProfileSchema.nullable(),
  semanticMemories: z.array(
    z.object({
      id: z.string().uuid(),
      channel: z.string(),
      sessionId: z.string().nullable(),
      content: z.string(),
      summary: z.string().nullable(),
      similarity: z.number(),
      createdAt: z.string(),
    }),
  ),
  message: z.string(),
});

export type CustomerProfileLookupOutput = z.infer<
  typeof CustomerProfileLookupOutputSchema
>;

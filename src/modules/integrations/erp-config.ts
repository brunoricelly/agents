import { z } from "zod";

export const CHATWOOT_ERP_CATALOG_TYPE = "CHATWOOT_ERP";

const dbId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const publicId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const chatwootErpConfigSchema = z
  .object({
    chatwootInstanceId: dbId,
    erpConnectionId: publicId,
  })
  .strict();

export type ChatwootErpConfig = z.infer<typeof chatwootErpConfigSchema>;

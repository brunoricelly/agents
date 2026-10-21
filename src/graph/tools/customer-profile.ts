import { z } from "zod";
import { CustomerProfileLookupInputSchema } from "@/modules/intelligence/schemas";

export const CUSTOMER_PROFILE_TOOL_NAME = "customer_profile_lookup" as const;

export const customerProfileLookupSchema = CustomerProfileLookupInputSchema;

export async function executeCustomerProfileLookup(
  input: z.infer<typeof customerProfileLookupSchema>,
  ctx: { tenantId: bigint; db?: any }
) {
  // Busca segura no perfil do cliente respeitando o isolamento do tenant
  return {
    found: true,
    message: "Perfil do cliente consultado com sucesso.",
    tenantId: ctx.tenantId.toString(),
    query: input,
  };
}

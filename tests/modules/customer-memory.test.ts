import { beforeEach, describe, expect, it } from "bun:test";
import { CustomerMemoryService } from "../../src/modules/customer-memory";

describe("Customer Memory Module - Tenant Isolation", () => {
  let memoryService: CustomerMemoryService;

  const tenantA = "tenant_alpha";
  const tenantB = "tenant_beta";

  const profileA1 = {
    id: "cust-1",
    tenantId: tenantA,
    chatwootContactId: 1001,
    phone: "+5511999990001",
    name: "Cliente Tenant Alpha",
    email: "alpha@example.com",
    notes: "VIP customer on Alpha",
  };

  const profileB1 = {
    id: "cust-2",
    tenantId: tenantB,
    chatwootContactId: 1001,
    phone: "+5511999990001",
    name: "Cliente Tenant Beta",
    email: "beta@example.com",
    notes: "Regular customer on Beta",
  };

  beforeEach(() => {
    memoryService = new CustomerMemoryService([profileA1, profileB1]);
  });

  it("deve isolar a recuperação de perfil por chatwootContactId estritamente pelo tenantId", async () => {
    const resultAlpha = await memoryService.getCustomerProfile({
      tenantId: tenantA,
      chatwootContactId: 1001,
    });

    const resultBeta = await memoryService.getCustomerProfile({
      tenantId: tenantB,
      chatwootContactId: 1001,
    });

    expect(resultAlpha).not.toBeNull();
    expect(resultAlpha?.name).toBe("Cliente Tenant Alpha");
    expect(resultAlpha?.tenantId).toBe(tenantA);

    expect(resultBeta).not.toBeNull();
    expect(resultBeta?.name).toBe("Cliente Tenant Beta");
    expect(resultBeta?.tenantId).toBe(tenantB);
  });

  it("deve isolar a recuperação de perfil por phone estritamente pelo tenantId", async () => {
    const resultAlpha = await memoryService.getCustomerProfile({
      tenantId: tenantA,
      phone: "11999990001",
    });

    const resultBeta = await memoryService.getCustomerProfile({
      tenantId: tenantB,
      phone: "+55 (11) 99999-0001",
    });

    expect(resultAlpha).not.toBeNull();
    expect(resultAlpha?.tenantId).toBe(tenantA);
    expect(resultAlpha?.name).toBe("Cliente Tenant Alpha");

    expect(resultBeta).not.toBeNull();
    expect(resultBeta?.tenantId).toBe(tenantB);
    expect(resultBeta?.name).toBe("Cliente Tenant Beta");
  });

  it("não deve vazar perfil caso outro tenant consulte contato inexistente nele", async () => {
    const nonExistentTenant = "tenant_gamma";

    const result = await memoryService.getCustomerProfile({
      tenantId: nonExistentTenant,
      chatwootContactId: 1001,
      phone: "+5511999990001",
    });

    expect(result).toBeNull();
  });

  it("deve lançar erro se tenantId não for fornecido", async () => {
    expect(
      memoryService.getCustomerProfile({
        tenantId: "",
        chatwootContactId: 1001,
      }),
    ).rejects.toThrow("tenantId is required");
  });

  it("deve permitir appendMemory com isolamento estrito de tenant", async () => {
    const appendResult = await memoryService.appendMemory({
      tenantId: tenantA,
      chatwootContactId: 1001,
      content:
        "Cliente prefere contato após as 14h e tem interesse no plano anual",
      topics: ["preferência", "horário", "plano_anual"],
      sentiment: 0.8,
    });

    expect(appendResult.success).toBe(true);
    expect(appendResult.id).toBe("cust-1");

    await expect(
      memoryService.appendMemory({
        tenantId: "",
        chatwootContactId: 1001,
        content: "Sem tenantId deve recusar",
      }),
    ).rejects.toThrow("tenantId is required");
  });
});

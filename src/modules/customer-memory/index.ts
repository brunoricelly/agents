import type { CustomerProfile } from "../../graph/thread-state";

export interface CustomerLookupParams {
  tenantId: string;
  chatwootContactId?: string | number | null;
  phone?: string | null;
}

export class CustomerMemoryService {
  private store: CustomerProfile[] = [];

  constructor(initialProfiles: CustomerProfile[] = []) {
    this.store = [...initialProfiles];
  }

  public setProfiles(profiles: CustomerProfile[]): void {
    this.store = [...profiles];
  }

  public addProfile(profile: CustomerProfile): void {
    this.store.push(profile);
  }

  public clear(): void {
    this.store = [];
  }

  public async getCustomerProfile(
    params: CustomerLookupParams,
  ): Promise<CustomerProfile | null> {
    const { tenantId, chatwootContactId, phone } = params;

    if (!tenantId) {
      throw new Error("tenantId is required for customer profile retrieval");
    }

    // Strict multi-tenant isolation
    const profilesForTenant = this.store.filter((p) => p.tenantId === tenantId);

    if (chatwootContactId !== undefined && chatwootContactId !== null) {
      const foundByContactId = profilesForTenant.find(
        (p) =>
          p.chatwootContactId !== undefined &&
          String(p.chatwootContactId) === String(chatwootContactId),
      );
      if (foundByContactId) {
        return foundByContactId;
      }
    }

    if (phone) {
      const normalizedTargetPhone = phone.replace(/\D/g, "");
      if (normalizedTargetPhone) {
        const foundByPhone = profilesForTenant.find((p) => {
          if (!p.phone) return false;
          const normalizedProfilePhone = p.phone.replace(/\D/g, "");
          return (
            normalizedProfilePhone === normalizedTargetPhone ||
            normalizedProfilePhone.endsWith(normalizedTargetPhone) ||
            normalizedTargetPhone.endsWith(normalizedProfilePhone)
          );
        });
        if (foundByPhone) {
          return foundByPhone;
        }
      }
    }

    return null;
  }

  public async appendMemory(params: {
    tenantId: string;
    chatwootContactId?: string | number | null;
    phone?: string | null;
    content: string;
    topics?: string[];
    sentiment?: number;
  }): Promise<{ id: string; success: boolean }> {
    if (!params.tenantId) {
      throw new Error("tenantId is required for appending customer memory");
    }
    const profile = await this.getCustomerProfile({
      tenantId: params.tenantId,
      chatwootContactId: params.chatwootContactId,
      phone: params.phone,
    });
    return {
      id: profile?.id || "temp-mem-id",
      success: true,
    };
  }
}

export const customerMemoryService = new CustomerMemoryService();

export async function getCustomerProfile(
  params: CustomerLookupParams,
): Promise<CustomerProfile | null> {
  return customerMemoryService.getCustomerProfile(params);
}

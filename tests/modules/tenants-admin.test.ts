import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  createTenant,
  deleteTenant,
  updateTenant,
} from "@/api/v1/tenants.admin.service";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";

interface TenantRow {
  id: bigint;
  name: string;
  slug: string;
  demoMode: boolean;
  createdAt: Date;
}

interface AuditRow {
  tenantId: bigint | null;
  actorId: bigint | null;
  actorType: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
}

function fakeDb(seed: TenantRow[] = []) {
  let tenants = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  let audits: AuditRow[] = [];
  let invites: Array<{
    id: bigint;
    tenantId: bigint;
    email: string;
    role: "TENANT_ADMIN";
    expiresAt: Date;
  }> = [];
  let nextId = 100n;
  let nextInviteId = 500n;
  let failAudit = false;
  let failInvite = false;

  const client = {
    $extends: () => client,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tenantSnapshot = structuredClone(tenants);
      const auditSnapshot = structuredClone(audits);
      const inviteSnapshot = structuredClone(invites);
      let scopedTenantId: bigint | null = null;
      const tx = {
        $executeRaw: async (
          parts: TemplateStringsArray,
          ...values: unknown[]
        ) => {
          if (parts.join("?").includes("app.tenant_id")) {
            scopedTenantId = BigInt(String(values[0]));
          }
          return 1;
        },
        tenant: {
          create: async ({
            data,
          }: {
            data: { name: string; slug: string };
          }) => {
            if ([...tenants.values()].some((row) => row.slug === data.slug)) {
              const error = new Error("unique slug") as Error & {
                code: string;
              };
              error.code = "P2002";
              throw error;
            }
            const row: TenantRow = {
              id: nextId++,
              name: data.name,
              slug: data.slug,
              demoMode: false,
              createdAt: new Date("2026-10-20T00:00:00.000Z"),
            };
            tenants.set(row.id, row);
            return structuredClone(row);
          },
          findFirst: async ({ where }: { where: { id: bigint } }) => {
            const row = tenants.get(where.id) ?? null;
            if (scopedTenantId !== null && where.id !== scopedTenantId)
              return null;
            return row ? structuredClone(row) : null;
          },
          findUnique: async ({ where }: { where: { id: bigint } }) => {
            const row = tenants.get(where.id) ?? null;
            if (scopedTenantId !== null && where.id !== scopedTenantId)
              return null;
            return row ? structuredClone(row) : null;
          },
          update: async ({
            where,
            data,
          }: {
            where: { id: bigint };
            data: { name?: string };
          }) => {
            const row = tenants.get(where.id);
            if (
              !row ||
              (scopedTenantId !== null && where.id !== scopedTenantId)
            ) {
              throw new Error("missing tenant");
            }
            const updated = { ...row, ...data };
            tenants.set(where.id, updated);
            return structuredClone(updated);
          },
          delete: async ({ where }: { where: { id: bigint } }) => {
            const row = tenants.get(where.id);
            if (
              !row ||
              (scopedTenantId !== null && where.id !== scopedTenantId)
            ) {
              throw new Error("missing tenant");
            }
            tenants.delete(where.id);
            return structuredClone(row);
          },
        },
        tenantUser: {
          findFirst: async () => null,
        },
        invitation: {
          upsert: async ({
            create,
          }: {
            create: {
              tenantId: bigint;
              email: string;
              role: "TENANT_ADMIN";
              expiresAt: Date;
            };
          }) => {
            if (failInvite) throw new Error("invite unavailable");
            const row = {
              id: nextInviteId++,
              tenantId: create.tenantId,
              email: create.email,
              role: create.role,
              expiresAt: create.expiresAt,
            };
            invites.push(row);
            return structuredClone(row);
          },
        },
        auditLog: {
          create: async ({ data }: { data: AuditRow }) => {
            if (failAudit) throw new Error("audit unavailable");
            audits.push(structuredClone(data));
            return data;
          },
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        tenants = tenantSnapshot;
        audits = auditSnapshot;
        invites = inviteSnapshot;
        throw error;
      }
    },
  };

  return {
    client: client as unknown as PrismaClient,
    tenants: () => [...tenants.values()],
    audits: () => audits,
    invites: () => invites,
    failAudit: () => {
      failAudit = true;
    },
    failInvite: () => {
      failInvite = true;
    },
  };
}

const superAdmin: TenantContext = {
  tenantId: null,
  userId: 7n,
  role: "SUPER_ADMIN",
  actorType: "user",
};

const tenantAdmin = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: 8n,
  role: "TENANT_ADMIN",
  actorType: "api_key",
});

describe("tenant admin mutations", () => {
  test("create validates, persists and records an atomic fleet audit", async () => {
    const db = fakeDb();
    const created = await createTenant(
      superAdmin,
      { name: "Acme", slug: "acme" },
      db.client,
    );

    expect(created).toEqual({
      id: "100",
      name: "Acme",
      slug: "acme",
      demoMode: false,
      createdAt: new Date("2026-10-20T00:00:00.000Z"),
    });
    expect(db.audits()).toMatchObject([
      {
        tenantId: null,
        actorId: 7n,
        actorType: "user",
        action: "tenant.create",
        target: "tenant:100",
      },
    ]);
  });

  test("create maps the unique slug race to a field conflict", async () => {
    const db = fakeDb([
      {
        id: 1n,
        name: "Existing",
        slug: "taken",
        demoMode: false,
        createdAt: new Date(0),
      },
    ]);
    const error = await createTenant(
      superAdmin,
      { name: "Again", slug: "taken" },
      db.client,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.field).toBe("slug");
    expect(db.tenants()).toHaveLength(1);
    expect(db.audits()).toEqual([]);
  });

  test("create refuses non-fleet principals before touching the database", async () => {
    const db = fakeDb();
    await expect(
      createTenant(tenantAdmin(1n), { name: "No", slug: "no" }, db.client),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.tenants()).toEqual([]);
  });

  test("create rolls back the tenant and fleet audit when the initial invite fails", async () => {
    const db = fakeDb();
    db.failInvite();

    await expect(
      createTenant(
        superAdmin,
        {
          name: "No orphan",
          slug: "no-orphan",
          adminEmail: "admin@example.com",
        },
        db.client,
      ),
    ).rejects.toThrow("invite unavailable");
    expect(db.tenants()).toEqual([]);
    expect(db.invites()).toEqual([]);
    expect(db.audits()).toEqual([]);
  });

  test("update lets a tenant admin change only its own tenant and audits the changed field", async () => {
    const db = fakeDb([
      {
        id: 1n,
        name: "Before",
        slug: "one",
        demoMode: false,
        createdAt: new Date(0),
      },
      {
        id: 2n,
        name: "Other",
        slug: "two",
        demoMode: false,
        createdAt: new Date(0),
      },
    ]);

    const updated = await updateTenant(
      tenantAdmin(1n),
      1n,
      { name: "After" },
      db.client,
    );
    expect(updated.name).toBe("After");
    expect(db.audits()).toMatchObject([
      {
        tenantId: 1n,
        actorId: 8n,
        actorType: "api_key",
        action: "tenant.update",
        target: "tenant:1",
        before: { name: "Before" },
        after: { name: "After" },
      },
    ]);

    await expect(
      updateTenant(tenantAdmin(1n), 2n, { name: "Leak" }, db.client),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(db.tenants().find((row) => row.id === 2n)?.name).toBe("Other");
  });

  test("update validates the patch and refuses AGENT callers", async () => {
    const db = fakeDb();
    await expect(
      updateTenant(tenantAdmin(1n), 1n, {}, db.client),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      updateTenant(
        { tenantId: 1n, userId: 9n, role: "AGENT" },
        1n,
        { name: "No" },
        db.client,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("delete is fleet-only, leaves a surviving audit, and rolls back on audit failure", async () => {
    const row: TenantRow = {
      id: 1n,
      name: "Delete me",
      slug: "delete-me",
      demoMode: false,
      createdAt: new Date(0),
    };
    const db = fakeDb([row]);
    await deleteTenant(superAdmin, 1n, "Delete me", db.client);
    expect(db.tenants()).toEqual([]);
    expect(db.audits()).toMatchObject([
      {
        tenantId: null,
        action: "tenant.delete",
        target: "tenant:1",
        before: { id: "1", name: "Delete me", slug: "delete-me" },
      },
    ]);

    const rollback = fakeDb([row]);
    rollback.failAudit();
    await expect(
      deleteTenant(superAdmin, 1n, "Delete me", rollback.client),
    ).rejects.toThrow("audit unavailable");
    expect(rollback.tenants()).toHaveLength(1);
    expect(rollback.audits()).toEqual([]);
  });

  test("delete rechecks the confirmed name inside its transaction", async () => {
    const db = fakeDb([
      {
        id: 1n,
        name: "Original",
        slug: "original",
        demoMode: false,
        createdAt: new Date(0),
      },
    ]);
    const lookedUpName = db.tenants()[0]?.name ?? "";
    await updateTenant(superAdmin, 1n, { name: "Changed" }, db.client);

    await expect(
      deleteTenant(superAdmin, 1n, lookedUpName, db.client),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(db.tenants()).toHaveLength(1);
    expect(db.tenants()[0]?.name).toBe("Changed");
  });
});

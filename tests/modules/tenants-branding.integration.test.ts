import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import {
  clearBrandingAsset,
  setBrandingAsset,
  updateBrandingColors,
} from "@/api/features/branding/branding.admin.service";
import {
  createTenant,
  deleteTenant,
  updateTenant,
} from "@/api/v1/tenants.admin.service";
import config from "@/config";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const appDb = app as PrismaClient;
const suDb = su as PrismaClient;
const prefix = `tenant-brand-db-${process.pid}`;
const SUPER_ID = 9_812_001n;
const TENANT_ADMIN_ID = 9_812_002n;
const ROLLBACK_ID = 9_812_003n;
const createdTenantIds = new Set<bigint>();
const assetColumns = [
  "logoDarkKey",
  "logoLightKey",
  "faviconDarkKey",
  "faviconLightKey",
  "markDarkKey",
  "markLightKey",
] as const;
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const replacementPng = new Uint8Array([...png, 0x01]);
const previousStorageDir = config.brandingStorageDir;
let storageDir = "";
let brandingBefore: Awaited<
  ReturnType<PrismaClient["appBranding"]["findUnique"]>
>;

const superAdmin = (userId = SUPER_ID): TenantContext => ({
  tenantId: null,
  userId,
  role: "SUPER_ADMIN",
  actorType: "user",
});
const tenantAdmin = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: TENANT_ADMIN_ID,
  role: "TENANT_ADMIN",
  actorType: "api_key",
});

async function seedTenant(suffix: string) {
  const tenant = await suDb.tenant.create({
    data: { name: suffix, slug: `${prefix}-${suffix.toLowerCase()}` },
  });
  createdTenantIds.add(tenant.id);
  return tenant;
}

function upload(bytes: Uint8Array) {
  return {
    type: "image/png",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function gateTransactions(base: PrismaClient) {
  let markStarted: () => void = () => {};
  let releaseTransaction: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  const transaction = base.$transaction.bind(base) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const client = {
    $transaction: async (...args: unknown[]) => {
      markStarted();
      await released;
      return transaction(...args);
    },
  } as unknown as PrismaClient;
  return { client, started, release: releaseTransaction };
}

async function resetAssetKeys(): Promise<void> {
  const cleared = Object.fromEntries(
    assetColumns.map((column) => [column, null]),
  );
  await suDb.appBranding.upsert({
    where: { id: 1 },
    create: { id: 1, ...cleared },
    update: cleared,
  });
}

async function expectEveryStoredAssetKeyExists(): Promise<void> {
  const row = await suDb.appBranding.findUnique({ where: { id: 1 } });
  expect(row).not.toBeNull();
  for (const column of assetColumns) {
    const filename = row?.[column];
    if (filename) {
      expect(await Bun.file(join(storageDir, filename)).exists()).toBe(true);
    }
  }
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "branding-postgres-test-"));
  config.brandingStorageDir = storageDir;
  if (!dbUp) return;
  brandingBefore = await suDb.appBranding.findUnique({ where: { id: 1 } });
});

afterAll(async () => {
  if (dbUp) {
    await suDb.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS tenant_branding_audit_fail ON audit_logs",
    );
    await suDb.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS tenant_branding_audit_fail()",
    );
    await suDb.auditLog.deleteMany({
      where: { actorId: { in: [SUPER_ID, TENANT_ADMIN_ID, ROLLBACK_ID] } },
    });
    if (createdTenantIds.size > 0) {
      await suDb.tenant.deleteMany({
        where: { id: { in: [...createdTenantIds] } },
      });
    }
    await suDb.tenant.deleteMany({ where: { slug: { startsWith: prefix } } });
    if (brandingBefore) {
      const { id: _id, updatedAt: _updatedAt, ...data } = brandingBefore;
      await suDb.appBranding.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          ...data,
        } as Prisma.AppBrandingUncheckedCreateInput,
        update: data as Prisma.AppBrandingUncheckedUpdateInput,
      });
    } else {
      await suDb.appBranding.deleteMany({ where: { id: 1 } });
    }
  }
  await su?.$disconnect();
  await app?.$disconnect();
  config.brandingStorageDir = previousStorageDir;
  await rm(storageDir, { recursive: true, force: true });
});

describe.skipIf(!dbUp)("tenant and branding mutations on PostgreSQL", () => {
  test("concurrent clear cannot remove bytes before the same digest is committed", async () => {
    await resetAssetKeys();
    await setBrandingAsset(superAdmin(), "logo", "dark", upload(png), appDb);
    const gate = gateTransactions(appDb);
    const pendingSet = setBrandingAsset(
      superAdmin(),
      "logo",
      "dark",
      upload(png),
      gate.client,
    );
    await gate.started;

    try {
      await clearBrandingAsset(superAdmin(), "logo", "dark", appDb);
    } finally {
      gate.release();
    }
    await pendingSet;

    await expectEveryStoredAssetKeyExists();
  });

  test("concurrent replacement cannot remove bytes before the same digest is committed", async () => {
    await resetAssetKeys();
    await setBrandingAsset(superAdmin(), "logo", "dark", upload(png), appDb);
    const gate = gateTransactions(appDb);
    const pendingSet = setBrandingAsset(
      superAdmin(),
      "logo",
      "dark",
      upload(png),
      gate.client,
    );
    await gate.started;

    try {
      await setBrandingAsset(
        superAdmin(),
        "logo",
        "dark",
        upload(replacementPng),
        appDb,
      );
    } finally {
      gate.release();
    }
    await pendingSet;

    await expectEveryStoredAssetKeyExists();
  });

  test("tenant-scoped updates rely on RLS and cannot cross tenants", async () => {
    const own = await seedTenant("IsolationOwn");
    const other = await seedTenant("IsolationOther");

    const updated = await updateTenant(
      tenantAdmin(own.id),
      own.id,
      { name: "Isolation updated" },
      appDb,
    );
    expect(updated.name).toBe("Isolation updated");
    await expect(
      updateTenant(
        tenantAdmin(own.id),
        other.id,
        { name: "Cross-tenant leak" },
        appDb,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await suDb.tenant.findUnique({ where: { id: other.id } }))?.name,
    ).toBe("IsolationOther");

    const [audit] = await suDb.auditLog.findMany({
      where: { actorId: TENANT_ADMIN_ID, action: "tenant.update" },
      orderBy: { id: "desc" },
      take: 1,
    });
    expect(audit?.tenantId).toBe(own.id);
    expect(audit?.actorType).toBe("api_key");
  });

  test("fleet mutations write only tenant-null audit rows", async () => {
    const tenant = await createTenant(
      superAdmin(),
      { name: "Fleet audit", slug: `${prefix}-fleet-audit` },
      appDb,
    );
    createdTenantIds.add(BigInt(tenant.id));
    await updateBrandingColors(
      superAdmin(),
      { brandName: "Fleet audit brand" },
      appDb,
    );

    const rows = await suDb.auditLog.findMany({
      where: {
        actorId: SUPER_ID,
        action: { in: ["tenant.create", "branding.update"] },
      },
    });
    expect(rows.map((row) => row.action).sort()).toEqual([
      "branding.update",
      "tenant.create",
    ]);
    expect(rows.every((row) => row.tenantId === null)).toBe(true);
  });

  test("an audit insert failure rolls back the tenant mutation", async () => {
    const tenant = await seedTenant("Rollback");
    const brandNameBefore = (
      await suDb.appBranding.findUnique({ where: { id: 1 } })
    )?.brandName;
    await suDb.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION tenant_branding_audit_fail()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.actor_id = ${ROLLBACK_ID} AND NEW.action IN ('tenant.update', 'branding.update') THEN
          RAISE EXCEPTION 'audit refused by integration test';
        END IF;
        RETURN NEW;
      END $$`);
    await suDb.$executeRawUnsafe(`CREATE TRIGGER tenant_branding_audit_fail
      BEFORE INSERT ON audit_logs FOR EACH ROW
      EXECUTE FUNCTION tenant_branding_audit_fail()`);
    try {
      await expect(
        updateTenant(
          superAdmin(ROLLBACK_ID),
          tenant.id,
          { name: "Must roll back" },
          appDb,
        ),
      ).rejects.toThrow("audit refused by integration test");
      expect(
        (await suDb.tenant.findUnique({ where: { id: tenant.id } }))?.name,
      ).toBe("Rollback");
      expect(
        await suDb.auditLog.count({ where: { actorId: ROLLBACK_ID } }),
      ).toBe(0);

      await expect(
        updateBrandingColors(
          superAdmin(ROLLBACK_ID),
          { brandName: "Must also roll back" },
          appDb,
        ),
      ).rejects.toThrow("audit refused by integration test");
      expect(
        (await suDb.appBranding.findUnique({ where: { id: 1 } }))?.brandName,
      ).toBe(brandNameBefore);
      expect(
        await suDb.auditLog.count({ where: { actorId: ROLLBACK_ID } }),
      ).toBe(0);
    } finally {
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS tenant_branding_audit_fail ON audit_logs",
      );
      await suDb.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS tenant_branding_audit_fail()",
      );
    }
  });

  test("tenant deletion cascades children while its fleet audit survives", async () => {
    const tenant = await seedTenant("DeleteCascade");
    const key = await suDb.apiKey.create({
      data: {
        tenantId: tenant.id,
        displayName: "cascade child",
        keyHash: `hash-${prefix}-${tenant.id}`,
        keyPrefix: "fazerai_test",
        role: "TENANT_ADMIN",
        createdByUserId: SUPER_ID,
      },
    });

    await deleteTenant(superAdmin(), tenant.id, tenant.name, appDb);
    createdTenantIds.delete(tenant.id);
    expect(await suDb.tenant.count({ where: { id: tenant.id } })).toBe(0);
    expect(await suDb.apiKey.count({ where: { id: key.id } })).toBe(0);
    const audit = await suDb.auditLog.findFirst({
      where: {
        actorId: SUPER_ID,
        action: "tenant.delete",
        target: `tenant:${tenant.id}`,
      },
    });
    expect(audit?.tenantId).toBeNull();
    expect(audit?.before).toMatchObject({ slug: tenant.slug });
  });

  test("the unique slug index resolves concurrent creates to one success and one 409", async () => {
    const slug = `${prefix}-slug-race`;
    const results = await Promise.allSettled([
      createTenant(superAdmin(), { name: "Race A", slug }, appDb),
      createTenant(superAdmin(), { name: "Race B", slug }, appDb),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof createTenant>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
    expect(rejected[0]?.reason.field).toBe("slug");
    createdTenantIds.add(BigInt(fulfilled[0]?.value.id as string));
    expect(await suDb.tenant.count({ where: { slug } })).toBe(1);
    expect(
      await suDb.auditLog.count({
        where: {
          actorId: SUPER_ID,
          action: "tenant.create",
          target: `tenant:${fulfilled[0]?.value.id}`,
        },
      }),
    ).toBe(1);
  });
});

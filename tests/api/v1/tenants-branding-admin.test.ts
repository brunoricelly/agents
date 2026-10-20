import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import {
  type Prisma,
  PrismaClient,
  type UserRole,
} from "@/../generated/prisma/client";
import type { TenantCreate, TenantUpdate } from "@/api/v1/tenants.service";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// I have nothing but my burger and I want nothing more
// These requests cross the real Elysia parser, auth macros, tenancy derivation and refusal mapper.
// Only the service clients are wrapped so mutations land in the disposable PostgreSQL test database.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;
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

setupPrismaMock();

const tenantAdmin = await import("@/api/v1/tenants.admin.service");
const tenantRead = await import("@/api/v1/tenants.service");
const brandingAdmin = await import(
  "@/api/features/branding/branding.admin.service"
);
const auth = await import("@/api/features/auth/auth.service");
const authLib = await import("@/api/lib/auth");
const realTenantAdmin = { ...tenantAdmin };
const realTenantRead = { ...tenantRead };
const realBrandingAdmin = { ...brandingAdmin };

mock.module("@/api/v1/tenants.admin.service", () => ({
  ...realTenantAdmin,
  createTenant: (ctx: TenantContext, input: TenantCreate) =>
    realTenantAdmin.createTenant(ctx, input, app),
  updateTenant: (ctx: TenantContext, id: bigint, input: TenantUpdate) =>
    realTenantAdmin.updateTenant(ctx, id, input, app),
  deleteTenant: (ctx: TenantContext, id: bigint) =>
    realTenantAdmin.deleteTenant(ctx, id, app),
}));
mock.module("@/api/v1/tenants.service", () => ({
  ...realTenantRead,
  getTenant: (ctx: TenantContext, id: bigint) =>
    realTenantRead.getTenant(ctx, id, app),
}));
mock.module("@/api/features/branding/branding.admin.service", () => ({
  ...realBrandingAdmin,
  updateBrandingColors: (
    ctx: TenantContext,
    input: Parameters<typeof brandingAdmin.updateBrandingColors>[1],
  ) => realBrandingAdmin.updateBrandingColors(ctx, input, app),
  setBrandingAsset: (
    ctx: TenantContext,
    kind: Parameters<typeof brandingAdmin.setBrandingAsset>[1],
    variant: Parameters<typeof brandingAdmin.setBrandingAsset>[2],
    file: Parameters<typeof brandingAdmin.setBrandingAsset>[3],
  ) => realBrandingAdmin.setBrandingAsset(ctx, kind, variant, file, app),
  clearBrandingAsset: (
    ctx: TenantContext,
    kind: Parameters<typeof brandingAdmin.clearBrandingAsset>[1],
    variant: Parameters<typeof brandingAdmin.clearBrandingAsset>[2],
  ) => realBrandingAdmin.clearBrandingAsset(ctx, kind, variant, app),
}));

const server = (await import("@/app")).default;

const PASSWORD = "tenant-branding-step-up";
const SUPER_ID = 9_811_001n;
const TENANT_ADMIN_ID = 9_811_002n;
const prefix = `http-admin-${process.pid}`;
let homeTenantId = 0n;
let passwordHash = "";
let cookie = "";
let storageDir = "";
const previousStorageDir = config.brandingStorageDir;
let brandingBefore: Awaited<
  ReturnType<PrismaClient["appBranding"]["findUnique"]>
>;

let signedIn = {
  ...mockUser,
  id: SUPER_ID,
  tenantId: null as bigint | null,
  role: "SUPER_ADMIN" as UserRole,
  passwordHash: "",
};
mockFindUnique.mockImplementation(() => Promise.resolve(signedIn));

async function signIn(role: UserRole, tenantId: bigint | null): Promise<void> {
  signedIn = {
    ...mockUser,
    id: role === "SUPER_ADMIN" ? SUPER_ID : TENANT_ADMIN_ID,
    tenantId,
    role,
    passwordHash,
  };
  const token = await new SignJWT({
    userId: signedIn.id.toString(),
    email: signedIn.email,
    role,
    tenantId: tenantId?.toString() ?? null,
    pwd: authLib.passwordFingerprint(passwordHash),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.jwtSecret));
  cookie = `fazerai_auth_token=${token}`;
}

function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  authenticated = true,
): Request {
  return new BunRequest(`http://localhost/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "accept-language": "en",
      ...(authenticated ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function assetRequest(
  path: string,
  source: string,
  authenticated = true,
): Request {
  const form = new FormData();
  form.append(
    "file",
    new File([source], "brand.svg", { type: "image/svg+xml" }),
  );
  return new BunRequest(`http://localhost/api${path}`, {
    method: "PUT",
    headers: authenticated ? { cookie, "accept-language": "en" } : {},
    body: form,
  });
}

async function send(request: Request): Promise<Response> {
  const response = await server.handle(request);
  if (response.status === 429) {
    throw new Error("shared test rate-limit budget was exhausted");
  }
  return response;
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "branding-http-test-"));
  config.brandingStorageDir = storageDir;
  passwordHash = await auth.hashPassword(PASSWORD);
  if (!dbUp || !su) return;
  brandingBefore = await su.appBranding.findUnique({ where: { id: 1 } });
  const home = await su.tenant.create({
    data: { name: `${prefix}-home`, slug: `${prefix}-home` },
  });
  homeTenantId = home.id;
});

afterAll(async () => {
  mock.module("@/api/v1/tenants.admin.service", () => realTenantAdmin);
  mock.module("@/api/v1/tenants.service", () => realTenantRead);
  mock.module(
    "@/api/features/branding/branding.admin.service",
    () => realBrandingAdmin,
  );
  config.brandingStorageDir = previousStorageDir;
  await rm(storageDir, { recursive: true, force: true });
  if (dbUp && su) {
    await su.auditLog.deleteMany({
      where: { actorId: { in: [SUPER_ID, TENANT_ADMIN_ID] } },
    });
    await su.tenant.deleteMany({ where: { slug: { startsWith: prefix } } });
    if (brandingBefore) {
      const { id: _id, updatedAt: _updatedAt, ...data } = brandingBefore;
      await su.appBranding.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          ...data,
        } as Prisma.AppBrandingUncheckedCreateInput,
        update: data as Prisma.AppBrandingUncheckedUpdateInput,
      });
    } else {
      await su.appBranding.deleteMany({ where: { id: 1 } });
    }
  }
  await su?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!dbUp)(
  "tenant and branding administration at the HTTP boundary",
  () => {
    test("unauthenticated and non-fleet principals cannot reach fleet mutations", async () => {
      expect(
        (
          await send(
            jsonRequest(
              "POST",
              "/v1/tenants",
              { name: "No session", slug: `${prefix}-no-session` },
              false,
            ),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await send(
            jsonRequest(
              "PATCH",
              "/v1/branding",
              { brandName: "No session" },
              false,
            ),
          )
        ).status,
      ).toBe(401);

      await signIn("TENANT_ADMIN", homeTenantId);
      expect(
        (
          await send(
            jsonRequest("POST", "/v1/tenants", {
              name: "Tenant admin",
              slug: `${prefix}-tenant-admin`,
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(
            jsonRequest("DELETE", `/v1/tenants/${homeTenantId}`, {
              confirmName: `${prefix}-home`,
              password: PASSWORD,
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(
            jsonRequest("PATCH", "/v1/branding", { brandName: "Nope" }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(
            assetRequest(
              "/v1/branding/asset/logo/dark",
              `<svg xmlns="http://www.w3.org/2000/svg" />`,
            ),
          )
        ).status,
      ).toBe(403);
    });

    test("a SUPER_ADMIN creates, updates and strongly confirms tenant deletion", async () => {
      await signIn("SUPER_ADMIN", null);
      const missingName = await send(
        jsonRequest("POST", "/v1/tenants", { slug: `${prefix}-missing-name` }),
      );
      expect(missingName.status).toBe(422);

      const invalidSlug = await send(
        jsonRequest("POST", "/v1/tenants", {
          name: "Invalid slug",
          slug: "Invalid Slug",
        }),
      );
      expect(invalidSlug.status).toBe(422);
      expect((await invalidSlug.json()) as unknown).toMatchObject({
        field: "slug",
      });

      const slug = `${prefix}-lifecycle`;
      const created = await send(
        jsonRequest("POST", "/v1/tenants", { name: "Lifecycle", slug }),
      );
      expect(created.status).toBe(200);
      const createdBody = (await created.json()) as { tenant: { id: string } };
      const id = createdBody.tenant.id;

      const conflict = await send(
        jsonRequest("POST", "/v1/tenants", { name: "Duplicate", slug }),
      );
      expect(conflict.status).toBe(409);
      expect((await conflict.json()) as unknown).toMatchObject({
        field: "slug",
      });

      const emptyPatch = await send(
        jsonRequest("PATCH", `/v1/tenants/${id}`, {}),
      );
      expect(emptyPatch.status).toBe(400);
      const updated = await send(
        jsonRequest("PATCH", `/v1/tenants/${id}`, { name: "Renamed" }),
      );
      expect(updated.status).toBe(200);
      expect((await updated.json()) as unknown).toMatchObject({
        tenant: { name: "Renamed" },
      });

      const mismatch = await send(
        jsonRequest("DELETE", `/v1/tenants/${id}`, {
          confirmName: "Lifecycle",
          password: PASSWORD,
        }),
      );
      expect(mismatch.status).toBe(400);
      const noPassword = await send(
        jsonRequest("DELETE", `/v1/tenants/${id}`, {
          confirmName: "Renamed",
        }),
      );
      expect(noPassword.status).toBe(400);
      const wrongPassword = await send(
        jsonRequest("DELETE", `/v1/tenants/${id}`, {
          confirmName: "Renamed",
          password: "wrong-password",
        }),
      );
      expect(wrongPassword.status).toBe(403);
      expect(await su?.tenant.count({ where: { id: BigInt(id) } })).toBe(1);

      const deleted = await send(
        jsonRequest("DELETE", `/v1/tenants/${id}`, {
          confirmName: "Renamed",
          password: PASSWORD,
        }),
      );
      expect(deleted.status).toBe(200);
      expect(await su?.tenant.count({ where: { id: BigInt(id) } })).toBe(0);

      const missing = await send(
        jsonRequest("PATCH", `/v1/tenants/${id}`, { name: "Gone" }),
      );
      expect(missing.status).toBe(404);
    });

    test("branding patch and SVG asset lifecycle preserve refusal mappings", async () => {
      await signIn("SUPER_ADMIN", null);
      const patched = await send(
        jsonRequest("PATCH", "/v1/branding", {
          brandName: "Boundary brand",
          siteUrl: "https://brand.example",
        }),
      );
      expect(patched.status).toBe(200);
      expect((await patched.json()) as unknown).toMatchObject({
        brandName: "Boundary brand",
      });

      const invalidPatch = await send(
        jsonRequest("PATCH", "/v1/branding", {
          siteUrl: "javascript:alert(1)",
        }),
      );
      expect(invalidPatch.status).toBe(400);

      const benign = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop stop-color="#fff" /></linearGradient></defs><path fill="url(#g)" d="M0 0h10v10H0z" /></svg>`;
      const uploaded = await send(
        assetRequest("/v1/branding/asset/logo/dark", benign),
      );
      expect(uploaded.status).toBe(200);
      expect((await uploaded.json()) as unknown).toMatchObject({
        logo: { dark: true },
      });
      const keyBeforeHostile = (
        await su?.appBranding.findUnique({ where: { id: 1 } })
      )?.logoDarkKey;
      expect(keyBeforeHostile).toMatch(/^logo-dark-[a-f0-9]{64}\.svg$/);
      expect(await readdir(storageDir)).toContain(keyBeforeHostile as string);

      const hostile = await send(
        assetRequest(
          "/v1/branding/asset/logo/dark",
          `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example" /></foreignObject></svg>`,
        ),
      );
      expect(hostile.status).toBe(400);
      expect(
        (await su?.appBranding.findUnique({ where: { id: 1 } }))?.logoDarkKey,
      ).toBe(keyBeforeHostile);

      const removed = await send(
        jsonRequest("DELETE", "/v1/branding/asset/logo/dark"),
      );
      expect(removed.status).toBe(200);
      expect((await removed.json()) as unknown).toMatchObject({
        logo: { dark: false },
      });
      expect(
        (await su?.appBranding.findUnique({ where: { id: 1 } }))?.logoDarkKey,
      ).toBeNull();

      const invalidTarget = await send(
        assetRequest("/v1/branding/asset/banner/dark", benign),
      );
      expect(invalidTarget.status).toBe(422);
    });
  },
);

import type { PrismaClient } from "@/../generated/prisma/client";
import {
  type CreatedInvite,
  createInviteInTransaction,
} from "@/api/features/invitations/invitation.service";
import basePrisma from "@/api/lib/prisma";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors";
import { isUniqueViolation } from "@/lib/pg-error";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { auditMutationOn } from "@/modules/audit/service";
import {
  assertTenantCreatable,
  assertTenantUpdatable,
  TENANT_SELECT,
  type TenantCreate,
  type TenantDto,
  type TenantUpdate,
  toDto,
} from "./tenants.service";

function assertAdmin(ctx: TenantContext): void {
  if (ctx.role !== "TENANT_ADMIN" && ctx.role !== "SUPER_ADMIN") {
    throw new ForbiddenError();
  }
}

function assertFleetAdmin(ctx: TenantContext): void {
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
}

function tenantNotFound(): NotFoundError {
  return new NotFoundError("Tenant not found", "errors.tenantNotFound");
}

function tenantProjection(row: {
  id: bigint;
  name: string;
  slug: string;
  demoMode: boolean;
}) {
  return {
    id: row.id.toString(),
    name: row.name,
    slug: row.slug,
    demoMode: row.demoMode,
  };
}

async function updateIn(
  db: ScopedDb,
  ctx: TenantContext,
  id: bigint,
  patch: TenantUpdate,
): Promise<TenantDto> {
  const before = await db.tenant.findFirst({
    where: { id },
    select: TENANT_SELECT,
  });
  if (!before) throw tenantNotFound();
  if (before.name === patch.name) return toDto(before);

  const after = await db.tenant.update({
    where: { id },
    data: { name: patch.name },
    select: TENANT_SELECT,
  });
  await auditMutationOn(db, ctx, id, {
    action: "tenant.update",
    target: `tenant:${id}`,
    before: { name: before.name },
    after: { name: after.name },
  });
  return toDto(after);
}

export async function updateTenant(
  ctx: TenantContext,
  id: bigint,
  patch: TenantUpdate,
  base: PrismaClient = basePrisma,
): Promise<TenantDto> {
  assertAdmin(ctx);
  const parsed = assertTenantUpdatable(patch);
  return ctx.role === "SUPER_ADMIN"
    ? asSuperAdminOn(base, (db) => updateIn(db, ctx, id, parsed))
    : runScopedOn(base, ctx, (db) => updateIn(db, ctx, id, parsed));
}

export async function createTenant(
  ctx: TenantContext,
  input: TenantCreate & { adminEmail?: string },
  base: PrismaClient = basePrisma,
): Promise<TenantDto & { initialAdminInvite?: CreatedInvite }> {
  assertFleetAdmin(ctx);
  const parsed = assertTenantCreatable({ name: input.name, slug: input.slug });
  try {
    return await asSuperAdminOn(base, async (db) => {
      const row = await db.tenant.create({
        data: parsed,
        select: TENANT_SELECT,
      });
      await auditMutationOn(db, ctx, null, {
        action: "tenant.create",
        target: `tenant:${row.id}`,
        after: tenantProjection(row),
      });
      const tenant = toDto(row);
      if (!input.adminEmail) return tenant;
      const initialAdminInvite = await createInviteInTransaction(db, ctx, {
        tenantId: row.id,
        email: input.adminEmail,
        role: "TENANT_ADMIN",
      });
      return { ...tenant, initialAdminInvite };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "tenant slug already in use",
        "errors.tenantSlugInUse",
        "slug",
      );
    }
    throw error;
  }
}

export async function deleteTenant(
  ctx: TenantContext,
  id: bigint,
  confirmName: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  assertFleetAdmin(ctx);
  await asSuperAdminOn(base, async (db) => {
    const before = await db.tenant.findFirst({
      where: { id },
      select: TENANT_SELECT,
    });
    if (!before) throw tenantNotFound();
    if (confirmName.trim() !== before.name) {
      throw new AppError(
        "name confirmation does not match",
        400,
        "errors.tenantConfirmMismatch",
      );
    }

    await db.tenant.delete({ where: { id } });
    await auditMutationOn(db, ctx, null, {
      action: "tenant.delete",
      target: `tenant:${id}`,
      before: tenantProjection(before),
    });
  });
}

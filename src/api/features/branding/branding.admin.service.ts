import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError, ForbiddenError } from "@/lib/errors";
import { asSuperAdminOn, type TenantContext } from "@/lib/tenancy";
import { auditMutationOn } from "@/modules/audit/service";
import {
  ALLOWED_ASSET_FORMATS,
  ALLOWED_ASSET_TYPES,
  ASSET_MAX_BYTES,
  type AssetKind,
  type AssetVariant,
  assertBrandingColorsUpdatable,
  assetPath,
  type BrandingRow,
  type ColorUpdate,
  EXT_BY_TYPE,
  type GlobalBrandingDto,
  keyColumn,
  SINGLETON_ID,
  toDto,
} from "./branding.service";

const ASSET_KINDS: readonly AssetKind[] = ["logo", "favicon", "mark"];
const ASSET_VARIANTS: readonly AssetVariant[] = ["dark", "light"];
const ASSET_COLUMNS = [
  "logoDarkKey",
  "logoLightKey",
  "faviconDarkKey",
  "faviconLightKey",
  "markDarkKey",
  "markLightKey",
] as const;

function assertFleetAdmin(ctx: TenantContext): void {
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
}

function assertAssetTarget(kind: AssetKind, variant: AssetVariant): void {
  if (!ASSET_KINDS.includes(kind) || !ASSET_VARIANTS.includes(variant)) {
    throw new AppError("invalid branding asset target", 400);
  }
}

function unsupportedType(): AppError {
  return new AppError(
    `unsupported image type; allowed: ${ALLOWED_ASSET_FORMATS}`,
    400,
    "errors.unsupportedImageType",
    { allowed: ALLOWED_ASSET_FORMATS },
  );
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const ACTIVE_SVG_ELEMENTS = new Set([
  "animation",
  "audio",
  "canvas",
  "discard",
  "embed",
  "foreignobject",
  "handler",
  "iframe",
  "listener",
  "object",
  "script",
  "set",
  "video",
  "animate",
  "animatecolor",
  "animatemotion",
  "animatetransform",
]);
const LINK_ATTRIBUTES = new Set([
  "action",
  "formaction",
  "href",
  "poster",
  "src",
]);

function cssWithoutComments(value: string): string | null {
  if (value.includes("\\")) return null;
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("/*", cursor);
    const strayEnd = value.indexOf("*/", cursor);
    if (strayEnd !== -1 && (start === -1 || strayEnd < start)) return null;
    if (start === -1) return output + value.slice(cursor);
    output += value.slice(cursor, start);
    const end = value.indexOf("*/", start + 2);
    if (end === -1) return null;
    cursor = end + 2;
  }
  return output;
}

function hasOnlyLocalUrlFunctions(value: string): boolean {
  const withoutLocalUrls = value.replace(
    /url\s*\(\s*(['"]?)#[^\s)'"<>]+\1\s*\)/gi,
    "",
  );
  return !/url\s*\(/i.test(withoutLocalUrls);
}

function safeLocalUrlFunctions(value: string): boolean {
  const normalized = cssWithoutComments(value);
  return normalized !== null && hasOnlyLocalUrlFunctions(normalized);
}

function safeStyle(value: string): boolean {
  const normalized = cssWithoutComments(value);
  return (
    normalized !== null &&
    hasOnlyLocalUrlFunctions(normalized) &&
    !/@import|expression\s*\(|(?:^|[;\s])behavior\s*:|-moz-binding|javascript\s*:|data\s*:|vbscript\s*:|https?\s*:|\/\//i.test(
      normalized,
    )
  );
}

function safeLink(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized === "" ||
    (/^#[^\s<>]+$/.test(normalized) && !normalized.includes("\\"))
  );
}

function isSafeSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (text.includes("\0")) return false;

  let xml = text.replace(/^\uFEFF/, "").trimStart();
  if (xml.startsWith("<?xml")) {
    const declaration = /^<\?xml\s+[^?]*\?>/i.exec(xml);
    if (!declaration) return false;
    xml = xml.slice(declaration[0].length);
  }
  if (/<\?|<!\s*(?!-{2})/i.test(xml)) return false;

  const parseErrors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => parseErrors.push(message),
      error: (message) => parseErrors.push(message),
      fatalError: (message) => parseErrors.push(message),
    },
  }).parseFromString(xml, "image/svg+xml");
  if (parseErrors.length > 0) return false;

  const root = document.documentElement;
  if (
    root?.localName.toLowerCase() !== "svg" ||
    (root.namespaceURI !== null && root.namespaceURI !== SVG_NAMESPACE)
  ) {
    return false;
  }
  for (let index = 0; index < document.childNodes.length; index += 1) {
    const node = document.childNodes.item(index);
    if (!node) continue;
    if (node.nodeType === 1 && node !== root) return false;
    if (node.nodeType === 3 && node.nodeValue?.trim()) return false;
    if (![1, 3, 8].includes(node.nodeType)) return false;
  }

  const visit = (element: Element): boolean => {
    const elementName = element.localName.toLowerCase();
    if (
      ACTIVE_SVG_ELEMENTS.has(elementName) ||
      element.namespaceURI === HTML_NAMESPACE
    ) {
      return false;
    }

    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (!attribute) continue;
      const name = attribute.localName.toLowerCase();
      const qualifiedName = attribute.name.toLowerCase();
      const value = attribute.value;
      if (
        name.startsWith("on") ||
        qualifiedName === "xml:base" ||
        /javascript\s*:|data\s*:|vbscript\s*:/i.test(value)
      ) {
        return false;
      }
      if (
        (LINK_ATTRIBUTES.has(name) || qualifiedName.endsWith(":href")) &&
        !safeLink(value)
      ) {
        return false;
      }
      if (!safeLocalUrlFunctions(value)) return false;
      if (name === "style" && !safeStyle(value)) return false;
    }

    if (elementName === "style" && !safeStyle(element.textContent ?? "")) {
      return false;
    }
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && !visit(child as Element)) return false;
      if (![1, 3, 4, 8].includes(child.nodeType)) return false;
    }
    return true;
  };

  return visit(root as unknown as Element);
}

function hasSignature(type: string, bytes: Uint8Array): boolean {
  if (type === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
  }
  if (type === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === "image/webp") {
    return (
      new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
    );
  }
  if (type === "image/x-icon" || type === "image/vnd.microsoft.icon") {
    return (
      bytes[0] === 0x00 &&
      bytes[1] === 0x00 &&
      bytes[2] === 0x01 &&
      bytes[3] === 0x00
    );
  }
  if (type === "image/svg+xml") {
    return isSafeSvg(bytes);
  }
  return false;
}

function safeStoredPath(filename: string): string | null {
  if (basename(filename) !== filename) return null;
  if (
    !/^(?:logo|favicon|mark)-(?:dark|light)(?:-[a-f0-9]{64})?\.(?:png|jpg|webp|svg|ico)$/.test(
      filename,
    )
  ) {
    return null;
  }
  const root = resolve(config.brandingStorageDir);
  const candidate = resolve(root, filename);
  return candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

async function referenced(
  filename: string,
  base: PrismaClient,
): Promise<boolean> {
  const row = await base.appBranding.findUnique({
    where: { id: SINGLETON_ID },
    select: Object.fromEntries(ASSET_COLUMNS.map((column) => [column, true])),
  });
  return row
    ? ASSET_COLUMNS.some(
        (column) => (row as Record<string, string | null>)[column] === filename,
      )
    : false;
}

async function deleteIfUnreferenced(
  filename: string | null,
  base: PrismaClient,
): Promise<void> {
  if (!filename) return;
  try {
    if (await referenced(filename, base)) return;
    const path = safeStoredPath(filename);
    if (!path) return;
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.warn({ error, filename }, "branding asset cleanup failed");
  }
}

function updateProjection(row: BrandingRow) {
  const dto = toDto(row);
  return {
    brandName: dto.brandName,
    colorMode: dto.colorMode,
    brandColor: dto.brandColor,
    tokensLight: dto.tokensLight,
    tokensDark: dto.tokensDark,
    siteUrl: dto.siteUrl,
    supportEmail: dto.supportEmail,
    hideGithubLink: dto.hideGithubLink,
  };
}

export async function updateBrandingColors(
  ctx: TenantContext,
  input: ColorUpdate,
  base: PrismaClient = basePrisma,
): Promise<GlobalBrandingDto> {
  assertFleetAdmin(ctx);
  const data = assertBrandingColorsUpdatable(input);
  return asSuperAdminOn(base, async (db) => {
    const before = await db.appBranding.findUnique({
      where: { id: SINGLETON_ID },
    });
    const row = await db.appBranding.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        ...data,
      } as Prisma.AppBrandingUncheckedCreateInput,
      update: data as Prisma.AppBrandingUpdateInput,
    });
    await auditMutationOn(db, ctx, null, {
      action: "branding.update",
      target: `branding:${SINGLETON_ID}`,
      before: before ? updateProjection(before) : null,
      after: updateProjection(row),
    });
    return toDto(row);
  });
}

export async function setBrandingAsset(
  ctx: TenantContext,
  kind: AssetKind,
  variant: AssetVariant,
  file: {
    type: string;
    size: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  },
  base: PrismaClient = basePrisma,
): Promise<GlobalBrandingDto> {
  assertFleetAdmin(ctx);
  assertAssetTarget(kind, variant);
  const contentType = file.type.trim().toLowerCase().split(";", 1)[0] ?? "";
  const extension = EXT_BY_TYPE[contentType];
  if (!extension || !ALLOWED_ASSET_TYPES.includes(contentType)) {
    throw unsupportedType();
  }
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > ASSET_MAX_BYTES[kind]
  ) {
    throw new AppError("image too large", 400, "errors.imageTooLarge");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > ASSET_MAX_BYTES[kind]) {
    throw new AppError("image too large", 400, "errors.imageTooLarge");
  }
  if (file.size !== bytes.byteLength) {
    throw new AppError("image size does not match uploaded bytes", 400);
  }
  if (!hasSignature(contentType, bytes)) throw unsupportedType();

  const digest = createHash("sha256").update(bytes).digest("hex");
  const filename = `${kind}-${variant}-${digest}.${extension}`;
  const finalPath = assetPath(filename);
  const tempPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    if (await Bun.file(finalPath).exists()) await unlink(tempPath);
    else await rename(tempPath, finalPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {}
    throw error;
  }

  const column = keyColumn(kind, variant);
  let oldKey: string | null = null;
  try {
    const dto = await asSuperAdminOn(base, async (db) => {
      const before = await db.appBranding.findUnique({
        where: { id: SINGLETON_ID },
      });
      oldKey = before ? (before[column] as string | null) : null;
      const row = await db.appBranding.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, [column]: filename },
        update: { [column]: filename },
      });
      await auditMutationOn(db, ctx, null, {
        action: "branding.asset_set",
        target: `branding_asset:${kind}:${variant}`,
        before: { kind, variant, configured: oldKey !== null },
        after: {
          kind,
          variant,
          configured: true,
          contentType,
          size: bytes.byteLength,
          digest,
        },
      });
      return toDto(row);
    });
    if (oldKey !== filename) await deleteIfUnreferenced(oldKey, base);
    return dto;
  } catch (error) {
    await deleteIfUnreferenced(filename, base);
    throw error;
  }
}

export async function clearBrandingAsset(
  ctx: TenantContext,
  kind: AssetKind,
  variant: AssetVariant,
  base: PrismaClient = basePrisma,
): Promise<GlobalBrandingDto> {
  assertFleetAdmin(ctx);
  assertAssetTarget(kind, variant);
  const column = keyColumn(kind, variant);
  let oldKey: string | null = null;
  const dto = await asSuperAdminOn(base, async (db) => {
    const before = await db.appBranding.findUnique({
      where: { id: SINGLETON_ID },
    });
    oldKey = before ? (before[column] as string | null) : null;
    const row = await db.appBranding.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, [column]: null },
      update: { [column]: null },
    });
    await auditMutationOn(db, ctx, null, {
      action: "branding.asset_clear",
      target: `branding_asset:${kind}:${variant}`,
      before: { kind, variant, configured: oldKey !== null },
      after: { kind, variant, configured: false },
    });
    return toDto(row);
  });
  await deleteIfUnreferenced(oldKey, base);
  return dto;
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  clearBrandingAsset,
  setBrandingAsset,
  updateBrandingColors,
} from "@/api/features/branding/branding.admin.service";
import {
  type BrandingRow,
  readBrandingAsset,
} from "@/api/features/branding/branding.service";
import config from "@/config";
import { AppError, ForbiddenError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";

interface AuditRow {
  tenantId: bigint | null;
  actorId: bigint | null;
  actorType: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
}

function defaultRow(): BrandingRow {
  return {
    brandName: null,
    colorMode: "SIMPLE",
    brandColor: null,
    tokensLight: {},
    tokensDark: {},
    logoDarkKey: null,
    logoLightKey: null,
    faviconDarkKey: null,
    faviconLightKey: null,
    markDarkKey: null,
    markLightKey: null,
    siteUrl: null,
    supportEmail: null,
    hideGithubLink: false,
    updatedAt: new Date(0),
  };
}

function fakeDb(initial: BrandingRow | null = null) {
  let row = initial ? structuredClone(initial) : null;
  let audits: AuditRow[] = [];
  let failAudit = false;
  let clock = 1;

  const appBranding = {
    findUnique: async () => (row ? structuredClone(row) : null),
    upsert: async ({
      create,
      update,
    }: {
      create: Partial<BrandingRow>;
      update: Partial<BrandingRow>;
    }) => {
      row = row
        ? { ...row, ...update, updatedAt: new Date(clock++) }
        : { ...defaultRow(), ...create, updatedAt: new Date(clock++) };
      return structuredClone(row);
    },
    update: async ({ data }: { data: Partial<BrandingRow> }) => {
      if (!row) throw new Error("missing branding row");
      row = { ...row, ...data, updatedAt: new Date(clock++) };
      return structuredClone(row);
    },
  };

  const client = {
    appBranding,
    $extends: () => client,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const rowSnapshot = structuredClone(row);
      const auditSnapshot = structuredClone(audits);
      const tx = {
        $executeRaw: async () => 1,
        appBranding,
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
        row = rowSnapshot;
        audits = auditSnapshot;
        throw error;
      }
    },
  };

  return {
    client: client as unknown as PrismaClient,
    row: () => row,
    audits: () => audits,
    failAudit: () => {
      failAudit = true;
    },
  };
}

const superAdmin: TenantContext = {
  tenantId: null,
  userId: 42n,
  role: "SUPER_ADMIN",
  actorType: "mcp",
};

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const svg = (source: string) => new TextEncoder().encode(source);

function upload(type: string, bytes: Uint8Array, size = bytes.byteLength) {
  return {
    type,
    size,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  };
}

let storageDir = "";
const previousStorageDir = config.brandingStorageDir;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "branding-admin-test-"));
  config.brandingStorageDir = storageDir;
});

afterAll(async () => {
  config.brandingStorageDir = previousStorageDir;
  await rm(storageDir, { recursive: true, force: true });
});

describe("branding admin mutations", () => {
  test("updates the singleton with sanitized values and a fleet audit", async () => {
    const db = fakeDb();
    const dto = await updateBrandingColors(
      superAdmin,
      {
        brandName: "  Acme\n",
        colorMode: "ADVANCED",
        tokensLight: { accent: "#ff0000", unknown: "#000000" },
        siteUrl: "https://acme.example",
        supportEmail: "help@acme.example",
        hideGithubLink: true,
      },
      db.client,
    );

    expect(dto).toMatchObject({
      brandName: "Acme",
      colorMode: "ADVANCED",
      tokensLight: { accent: "#ff0000" },
      siteUrl: "https://acme.example",
      supportEmail: "help@acme.example",
      hideGithubLink: true,
    });
    expect(db.audits()).toMatchObject([
      {
        tenantId: null,
        actorId: 42n,
        actorType: "mcp",
        action: "branding.update",
        target: "branding:1",
      },
    ]);
  });

  test("rejects invalid values and non-fleet actors before a write", async () => {
    const db = fakeDb();
    for (const input of [
      { colorMode: "NOPE" },
      { brandColor: "url(javascript:evil)" },
      { siteUrl: "javascript:alert(1)" },
      { supportEmail: "not-an-email" },
      {},
    ]) {
      await expect(
        updateBrandingColors(superAdmin, input as never, db.client),
      ).rejects.toBeInstanceOf(AppError);
    }
    await expect(
      updateBrandingColors(
        { tenantId: 1n, userId: 1n, role: "TENANT_ADMIN" },
        { brandName: "No" },
        db.client,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.row()).toBeNull();
  });

  test("stores a verified asset under a deterministic digest name and audits metadata only", async () => {
    const db = fakeDb();
    const dto = await setBrandingAsset(
      superAdmin,
      "logo",
      "dark",
      upload("image/png", png),
      db.client,
    );
    const filenames = await readdir(storageDir);
    expect(filenames).toHaveLength(1);
    expect(filenames[0]).toMatch(/^logo-dark-[a-f0-9]{64}\.png$/);
    expect(dto.logo.dark).toBe(true);
    expect(
      JSON.stringify(db.audits(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("89504e47");
    expect(db.audits()).toMatchObject([
      {
        tenantId: null,
        action: "branding.asset_set",
        after: { kind: "logo", variant: "dark", contentType: "image/png" },
      },
    ]);
  });

  test("rejects invalid paths, oversized files and MIME/signature spoofing", async () => {
    const db = fakeDb();
    await expect(
      setBrandingAsset(
        superAdmin,
        "../logo" as never,
        "dark",
        upload("image/png", png),
        db.client,
      ),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      setBrandingAsset(
        superAdmin,
        "logo",
        "night" as never,
        upload("image/png", png),
        db.client,
      ),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      setBrandingAsset(
        superAdmin,
        "favicon",
        "light",
        upload("image/png", png, 524_289),
        db.client,
      ),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      setBrandingAsset(
        superAdmin,
        "logo",
        "light",
        upload("image/jpeg", png),
        db.client,
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(db.row()).toBeNull();
  });

  test("refuses poisoned stored filenames and symlinks without reading their targets", async () => {
    const marker = `branding-unit-secret-${process.pid}`;
    const secretPath = join(tmpdir(), `${marker}.svg`);
    const symlinkName = `logo-dark-${"b".repeat(64)}.svg`;
    await writeFile(secretPath, marker);
    await symlink(secretPath, join(storageDir, symlinkName));

    try {
      for (const filename of [`../../${marker}.svg`, secretPath, symlinkName]) {
        const db = fakeDb({ ...defaultRow(), logoDarkKey: filename });
        expect(await readBrandingAsset("logo", "dark", db.client)).toBeNull();
      }
    } finally {
      await rm(secretPath, { force: true });
      await rm(join(storageDir, symlinkName), { force: true });
    }
  });

  test("reads a regular generated asset from the branding directory", async () => {
    const filename = `logo-dark-${"c".repeat(64)}.png`;
    await writeFile(join(storageDir, filename), png);
    const db = fakeDb({ ...defaultRow(), logoDarkKey: filename });

    const asset = await readBrandingAsset("logo", "dark", db.client);

    expect(asset?.contentType).toBe("image/png");
    expect(new Uint8Array(asset?.bytes ?? new ArrayBuffer(0))).toEqual(png);
    await rm(join(storageDir, filename), { force: true });
  });

  test("accepts benign SVG features with local fragment references", async () => {
    const db = fakeDb();
    const bytes = svg(`<?xml version="1.0"?>
      <!-- exported logo -->
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
        <defs>
          <linearGradient id="brand"><stop offset="0" stop-color="#06b6d4" /></linearGradient>
          <filter id="shadow"><feDropShadow dx="1" dy="1" /></filter>
          <path id="shape" d="M2 2h28v28H2z" />
        </defs>
        <style>.mark { fill: URL( '#brand' ); stroke: #0f172a; }</style>
        <use class="mark" href="#shape" style="filter: u/**/rl(&quot;#shadow&quot;)" />
      </svg>`);

    const dto = await setBrandingAsset(
      superAdmin,
      "favicon",
      "dark",
      upload("image/svg+xml; charset=utf-8", bytes),
      db.client,
    );

    expect(dto.favicon.dark).toBe(true);
    expect(
      (await readdir(storageDir)).some((name) => name.endsWith(".svg")),
    ).toBe(true);
  });

  test("rejects SVG active content, remote links and unsafe XML", async () => {
    const hostile = [
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><path /></a></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#p" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://evil.example/p.svg#x)" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:URL('HTTPS://evil.example/p.svg#x')" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(//evil.example/p.svg#x)" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:UrL('JaVaScRiPt:alert(1)')" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u/**/Rl('DaTa:image/svg+xml;base64,PHN2Zy8+')" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l('https://evil.example/p.svg')" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u&#114;l('h&#116;tps://evil.example/p.svg')" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css)</style></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>@IMPORT "//evil.example/x.css";</style></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>@im/**/port "/branding.css";</style></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u/**/rl(/tracking.svg#paint)" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><iframe src="https://evil.example" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><animation href="#safe" /></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="#safe;javascript:alert(1)" /></svg>`,
      `<!DOCTYPE svg [<!ENTITY payload SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&payload;</svg>`,
      `<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/x.css"?><svg xmlns="http://www.w3.org/2000/svg" />`,
    ];

    for (const source of hostile) {
      const db = fakeDb();
      await expect(
        setBrandingAsset(
          superAdmin,
          "logo",
          "light",
          upload("image/svg+xml", svg(source)),
          db.client,
        ),
      ).rejects.toBeInstanceOf(AppError);
      expect(db.row()).toBeNull();
    }
  });

  test("rolls back the reference and removes temporary bytes when audit fails", async () => {
    const db = fakeDb();
    db.failAudit();
    await expect(
      setBrandingAsset(
        superAdmin,
        "mark",
        "light",
        upload("image/png", png),
        db.client,
      ),
    ).rejects.toThrow("audit unavailable");
    expect(db.row()).toBeNull();
    const stored = (await readdir(storageDir)).filter((name) =>
      name.startsWith("mark-"),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(".tmp-");
    expect(await Bun.file(join(storageDir, stored[0] as string)).exists()).toBe(
      true,
    );
  });

  test("replacement and clear retain immutable finalized bytes", async () => {
    const oldKey = "logo-light.png";
    await writeFile(join(storageDir, oldKey), png);
    const seeded = {
      ...defaultRow(),
      logoLightKey: oldKey,
      markLightKey: oldKey,
    };
    const db = fakeDb(seeded);

    await setBrandingAsset(
      superAdmin,
      "logo",
      "light",
      upload("image/png", png),
      db.client,
    );
    expect(await readdir(storageDir)).toContain(oldKey);

    await clearBrandingAsset(superAdmin, "mark", "light", db.client);
    expect(await Bun.file(join(storageDir, oldKey)).exists()).toBe(true);
    await clearBrandingAsset(superAdmin, "mark", "light", db.client);
    expect(db.audits().at(-1)).toMatchObject({
      tenantId: null,
      action: "branding.asset_clear",
    });
  });

  test("clear does not inspect or remove a finalized asset after commit", async () => {
    const oldKey = "logo-dark.png";
    await mkdir(join(storageDir, oldKey));
    const db = fakeDb({ ...defaultRow(), logoDarkKey: oldKey });

    const dto = await clearBrandingAsset(superAdmin, "logo", "dark", db.client);

    expect(dto.logo.dark).toBe(false);
    expect(db.row()?.logoDarkKey).toBeNull();
    expect(db.audits().at(-1)).toMatchObject({
      action: "branding.asset_clear",
    });
    expect(await readdir(storageDir)).toContain(oldKey);
    await rm(join(storageDir, oldKey), { recursive: true, force: true });
  });
});

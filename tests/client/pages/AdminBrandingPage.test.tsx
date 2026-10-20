/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { withI18n } from "@/tests/utils/i18n";

const refresh = mock(async () => {});
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "1", role: "SUPER_ADMIN" }, loading: false }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ToastProvider } = await import("@/client/components/Toast");
const { AdminBrandingEditor } = await import(
  "@/client/pages/admin/AdminBrandingPage"
);

const realFetch = globalThis.fetch;
let calls: Array<{ method: string; path: string; body?: unknown }> = [];
let branding = {
  brandName: "Acme",
  colorMode: "SIMPLE",
  brandColor: "#2563eb",
  tokensLight: {},
  tokensDark: {},
  logo: { dark: false, light: false },
  favicon: { dark: false, light: false },
  mark: { dark: false, light: false },
  siteUrl: "https://acme.example",
  supportEmail: "help@acme.example",
  hideGithubLink: false,
  version: "1",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  calls = [];
  refresh.mockClear();
  branding = {
    ...branding,
    brandName: "Acme",
    colorMode: "SIMPLE",
    logo: { dark: false, light: false },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input));
    const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
    if (method === "GET") return json(branding);
    if (method === "PATCH") {
      const text = request
        ? await request.clone().text()
        : String(init?.body ?? "");
      const body = JSON.parse(text);
      calls.push({ method, path: url.pathname, body });
      branding = { ...branding, ...body };
      return json(branding);
    }
    const asset =
      /^\/api\/v1\/branding\/asset\/(logo|favicon|mark)\/(dark|light)$/.exec(
        url.pathname,
      );
    if (asset && method === "PUT") {
      const kind = asset[1] as "logo" | "favicon" | "mark";
      const variant = asset[2] as "dark" | "light";
      calls.push({ method, path: url.pathname });
      branding = {
        ...branding,
        [kind]: { ...branding[kind], [variant]: true },
      };
      return json(branding);
    }
    if (asset && method === "DELETE") {
      const kind = asset[1] as "logo" | "favicon" | "mark";
      const variant = asset[2] as "dark" | "light";
      calls.push({ method, path: url.pathname });
      branding = {
        ...branding,
        [kind]: { ...branding[kind], [variant]: false },
      };
      return json(branding);
    }
    return json({}, 404);
  }) as typeof fetch;
});

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

function mount() {
  return render(
    withI18n(
      <MemoryRouter>
        <ToastProvider>
          <AdminBrandingEditor refreshBranding={refresh} />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
}

describe("AdminBrandingPage", () => {
  test("loads, edits SIMPLE/ADVANCED fields, saves, and refreshes the app brand", async () => {
    mount();
    const name = (await screen.findByLabelText(
      "Brand name",
    )) as HTMLInputElement;
    expect(name.value).toBe("Acme");
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText("Light accent"), {
      target: { value: "#e11d48" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save branding" }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === "PATCH")).toBe(true),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    const patch = calls.find((call) => call.method === "PATCH")?.body as Record<
      string,
      unknown
    >;
    expect(patch.colorMode).toBe("ADVANCED");
    expect(patch.tokensLight).toEqual({ accent: "#e11d48" });
  });

  test("uploads and removes a dark logo, refreshing after each mutation", async () => {
    mount();
    const input = (await screen.findByLabelText(
      "Upload dark logo",
    )) as HTMLInputElement;
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      "logo.png",
      {
        type: "image/png",
      },
    );
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove dark logo" }),
      ).toBeDefined(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove dark logo" }));
    await waitFor(() =>
      expect(
        calls.filter((call) => call.path.includes("/asset/logo/dark")).length,
      ).toBe(2),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

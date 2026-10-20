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
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { withI18n } from "@/tests/utils/i18n";

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "1", email: "root@example.com", role: "SUPER_ADMIN" },
    loading: false,
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { AdminTenantsPage } = await import(
  "@/client/pages/admin/AdminTenantsPage"
);

const realFetch = globalThis.fetch;
let requests: Array<{ method: string; path: string; body: unknown }> = [];
let rows = [
  {
    id: "10",
    name: "Existing",
    slug: "existing",
    demoMode: false,
    userCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input));
    const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
    const bodyText = request
      ? await request.clone().text()
      : String(init?.body ?? "");
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    requests.push({ method, path: url.pathname, body });

    if (method === "GET" && url.pathname === "/api/admin/tenants") {
      return json({ tenants: rows });
    }
    if (method === "POST" && url.pathname === "/api/v1/tenants") {
      const tenant = {
        id: "11",
        name: body.name,
        slug: body.slug,
        demoMode: false,
        createdAt: "2026-10-20T00:00:00.000Z",
      };
      rows = [...rows, { ...tenant, userCount: 0 }];
      return json({
        tenant,
        invite: body.adminEmail
          ? {
              email: body.adminEmail,
              role: "TENANT_ADMIN",
              acceptUrl: "https://example.test/accept-invite?token=once",
              expiresAt: "2026-10-27T00:00:00.000Z",
            }
          : undefined,
      });
    }
    const tenant = /^\/api\/v1\/tenants\/(\d+)$/.exec(url.pathname);
    if (tenant && method === "PATCH") {
      rows = rows.map((row) =>
        row.id === tenant[1] ? { ...row, name: body.name } : row,
      );
      return json({ tenant: rows.find((row) => row.id === tenant[1]) });
    }
    if (tenant && method === "DELETE") {
      rows = rows.filter((row) => row.id !== tenant[1]);
      return json({ success: true });
    }
    return json({}, 404);
  }) as typeof fetch;
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().search}</span>;
}

function mount(path = "/admin/tenants") {
  return render(
    withI18n(
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <NavGuardProvider>
            <Routes>
              <Route
                path="/admin/tenants"
                element={
                  <>
                    <AdminTenantsPage />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </NavGuardProvider>
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
}

beforeEach(() => {
  requests = [];
  rows = [
    {
      id: "10",
      name: "Existing",
      slug: "existing",
      demoMode: false,
      userCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  installFetch();
});

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("AdminTenantsPage", () => {
  test("?create=1 opens the create form, consumes the query, returns the invite and emits a tenant event", async () => {
    let events = 0;
    window.addEventListener("tenants:changed", () => events++);
    mount("/admin/tenants?create=1");

    const dialog = await screen.findByRole("dialog", { name: "Create tenant" });
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(""),
    );
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Name/ }), {
      target: { value: "Acme" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Slug/ }), {
      target: { value: "acme" },
    });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: /First admin email/ }),
      {
        target: { value: "admin@acme.test" },
      },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create tenant" }),
    );

    expect(await screen.findByDisplayValue(/token=once/)).toBeDefined();
    expect(events).toBe(1);
    await waitFor(() => expect(screen.getByText("Acme")).toBeDefined());
  });

  test("edits and deletes a tenant through the owned controls", async () => {
    mount();
    const row = (await screen.findByText("Existing")).closest(
      "tr",
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const edit = await screen.findByRole("dialog", { name: "Edit tenant" });
    fireEvent.change(within(edit).getByRole("textbox", { name: /Name/ }), {
      target: { value: "Renamed" },
    });
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Renamed")).toBeDefined();

    const renamed = screen.getByText("Renamed").closest("tr") as HTMLElement;
    fireEvent.click(within(renamed).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Delete tenant",
    });
    fireEvent.change(
      within(confirm).getByRole("textbox", {
        name: /Type Renamed to confirm/,
      }),
      {
        target: { value: "Renamed" },
      },
    );
    fireEvent.change(
      confirm.querySelector('input[type="password"]') as HTMLInputElement,
      {
        target: { value: "secret" },
      },
    );
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Delete tenant" }),
    );
    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.method === "DELETE" &&
            request.path === "/api/v1/tenants/10",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText("Renamed")).toBeNull());
  });
});

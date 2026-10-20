# Self-hosted tenants and branding implementation plan

Date: 2026-10-20
Base: v1.35.0 (`debe656063535e80f0f60bd2091196987acbc6f7`)
Branch: `complete-selfhosted-tenants-branding`

## Scope and invariants

- Replace exactly the six project-owned `ProEditionError` mutation stubs in the tenant and global-branding admin services.
- Replace the two owned admin-page upgrade gates with functional tenant-management and branding editors.
- Preserve the existing REST/MCP service boundary, `TenantContext` actor attribution, role checks, RLS helpers, non-enumerating not-found behavior, validation schemas, public branding read/asset contracts, and one-time invitation contract.
- Keep tenant and branding writes atomic with their audit records. Tenant deletion must retain its fleet audit row after the tenant cascade.
- Keep filesystem assets outside Git and use safe deterministic names under `BRANDING_STORAGE_DIR` only.
- Do not change deployment state, contact production services, or introduce third-party licensed code.

## Phase 1: tenant backend, test first

1. Add focused service tests for `createTenant`, `updateTenant`, and `deleteTenant`.
2. Cover validation before database access: invalid/empty create and update payloads, empty patches, malformed ids at controller/MCP boundaries, and over-range ids.
3. Cover authorization and isolation:
   - `createTenant` and `deleteTenant` accept only `SUPER_ADMIN` fleet contexts.
   - `updateTenant` accepts `TENANT_ADMIN` only for its own tenant through `runScopedOn`/RLS.
   - `SUPER_ADMIN` may target any tenant through `asSuperAdminOn`.
   - anonymous/AGENT calls remain controller/middleware refusals.
   - missing and inaccessible tenant ids produce the same `NotFoundError` contract.
4. Cover mutation behavior:
   - create returns the shared `TenantDto` and maps the slug unique constraint to `ConflictError` with field `slug`.
   - concurrent same-slug creates produce one success and one conflict.
   - update applies only parsed fields and audits only the safe before/after projection.
   - delete removes the tenant and dependents in one transaction, writes a surviving fleet-level audit row, and rolls back both mutation/audit on injected failure.
5. Add MCP parity coverage proving authorized tenant create/update paths now work while scope/RBAC refusals remain.
6. Run the focused tests and record RED failures caused by the current `ProEditionError` stubs.
7. Implement the three methods using `assertTenantCreatable`, `assertTenantUpdatable`, `toDto`, `TENANT_SELECT`, `asSuperAdminOn`, `runScopedOn`, and `auditMutationOn`.
8. Re-run the focused tests to GREEN, then run adjacent tenant, audit, selector, controller, and MCP suites.

## Phase 2: branding backend, test first

1. Add focused service tests for `updateBrandingColors`, `setBrandingAsset`, and `clearBrandingAsset`.
2. Cover input validation:
   - SIMPLE/ADVANCED modes, valid and invalid colors, invalid site URL/support email, empty patches, and unknown-token sanitization.
   - exact asset kind/variant allowlists, per-kind size limits, MIME allowlist, actual PNG/JPEG/WebP/SVG/ICO signatures, MIME/signature mismatch, and malicious/path-like values.
3. Cover global authorization and audit:
   - only `SUPER_ADMIN` contexts write.
   - branding actor and audit tenant scope are always fleet/global (`tenant_id = NULL`).
   - audits contain metadata/safe projections only, never uploaded bytes.
4. Cover filesystem/database ordering:
   - read bytes and validate content before writing.
   - derive a deterministic digest filename and write a sibling temporary file followed by atomic rename.
   - update the singleton row only after the final bytes exist.
   - clean temporary/new files on database failure.
   - delete the previous file only after commit and only when no branding column still references it.
   - clear is idempotent and never deletes a still-referenced file.
5. Add failure-injection tests for write/rename/database/audit rollback and old-file cleanup.
6. Run the focused tests and record RED failures caused by the current `ProEditionError` stubs.
7. Implement with `assertBrandingColorsUpdatable`, `keyColumn`, `assetPath`, `toDto`, constants, sanitizers, a short `asSuperAdminOn` transaction, and isolated filesystem helpers.
8. Re-run focused tests to GREEN, then run public branding controller/header/cache tests and branding audit tests.

## Phase 3: tenant frontend, test first

1. Add React tests for:
   - SUPER_ADMIN create modal, `?create=1` auto-open, and safe query consumption.
   - field refusals for name/slug/admin email.
   - optional first-admin invite response and copyable one-time `acceptUrl`.
   - edit-name flow.
   - delete flow through `StrongConfirmModal` with exact tenant name and password.
   - table refresh plus `notifyTenantsChanged()` after create/update/delete.
   - removed active-tenant reconciliation through the existing tenant-list event path.
   - TENANT_ADMIN redirect/no fleet controls and accessible labels/disabled loading controls.
2. Run the focused client tests and record RED failures from the existing read-only `ProGate` page.
3. Implement always-rendered modal controllers using existing `Modal`, `FormField`, `Input`, `Button`, `useFieldRefusal`, `StrongConfirmModal`, toast, API treaty types, and tenant-change helpers.
4. Use `/api/v1/tenants` for mutations and `/api/admin/tenants` for the count-enriched fleet table.
5. Re-run focused tests to GREEN and run adjacent admin, modal, tenant-switcher, and bundle-boundary tests.

## Phase 4: branding frontend, test first

1. Add React tests for load, save, SIMPLE/ADVANCED switching, token editing, dark/light logo/mark/favicon upload/remove, validation refusals, dirty/loading state, role redirect, and `BrandingContext.refresh()` after every mutation.
2. Run the focused client tests and record RED failures from the existing branding `ProGate` page.
3. Implement an accessible editor that derives response types from the Eden client and loads `/api/v1/branding`.
4. Add brand name, website URL, support email, GitHub-link switch, SIMPLE brand color, ADVANCED allowlisted token fields, and six bounded asset controls.
5. Keep local upload accept/size checks advisory; surface server field/global refusals as authoritative.
6. Re-run focused tests to GREEN and run adjacent branding context, palette, favicon, sidebar/footer, and client boundary tests.

## Phase 5: integration hardening and commits

1. Verify the tenant-create controller still composes the optional first-admin invitation and returns only the one-time URL once.
2. Verify delete step-up and exact-name confirmation remain controller-owned and unchanged.
3. Verify audit action catalog/filter coverage for the new tenant and branding action names.
4. Verify no `ProGate`, “Upgrade to Pro”, or `ProEditionError` remains in the two pages or six methods in default/full builds.
5. Make bounded commits in this order:
   - plan;
   - tenant backend tests + implementation;
   - branding backend tests + implementation;
   - tenant frontend tests + implementation;
   - branding frontend tests + implementation;
   - integration/final hardening fixes if needed.

## Final gates

- Focused RED evidence for every new behavior before implementation, followed by focused GREEN output.
- Relevant tenant/branding/API/MCP/client suites.
- Full feasible `bun test`.
- `bun run build-check` and `bun run build-check:worker`.
- `bun run lint`; run `bun run format` only when needed, then re-run lint.
- `bun run openapi:check` and `bun run i18n:extract` with generated-file diff inspection.
- `bun run build` with the default/full edition.
- `git diff --check`.
- Inspect the complete diff, status, and untracked files.
- Scan changed source for secrets, copied artifacts, mock/demo bypasses, unsafe raw tenant writes, path traversal, and the six removed `ProEditionError` calls.
- Commit all intended implementation and test changes; do not push or deploy.

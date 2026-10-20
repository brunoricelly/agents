import { Check, Copy, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  FormField,
  Input,
  Modal,
  type ModalController,
  Skeleton,
  StrongConfirmModal,
  type StrongConfirmPayload,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { notifyTenantsChanged } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDate } from "@/client/lib/utils";

type TenantsData = Awaited<
  ReturnType<typeof api.api.admin.tenants.get>
>["data"];
type TenantRow = NonNullable<TenantsData>["tenants"][number];
type CreateData = Awaited<ReturnType<typeof api.api.v1.tenants.post>>["data"];

const TENANT_SKELETON_KEYS = ["tenant-0", "tenant-1", "tenant-2"];
const CREATE_FIELDS = ["name", "slug", "adminEmail"] as const;
const EDIT_FIELDS = ["name"] as const;

function CreateTenantModal({
  modal,
  onCreated,
}: {
  modal: ModalController;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [invite, setInvite] = useState<NonNullable<
    NonNullable<CreateData>["invite"]
  > | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const refusal = useFieldRefusal(modal.isOpen ? CREATE_FIELDS : []);
  const current = { name, slug, adminEmail: adminEmail || undefined };
  const currentRef = useRef(current);
  currentRef.current = current;

  useOnModalOpen(modal, () => {
    refusal.clear();
    setName("");
    setSlug("");
    setAdminEmail("");
    setInvite(null);
    setError("");
    setCopied(false);
  });

  async function submit() {
    const body = { ...current };
    setLoading(true);
    setError("");
    try {
      const { data, error: apiError } = await api.api.v1.tenants.post(body);
      if (apiError) {
        setError(
          refusal.capture(
            apiError,
            t("tenant.createFailed", "Could not create the tenant."),
            body,
            currentRef.current,
          ) ?? "",
        );
        return;
      }
      refusal.clear();
      setInvite(data?.invite ?? null);
      onCreated();
      if (!data?.invite) modal.close();
    } catch (caught) {
      setError(
        refusal.capture(
          caught,
          t("tenant.createFailed", "Could not create the tenant."),
          body,
          currentRef.current,
        ) ?? "",
      );
    } finally {
      setLoading(false);
    }
  }

  async function copyInvite() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.acceptUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      modal={modal}
      title={t("tenant.create", "Create tenant")}
      size="md"
      unsavedChanges={
        !invite &&
        (name.trim() !== "" || slug.trim() !== "" || adminEmail.trim() !== "")
      }
    >
      {invite ? (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {t(
              "tenant.inviteReady",
              "The tenant was created. Copy this one-time invitation link now.",
            )}
          </p>
          <FormField label={t("tenant.inviteUrl", "Invitation URL")}>
            <div className="flex gap-2">
              <Input
                value={invite.acceptUrl}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                variant="secondary"
                onClick={copyInvite}
                aria-label={t("common.copy", "Copy")}
              >
                {copied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </Button>
            </div>
          </FormField>
          <div className="flex justify-end">
            <Button onClick={modal.close}>{t("common.done", "Done")}</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FormField
            label={t("tenant.name", "Name")}
            required
            error={refusal.at("name", name) ?? undefined}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              autoFocus
            />
          </FormField>
          <FormField
            label={t("tenant.slug", "Slug")}
            required
            description={t(
              "tenant.slugHint",
              "Lowercase letters, numbers and hyphens.",
            )}
            error={refusal.at("slug", slug) ?? undefined}
          >
            <Input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              maxLength={100}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("tenant.firstAdminEmail", "First admin email")}
            description={t(
              "tenant.firstAdminOptional",
              "Optional. Creates a one-time tenant-admin invitation.",
            )}
            error={
              refusal.at("adminEmail", adminEmail || undefined) ?? undefined
            }
          >
            <Input
              type="email"
              value={adminEmail}
              onChange={(event) => setAdminEmail(event.target.value)}
              maxLength={254}
              autoComplete="email"
            />
          </FormField>
          {error && (
            <p className="text-error text-sm" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={modal.close}
              disabled={loading}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              type="submit"
              loading={loading}
              disabled={!name.trim() || !slug.trim()}
            >
              {t("tenant.create", "Create tenant")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EditTenantModal({
  modal,
  onUpdated,
}: {
  modal: ModalController<TenantRow>;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refusal = useFieldRefusal(modal.isOpen ? EDIT_FIELDS : []);
  const currentRef = useRef({ name });
  currentRef.current = { name };

  useOnModalOpen(modal, () => {
    refusal.clear();
    setName(modal.payload?.name ?? "");
    setError("");
  });

  async function submit() {
    const tenant = modal.payload;
    if (!tenant) return;
    const body = { name };
    setLoading(true);
    setError("");
    try {
      const { error: apiError } = await api.api.v1
        .tenants({ id: tenant.id })
        .patch(body);
      if (apiError) {
        setError(
          refusal.capture(
            apiError,
            t("tenant.updateFailed", "Could not update the tenant."),
            body,
            currentRef.current,
          ) ?? "",
        );
        return;
      }
      refusal.clear();
      onUpdated();
      modal.close();
    } catch (caught) {
      setError(
        refusal.capture(
          caught,
          t("tenant.updateFailed", "Could not update the tenant."),
          body,
          currentRef.current,
        ) ?? "",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      modal={modal}
      title={t("tenant.edit", "Edit tenant")}
      size="sm"
      unsavedChanges={!!modal.payload && name !== modal.payload.name}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField
          label={t("tenant.name", "Name")}
          required
          error={refusal.at("name", name) ?? undefined}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            autoFocus
          />
        </FormField>
        {error && (
          <p className="text-error text-sm" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={modal.close} disabled={loading}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button type="submit" loading={loading} disabled={!name.trim()}>
            {t("common.save", "Save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AdminTenantsPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const createModal = useModalController();
  const editModal = useModalController<TenantRow>();
  const deleteModal = useModalController<StrongConfirmPayload>();

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.api.admin.tenants.get();
      if (data) setTenants(data.tenants);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTenants();
  }, [fetchTenants]);

  useEffect(() => {
    if (user?.role !== "SUPER_ADMIN" || searchParams.get("create") !== "1")
      return;
    createModal.open();
    const next = new URLSearchParams(searchParams);
    next.delete("create");
    setSearchParams(next, { replace: true });
  }, [createModal, searchParams, setSearchParams, user?.role]);

  if (user && user.role !== "SUPER_ADMIN") {
    return <Navigate to="/admin/users" replace />;
  }

  const changed = () => {
    notifyTenantsChanged();
    void fetchTenants();
  };

  function openDelete(tenant: TenantRow) {
    deleteModal.open({
      title: t("tenant.delete", "Delete tenant"),
      warning: t(
        "tenant.deleteWarning",
        "This permanently deletes {{name}} and all of its data. It cannot be undone.",
        { name: tenant.name },
      ),
      confirmPhrase: tenant.name,
      confirmLabel: t("tenant.deleteConfirm", "Type {{name}} to confirm", {
        name: tenant.name,
      }),
      actionLabel: t("tenant.delete", "Delete tenant"),
      onConfirm: async (password) => {
        const { error } = await api.api.v1.tenants({ id: tenant.id }).delete({
          confirmName: tenant.name,
          password,
        });
        if (error) {
          showToast(
            apiErrorMessage(error) ||
              t("tenant.deleteFailed", "Could not delete the tenant."),
            "error",
          );
          throw error;
        }
        setTenants((current) => current.filter((row) => row.id !== tenant.id));
        notifyTenantsChanged();
        showToast(t("tenant.deleted", "Tenant deleted."), "success");
      },
    });
  }

  return (
    <div className="space-y-6 pt-2">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => createModal.open()}>
          <Plus aria-hidden="true" />
          {t("tenant.create", "Create tenant")}
        </Button>
      </div>

      <CreateTenantModal modal={createModal} onCreated={changed} />
      <EditTenantModal modal={editModal} onUpdated={changed} />
      <StrongConfirmModal modal={deleteModal} />

      <Card>
        {loading ? (
          <div className="py-2" role="status">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            {TENANT_SKELETON_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center gap-4 border-border/50 border-b px-2 py-3"
              >
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-8" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="ml-auto h-7 w-48 rounded" />
              </div>
            ))}
          </div>
        ) : tenants.length === 0 ? (
          <p className="py-10 text-center text-sm text-text-muted">
            {t("tenant.none", "No tenants yet.")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("tenant.name", "Name")}
                  </th>
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("tenant.slug", "Slug")}
                  </th>
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("admin.users", "Users")}
                  </th>
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("admin.createdAt", "Created")}
                  </th>
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("admin.actions", "Actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr
                    key={tenant.id}
                    className="border-border/50 border-b hover:bg-bg-tertiary/50"
                  >
                    <td className="px-2 py-3 text-text-primary">
                      <span className="flex items-center gap-2">
                        {tenant.name}
                        {tenant.demoMode && (
                          <Badge variant="secondary">
                            {t("tenant.demo", "Demo")}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-3 font-mono text-text-secondary text-xs">
                      {tenant.slug}
                    </td>
                    <td className="px-2 py-3 text-text-secondary">
                      {tenant.userCount}
                    </td>
                    <td className="px-2 py-3 text-text-secondary">
                      {formatDate(tenant.createdAt)}
                    </td>
                    <td className="px-2 py-3">
                      <div className="flex flex-wrap items-center gap-1">
                        <Link
                          to={`/admin/users?tenant=${tenant.id}`}
                          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-medium text-text-secondary text-xs transition-colors hover:bg-bg-hover hover:text-text-primary"
                        >
                          <Users className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("admin.viewUsers", "View users")}
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => editModal.open(tenant)}
                        >
                          <Pencil aria-hidden="true" />
                          {t("common.edit", "Edit")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openDelete(tenant)}
                          className="text-error"
                        >
                          <Trash2 aria-hidden="true" />
                          {t("common.delete", "Delete")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

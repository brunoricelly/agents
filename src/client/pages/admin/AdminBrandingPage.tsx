import { Image, Palette, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import {
  Button,
  Card,
  FormField,
  Input,
  SegmentedControl,
  Skeleton,
  Switch,
  useToast,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { useBranding } from "@/client/contexts/BrandingContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { cn } from "@/client/lib/utils";
import {
  BRANDABLE_KEYS,
  type BrandableKey,
  brandingAssetUrl,
} from "@/lib/branding";

type BrandingData = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.branding.get>>["data"]
>;
type AssetKind = "logo" | "favicon" | "mark";
type AssetVariant = "dark" | "light";
type FormState = Pick<
  BrandingData,
  | "brandName"
  | "colorMode"
  | "brandColor"
  | "tokensLight"
  | "tokensDark"
  | "siteUrl"
  | "supportEmail"
  | "hideGithubLink"
>;

const FORM_FIELDS = [
  "brandName",
  "colorMode",
  "brandColor",
  "tokensLight",
  "tokensDark",
  "siteUrl",
  "supportEmail",
  "hideGithubLink",
] as const;
const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
];
const MAX_BYTES: Record<AssetKind, number> = {
  logo: 1_048_576,
  favicon: 524_288,
  mark: 524_288,
};

function formOf(data: BrandingData): FormState {
  return {
    brandName: data.brandName,
    colorMode: data.colorMode,
    brandColor: data.brandColor,
    tokensLight: { ...data.tokensLight },
    tokensDark: { ...data.tokensDark },
    siteUrl: data.siteUrl,
    supportEmail: data.supportEmail,
    hideGithubLink: data.hideGithubLink,
  };
}

function emptyForm(): FormState {
  return {
    brandName: null,
    colorMode: "SIMPLE",
    brandColor: null,
    tokensLight: {},
    tokensDark: {},
    siteUrl: null,
    supportEmail: null,
    hideGithubLink: false,
  };
}

function tokenLabel(token: BrandableKey): string {
  return token.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

function AssetControl({
  kind,
  variant,
  configured,
  version,
  busy,
  onUpload,
  onRemove,
}: {
  kind: AssetKind;
  variant: AssetVariant;
  configured: boolean;
  version: string;
  busy: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const label = `${variant} ${kind}`;
  const uploadLabel = t("branding.uploadAsset", "Upload {{label}}", { label });
  const removeLabel = t("branding.removeAsset", "Remove {{label}}", { label });
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/40 p-3">
      <div className="mb-3 flex min-h-16 items-center justify-center rounded-md border border-border/70 bg-bg-primary/40 p-2">
        {configured ? (
          <img
            src={brandingAssetUrl(kind, variant, version)}
            alt=""
            className={cn(
              "max-h-12 max-w-full object-contain",
              kind !== "logo" && "max-w-12",
            )}
          />
        ) : (
          <Image className="h-6 w-6 text-text-muted" aria-hidden="true" />
        )}
      </div>
      <p className="mb-2 font-medium text-sm text-text-primary capitalize">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border-hover bg-bg-tertiary px-3 font-medium text-sm text-text-primary hover:bg-bg-hover">
          <Upload className="h-4 w-4" aria-hidden="true" />
          {configured
            ? t("common.replace", "Replace")
            : t("common.upload", "Upload")}
          <input
            type="file"
            className="sr-only"
            aria-label={uploadLabel}
            accept={ACCEPTED_TYPES.join(",")}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file);
              event.target.value = "";
            }}
          />
        </label>
        {configured && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={busy}
            aria-label={removeLabel}
          >
            <Trash2 aria-hidden="true" />
            {t("common.remove", "Remove")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function AdminBrandingPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { refresh } = useBranding();
  const { showToast } = useToast();
  const [data, setData] = useState<BrandingData | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [baseline, setBaseline] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assetBusy, setAssetBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const refusal = useFieldRefusal(FORM_FIELDS);
  const formRef = useRef(form);
  formRef.current = form;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: loaded, error: apiError } = await api.api.v1.branding.get();
      if (apiError || !loaded) {
        setError(
          apiErrorMessage(apiError) ||
            t("branding.loadFailed", "Could not load branding."),
        );
        return;
      }
      const next = formOf(loaded);
      setData(loaded);
      setForm(next);
      setBaseline(next);
      setError("");
    } catch (caught) {
      setError(
        apiErrorMessage(caught) ||
          t("branding.loadFailed", "Could not load branding."),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [baseline, form],
  );

  if (user && user.role !== "SUPER_ADMIN") {
    return <Navigate to="/admin/users" replace />;
  }

  async function save() {
    const sent = { ...form };
    setSaving(true);
    setError("");
    try {
      const { data: saved, error: apiError } =
        await api.api.v1.branding.patch(sent);
      if (apiError || !saved) {
        setError(
          refusal.capture(
            apiError,
            t("branding.saveFailed", "Could not save branding."),
            sent,
            formRef.current,
          ) ?? "",
        );
        return;
      }
      refusal.clear();
      const next = formOf(saved);
      setData(saved);
      setForm(next);
      setBaseline(next);
      await refresh();
      showToast(t("branding.saved", "Branding saved."), "success");
    } catch (caught) {
      setError(
        refusal.capture(
          caught,
          t("branding.saveFailed", "Could not save branding."),
          sent,
          formRef.current,
        ) ?? "",
      );
    } finally {
      setSaving(false);
    }
  }

  function applyAssetResponse(next: BrandingData) {
    setData(next);
  }

  async function upload(kind: AssetKind, variant: AssetVariant, file: File) {
    const key = `${kind}:${variant}`;
    if (!ACCEPTED_TYPES.includes(file.type) || file.size > MAX_BYTES[kind]) {
      showToast(
        t(
          "branding.assetInvalid",
          "Choose a supported image within the size limit.",
        ),
        "error",
      );
      return;
    }
    setAssetBusy(key);
    try {
      const { data: saved, error: apiError } = await api.api.v1.branding
        .asset({ kind })({ variant })
        .put({ file });
      if (apiError || !saved) {
        showToast(
          apiErrorMessage(apiError) ||
            t("branding.assetUploadFailed", "Could not upload the asset."),
          "error",
        );
        return;
      }
      applyAssetResponse(saved);
      await refresh();
    } catch (caught) {
      showToast(
        apiErrorMessage(caught) ||
          t("branding.assetUploadFailed", "Could not upload the asset."),
        "error",
      );
    } finally {
      setAssetBusy(null);
    }
  }

  async function remove(kind: AssetKind, variant: AssetVariant) {
    const key = `${kind}:${variant}`;
    setAssetBusy(key);
    try {
      const { data: saved, error: apiError } = await api.api.v1.branding
        .asset({ kind })({ variant })
        .delete();
      if (apiError || !saved) {
        showToast(
          apiErrorMessage(apiError) ||
            t("branding.assetRemoveFailed", "Could not remove the asset."),
          "error",
        );
        return;
      }
      applyAssetResponse(saved);
      await refresh();
    } catch (caught) {
      showToast(
        apiErrorMessage(caught) ||
          t("branding.assetRemoveFailed", "Could not remove the asset."),
        "error",
      );
    } finally {
      setAssetBusy(null);
    }
  }

  const setToken = (
    theme: "tokensLight" | "tokensDark",
    token: BrandableKey,
    value: string,
  ) => {
    setForm((current) => {
      const tokens = { ...current[theme] };
      if (value.trim()) tokens[token] = value;
      else delete tokens[token];
      return { ...current, [theme]: tokens };
    });
  };

  return (
    <div className="space-y-6 pt-2">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Palette className="h-6 w-6 text-accent" aria-hidden="true" />
          <div>
            <h1 className="font-semibold text-text-primary text-xl">
              {t("branding.title", "Branding")}
            </h1>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "branding.subtitle",
                "Customize the app's global appearance (name, colors, logo, favicon).",
              )}
            </p>
          </div>
        </div>
        <Button
          onClick={() => void save()}
          loading={saving}
          disabled={loading || !dirty}
        >
          {t("branding.save", "Save branding")}
        </Button>
      </header>

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2" role="status">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      ) : (
        <>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-error bg-error-soft p-3 text-error text-sm"
            >
              {error}
            </p>
          )}
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)]">
            <div className="space-y-6">
              <Card className="space-y-4">
                <div>
                  <h2 className="font-semibold text-text-primary">
                    {t("branding.identity", "Identity")}
                  </h2>
                  <p className="text-sm text-text-muted">
                    {t(
                      "branding.identityHint",
                      "Names and footer links shown across the deployment.",
                    )}
                  </p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField
                    label={t("branding.brandName", "Brand name")}
                    error={refusal.at("brandName", form.brandName) ?? undefined}
                  >
                    <Input
                      value={form.brandName ?? ""}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          brandName: event.target.value || null,
                        })
                      }
                      maxLength={64}
                    />
                  </FormField>
                  <FormField
                    label={t("branding.siteUrl", "Website URL")}
                    error={refusal.at("siteUrl", form.siteUrl) ?? undefined}
                  >
                    <Input
                      type="url"
                      value={form.siteUrl ?? ""}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          siteUrl: event.target.value || null,
                        })
                      }
                      maxLength={512}
                    />
                  </FormField>
                  <FormField
                    label={t("branding.supportEmail", "Support email")}
                    error={
                      refusal.at("supportEmail", form.supportEmail) ?? undefined
                    }
                  >
                    <Input
                      type="email"
                      value={form.supportEmail ?? ""}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          supportEmail: event.target.value || null,
                        })
                      }
                      maxLength={254}
                    />
                  </FormField>
                  <FormField
                    label={t("branding.hideGithub", "Hide GitHub link")}
                    group
                  >
                    <div className="flex h-8 items-center">
                      <Switch
                        checked={form.hideGithubLink}
                        onCheckedChange={(checked) =>
                          setForm({ ...form, hideGithubLink: checked })
                        }
                        aria-label={t(
                          "branding.hideGithub",
                          "Hide GitHub link",
                        )}
                      />
                    </div>
                  </FormField>
                </div>
              </Card>

              <Card className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-text-primary">
                      {t("branding.colors", "Colors")}
                    </h2>
                    <p className="text-sm text-text-muted">
                      {t(
                        "branding.colorsHint",
                        "Use one brand color or tune each accent token by theme.",
                      )}
                    </p>
                  </div>
                  <SegmentedControl
                    value={form.colorMode}
                    onChange={(colorMode) => setForm({ ...form, colorMode })}
                    aria-label={t("branding.colorMode", "Color mode")}
                    options={[
                      {
                        value: "SIMPLE",
                        label: t("branding.simple", "Simple"),
                      },
                      {
                        value: "ADVANCED",
                        label: t("branding.advanced", "Advanced"),
                      },
                    ]}
                  />
                </div>
                {form.colorMode === "SIMPLE" ? (
                  <FormField
                    label={t("branding.brandColor", "Brand color")}
                    error={
                      refusal.at("brandColor", form.brandColor) ?? undefined
                    }
                    group
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        aria-label={t(
                          "branding.brandColorPicker",
                          "Brand color picker",
                        )}
                        value={
                          /^#[0-9a-f]{6}$/i.test(form.brandColor ?? "")
                            ? (form.brandColor as string)
                            : "#2563eb"
                        }
                        onChange={(event) =>
                          setForm({ ...form, brandColor: event.target.value })
                        }
                        className="h-9 w-12 rounded border border-border bg-bg-secondary"
                      />
                      <Input
                        value={form.brandColor ?? ""}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            brandColor: event.target.value || null,
                          })
                        }
                        placeholder="#2563eb"
                      />
                    </div>
                  </FormField>
                ) : (
                  <div className="grid gap-5 lg:grid-cols-2">
                    {(["tokensLight", "tokensDark"] as const).map((theme) => (
                      <div
                        key={theme}
                        className="space-y-3 rounded-lg border border-border bg-bg-tertiary/30 p-4"
                      >
                        <h3 className="font-medium text-text-primary">
                          {theme === "tokensLight"
                            ? t("branding.lightTheme", "Light theme")
                            : t("branding.darkTheme", "Dark theme")}
                        </h3>
                        {BRANDABLE_KEYS.map((token) => (
                          <FormField
                            key={token}
                            label={`${theme === "tokensLight" ? "Light" : "Dark"} ${tokenLabel(token)}`}
                          >
                            <Input
                              value={form[theme][token] ?? ""}
                              onChange={(event) =>
                                setToken(theme, token, event.target.value)
                              }
                              placeholder="#2563eb"
                            />
                          </FormField>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <Card className="h-fit space-y-4">
              <div>
                <h2 className="font-semibold text-text-primary">
                  {t("branding.assets", "Assets")}
                </h2>
                <p className="text-sm text-text-muted">
                  {t(
                    "branding.assetsHint",
                    "Provide dark and light variants. PNG, JPEG, WebP, SVG and ICO are accepted.",
                  )}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {(["logo", "mark", "favicon"] as const).flatMap((kind) =>
                  (["dark", "light"] as const).map((variant) => (
                    <AssetControl
                      key={`${kind}:${variant}`}
                      kind={kind}
                      variant={variant}
                      configured={data?.[kind][variant] ?? false}
                      version={data?.version ?? "0"}
                      busy={assetBusy === `${kind}:${variant}`}
                      onUpload={(file) => void upload(kind, variant, file)}
                      onRemove={() => void remove(kind, variant)}
                    />
                  )),
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

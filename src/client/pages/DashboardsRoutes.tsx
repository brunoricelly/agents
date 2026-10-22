import { Navigate } from "react-router";

// Em instâncias self-hosted, /dashboards redireciona diretamente para o Dashboard completo da plataforma.
// biome-ignore lint/plugin/require-page-container: a redirect renders no page content.
export function DashboardsRoutes() {
  return <Navigate to="/" replace />;
}

export function PublicDashboardRoute(_props: { tv?: boolean }) {
  return <Navigate to="/" replace />;
}

// biome-ignore lint/plugin/require-page-container: a redirect renders no page content.
export function DashboardTvRoute() {
  return <Navigate to="/" replace />;
}

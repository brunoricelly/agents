import { Navigate } from "react-router";

// Em instâncias self-hosted, /dashboards redireciona diretamente para o Dashboard completo da plataforma.
export function DashboardsRoutes() {
  return <Navigate to="/" replace />;
}

export function PublicDashboardRoute(_props: { tv?: boolean }) {
  return <Navigate to="/" replace />;
}

export function DashboardTvRoute() {
  return <Navigate to="/" replace />;
}

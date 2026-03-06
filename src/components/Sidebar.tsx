import { Link, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, Users, BarChart3, ClipboardList, Scan, UserCog, LogOut, Settings } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { ROLE_LABELS } from "@/lib/authStore";
import fazesLogo from "../../fazes-negro.jpeg";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard",  path: "/" },
  { icon: Users,           label: "Jugadores",  path: "/jugadores" },
  { icon: ClipboardList,   label: "Registros",  path: "/registros" },
  { icon: BarChart3,       label: "Análisis",   path: "/analisis" },
  { icon: Scan,            label: "Sprint 40m", path: "/sprint" },
];

const Sidebar = () => {
  const location = useLocation();
  const navigate  = useNavigate();
  const { user, logout, can } = useAuth();

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 border-r border-sidebar-border bg-sidebar flex flex-col">

      {/* Brand */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
        <img src={fazesLogo} alt="FAZES" className="h-10 w-10 rounded-xl object-cover shrink-0" />
        <div>
          <h1 className="font-display text-base font-bold text-foreground tracking-wide">FAZES</h1>
          <p className="text-xs text-muted-foreground">Análisis Deportivo</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-150 ${
                isActive
                  ? "bg-primary/12 text-primary glow-border"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <item.icon className={`h-4 w-4 shrink-0 ${isActive ? "text-primary" : ""}`} />
              {item.label}
            </Link>
          );
        })}

        {can("gestionar_usuarios") && (
          <>
            <Link
              to="/usuarios"
              className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-150 ${
                location.pathname === "/usuarios"
                  ? "bg-primary/12 text-primary glow-border"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <UserCog className={`h-4 w-4 shrink-0 ${location.pathname === "/usuarios" ? "text-primary" : ""}`} />
              Usuarios
            </Link>
            <Link
              to="/configuracion"
              className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-150 ${
                location.pathname === "/configuracion"
                  ? "bg-primary/12 text-primary glow-border"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <Settings className={`h-4 w-4 shrink-0 ${location.pathname === "/configuracion" ? "text-primary" : ""}`} />
              Configuración
            </Link>
          </>
        )}
      </nav>

      {/* Status footer */}
      <div className="p-4 mx-3 rounded-xl bg-surface border border-border">
        <p className="text-xs text-muted-foreground mb-1.5">Modelo IA</p>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary animate-pulse-glow shrink-0" />
          <span className="text-sm font-medium text-foreground">MediaPipe · Activo</span>
        </div>
      </div>

      {/* User strip */}
      {user && (
        <div className="px-3 py-3 border-t border-sidebar-border mt-2 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-bold shrink-0">
            {user.name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground truncate">{user.name}</p>
            <p className="text-xs text-muted-foreground">{ROLE_LABELS[user.role]}</p>
          </div>
          <button onClick={handleLogout} title="Cerrar sesión"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all shrink-0">
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;

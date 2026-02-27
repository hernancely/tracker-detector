import { Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Video, BarChart3, Zap, Timer } from "lucide-react";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/" },
  { icon: Users, label: "Jugadores", path: "/jugadores" },
  { icon: Video, label: "Videos", path: "/videos" },
  { icon: BarChart3, label: "Análisis", path: "/analisis" },
  { icon: Timer, label: "Cronómetro", path: "/cronometro" },
];

const Sidebar = () => {
  const location = useLocation();

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 border-r border-border bg-sidebar flex flex-col">
      <div className="flex items-center gap-3 px-6 py-6 border-b border-border">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
          <Zap className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <h1 className="font-display text-lg font-bold text-foreground">SprintLab</h1>
          <p className="text-xs text-muted-foreground">Análisis Deportivo</p>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-all duration-200 ${
                isActive
                  ? "bg-primary/10 text-primary glow-border"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 mx-3 mb-4 rounded-lg bg-surface border border-border">
        <p className="text-xs text-muted-foreground mb-1">Modelo IA</p>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary animate-pulse-glow" />
          <span className="text-sm font-medium text-foreground">Activo</span>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;

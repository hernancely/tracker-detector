import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/context/AuthContext";
import {
  getAllUsers, createUser, updateUser, deleteUser,
  AppUser, Role, ROLE_LABELS
} from "@/lib/authStore";
import { UserPlus, Trash2, Pencil, X, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";

const ROLES: Role[] = ["admin", "entrenador", "observador"];

function UserModal({
  editing,
  onClose,
  onSave,
}: {
  editing: AppUser | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const [username, setUsername] = useState(editing?.username ?? "");
  const [name,     setName]     = useState(editing?.name ?? "");
  const [role,     setRole]     = useState<Role>(editing?.role ?? "entrenador");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (editing) {
      updateUser(editing.id, {
        name,
        role,
        ...(password ? { password } : {}),
      });
      onSave();
    } else {
      if (!password) { setError("La contraseña es obligatoria"); return; }
      const res = createUser(username, password, name, role);
      if (!res.ok) { setError(res.error); return; }
      onSave();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl animate-slide-in">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display text-lg font-bold text-foreground">
            {editing ? "Editar usuario" : "Nuevo usuario"}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {!editing && (
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Usuario</label>
              <input required value={username} onChange={e => setUsername(e.target.value)} placeholder="usuario"
                className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all" />
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Nombre completo</label>
            <input required value={name} onChange={e => setName(e.target.value)} placeholder="Juan Pérez"
              className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Rol</label>
              <select value={role} onChange={e => setRole(e.target.value as Role)}
                className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all">
                {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                {editing ? "Nueva contraseña" : "Contraseña"}
              </label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder={editing ? "(sin cambios)" : "••••••••"}
                className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all" />
            </div>
          </div>
          {error && <p className="text-xs text-destructive font-medium">{error}</p>}
          <button type="submit"
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors mt-1">
            {editing ? "Guardar cambios" : "Crear usuario"}
          </button>
        </form>
      </div>
    </div>
  );
}

const ROLE_BADGE: Record<Role, string> = {
  admin:      "bg-primary/15 text-primary",
  entrenador: "bg-green-500/15 text-green-400",
  observador: "bg-muted/40 text-muted-foreground",
};

export default function Usuarios() {
  const { user: me, can } = useAuth();
  const navigate = useNavigate();

  if (!can("gestionar_usuarios")) {
    navigate("/", { replace: true });
    return null;
  }

  const [users, setUsers] = useState<AppUser[]>(getAllUsers);
  const [modal, setModal] = useState<"create" | AppUser | null>(null);

  function refresh() { setUsers(getAllUsers()); setModal(null); }

  function handleDelete(id: string) {
    deleteUser(id);
    setUsers(getAllUsers());
  }

  return (
    <DashboardLayout>
      {modal && (
        <UserModal
          editing={modal === "create" ? null : modal}
          onClose={() => setModal(null)}
          onSave={refresh}
        />
      )}

      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-foreground">Usuarios</h1>
          <p className="text-muted-foreground mt-1">{users.length} usuario{users.length !== 1 ? "s" : ""} registrado{users.length !== 1 ? "s" : ""}</p>
        </div>
        <button onClick={() => setModal("create")}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
          <UserPlus className="h-4 w-4" /> Nuevo usuario
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card card-elevated overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface/50">
              <th className="text-left py-3 px-5 text-muted-foreground font-medium">Nombre</th>
              <th className="text-left py-3 px-5 text-muted-foreground font-medium">Usuario</th>
              <th className="text-left py-3 px-5 text-muted-foreground font-medium">Rol</th>
              <th className="text-left py-3 px-5 text-muted-foreground font-medium">Permisos</th>
              <th className="py-3 px-5" />
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-border/50 hover:bg-surface/50 transition-colors">
                <td className="py-3 px-5 font-medium text-foreground">
                  <div className="flex items-center gap-2">
                    {u.id === me?.id && <ShieldCheck className="h-3.5 w-3.5 text-primary shrink-0" title="Tu cuenta" />}
                    {u.name}
                  </div>
                </td>
                <td className="py-3 px-5 text-muted-foreground font-mono text-xs">{u.username}</td>
                <td className="py-3 px-5">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${ROLE_BADGE[u.role]}`}>
                    {ROLE_LABELS[u.role]}
                  </span>
                </td>
                <td className="py-3 px-5 text-xs text-muted-foreground max-w-xs">
                  {u.role === "admin" ? "Acceso total" : u.role === "entrenador" ? "Crear jugadores, analizar y guardar sprints, ver registros" : "Solo lectura"}
                </td>
                <td className="py-3 px-5">
                  <div className="flex items-center gap-1 justify-end">
                    <button onClick={() => setModal(u)}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface transition-all" title="Editar">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {u.id !== me?.id && (
                      <button onClick={() => handleDelete(u.id)}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all" title="Eliminar">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardLayout>
  );
}

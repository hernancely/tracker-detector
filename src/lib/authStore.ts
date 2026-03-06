export type Role = "admin" | "entrenador" | "observador";

export type Permission =
  | "crear_jugador"
  | "eliminar_jugador"
  | "analizar_sprint"
  | "guardar_sprint"
  | "ver_registros"
  | "gestionar_usuarios";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin:      ["crear_jugador","eliminar_jugador","analizar_sprint","guardar_sprint","ver_registros","gestionar_usuarios"],
  entrenador: ["crear_jugador","analizar_sprint","guardar_sprint","ver_registros"],
  observador: ["ver_registros"],
};

export const ROLE_LABELS: Record<Role, string> = {
  admin:      "Administrador",
  entrenador: "Entrenador",
  observador: "Observador",
};

export interface AppUser {
  id: string;
  username: string;
  passwordHash: string;
  name: string;
  role: Role;
  createdAt: string;
}

const USERS_KEY   = "sprintlab_users";
const SESSION_KEY = "sprintlab_session";

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function hashPassword(password: string): string {
  // Simple deterministic hash for localStorage MVP (not for production)
  let h = 0;
  const s = password + "fazes_salt_2024";
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(36);
}

function getUsers(): AppUser[] {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveUsers(users: AppUser[]): void {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function seed(): void {
  const users = getUsers();
  if (users.length > 0) return;
  const admin: AppUser = {
    id:           generateId(),
    username:     "admin",
    passwordHash: hashPassword("admin123"),
    name:         "Administrador",
    role:         "admin",
    createdAt:    new Date().toISOString(),
  };
  saveUsers([admin]);
}

// Always ensure seed exists on module load
seed();

// ── Public API ────────────────────────────────────────────────────────────────

export function getAllUsers(): AppUser[] {
  return getUsers();
}

export function createUser(
  username: string,
  password: string,
  name: string,
  role: Role
): { ok: true; user: AppUser } | { ok: false; error: string } {
  const users = getUsers();
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return { ok: false, error: "El nombre de usuario ya existe" };
  }
  const user: AppUser = {
    id:           generateId(),
    username:     username.trim(),
    passwordHash: hashPassword(password),
    name:         name.trim(),
    role,
    createdAt:    new Date().toISOString(),
  };
  saveUsers([...users, user]);
  return { ok: true, user };
}

export function updateUser(
  id: string,
  updates: Partial<Pick<AppUser, "name" | "role">> & { password?: string }
): boolean {
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return false;
  if (updates.name)     users[idx].name = updates.name;
  if (updates.role)     users[idx].role = updates.role;
  if (updates.password) users[idx].passwordHash = hashPassword(updates.password);
  saveUsers(users);
  return true;
}

export function deleteUser(id: string): boolean {
  const users = getUsers();
  const admins = users.filter(u => u.role === "admin");
  const target = users.find(u => u.id === id);
  if (!target) return false;
  if (target.role === "admin" && admins.length <= 1) return false; // keep ≥1 admin
  saveUsers(users.filter(u => u.id !== id));
  return true;
}

export function login(username: string, password: string): AppUser | null {
  const users = getUsers();
  const user = users.find(
    u => u.username.toLowerCase() === username.toLowerCase()
      && u.passwordHash === hashPassword(password)
  );
  if (!user) return null;
  localStorage.setItem(SESSION_KEY, user.id);
  return user;
}

export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function getSession(): AppUser | null {
  const id = localStorage.getItem(SESSION_KEY);
  if (!id) return null;
  return getUsers().find(u => u.id === id) ?? null;
}

export function can(user: AppUser | null, permission: Permission): boolean {
  if (!user) return false;
  return ROLE_PERMISSIONS[user.role].includes(permission);
}

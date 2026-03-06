import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { AppUser, Permission, login as storeLogin, logout as storeLogout, getSession, can as storeCan } from "@/lib/authStore";

interface AuthContextValue {
  user: AppUser | null;
  login: (username: string, password: string) => boolean;
  logout: () => void;
  can: (permission: Permission) => boolean;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(getSession);

  const login = useCallback((username: string, password: string): boolean => {
    const u = storeLogin(username, password);
    if (!u) return false;
    setUser(u);
    return true;
  }, []);

  const logout = useCallback(() => {
    storeLogout();
    setUser(null);
  }, []);

  const can = useCallback((permission: Permission) => storeCan(user, permission), [user]);

  const refresh = useCallback(() => setUser(getSession()), []);

  return (
    <AuthContext.Provider value={{ user, login, logout, can, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

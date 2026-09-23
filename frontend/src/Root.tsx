import { useEffect, useState } from "react";
import { api, getToken, setToken, type User } from "./api";
import App from "./App";
import Admin from "./components/Admin";
import Login from "./components/Login";

export default function Root() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<"dashboard" | "admin">("dashboard");

  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    api
      .me()
      .then((u) => setUser(u))
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const expired = () => {
      setToken(null);
      setUser(null);
    };
    window.addEventListener("auth:expired", expired);
    return () => window.removeEventListener("auth:expired", expired);
  }, []);

  function logout() {
    api.logout().catch(() => undefined);
    setUser(null);
    setView("dashboard");
  }

  if (checking) return <div className="grid min-h-screen place-items-center bg-page text-sm text-zinc-500">Загрузка…</div>;
  if (!user) return <Login onLogin={setUser} />;
  if (view === "admin" && user.role === "admin") return <Admin user={user} onBack={() => setView("dashboard")} onLogout={logout} />;
  return <App user={user} onLogout={logout} onAdmin={() => setView("admin")} />;
}

import { useState } from "react";
import { api, type User } from "../api";

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onLogin(await api.login(username, password));
    } catch (e2) {
      setErr((e2 as Error).message === "неверный логин или пароль" ? "Неверный логин или пароль" : `Не удалось войти: ${(e2 as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function demo(u: string, p: string) {
    setUsername(u);
    setPassword(p);
  }

  return (
    <div className="flex min-h-screen flex-col bg-page">
      <div className="border-b-[3px] border-accent-400 bg-brand-900 px-4 py-1.5 text-center text-xs text-white sm:px-6">Сервис отдела закупа · автоматический расчёт заказов поставщикам</div>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <form onSubmit={submit} className="w-full max-w-sm rounded-md border border-zinc-200 bg-white p-6 shadow-sm">
          <img src="/ekt-logo.svg" alt="Группа компаний Электрокомплект" className="h-10 w-auto" />
          <h1 className="mt-5 text-xl font-bold text-brand-900">Вход в систему</h1>
          <p className="mt-1 text-sm text-zinc-500">Заказы поставщикам: расчёт, обоснование, утверждение.</p>
          <label className="mt-5 flex flex-col gap-1 text-xs font-medium text-zinc-600">
            Логин
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </label>
          <label className="mt-3 flex flex-col gap-1 text-xs font-medium text-zinc-600">
            Пароль
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </label>
          {err && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
          <button disabled={busy || !username || !password} className="mt-5 w-full rounded-md bg-accent-400 py-2.5 text-sm font-bold text-brand-900 hover:bg-accent-500 disabled:opacity-50">
            {busy ? "Вход…" : "Войти"}
          </button>
          <div className="mt-5 rounded-md bg-zinc-50 p-3 text-xs text-zinc-600">
            <div className="font-semibold text-zinc-700">Демо-доступ для проверки</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              <button type="button" onClick={() => demo("manager", "demo")} className="rounded-md border border-zinc-300 bg-white px-2 py-1 hover:bg-zinc-100">
                закупщик: manager / demo
              </button>
              <button type="button" onClick={() => demo("admin", "admin")} className="rounded-md border border-zinc-300 bg-white px-2 py-1 hover:bg-zinc-100">
                администратор: admin / admin
              </button>
            </div>
          </div>
        </form>
      </main>
      <footer className="px-4 pb-6 text-center text-xs text-zinc-500">прототип HackAlem AI 2026 · команда Ads Tech</footer>
    </div>
  );
}

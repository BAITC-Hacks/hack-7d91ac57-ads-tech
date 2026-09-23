import { useEffect, useMemo, useState } from "react";
import { api, fmt, type AdminIntegrations, type AuditResponse, type User } from "../api";

type Tab = "integrations" | "audit" | "users";

export default function Admin({ user, onBack, onLogout }: { user: User; onBack: () => void; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("integrations");
  const [data, setData] = useState<AdminIntegrations | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onec, setOnec] = useState({ enabled: false, base_url: "", username: "", password: "" });
  const [b24, setB24] = useState({ enabled: false, webhook_url: "", bot_name: "Закупщик" });
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string; ms: number }>>({});
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [fUser, setFUser] = useState("");
  const [fAction, setFAction] = useState("");
  const [q, setQ] = useState("");

  async function load() {
    try {
      const d = await api.adminIntegrations();
      setData(d);
      setOnec({ enabled: d.onec.enabled, base_url: d.onec.base_url, username: d.onec.username, password: d.onec.password });
      setB24({ enabled: d.bitrix24.enabled, webhook_url: d.bitrix24.webhook_url, bot_name: d.bitrix24.bot_name });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function loadAudit() {
    try {
      setAudit(await api.audit({ user: fUser || undefined, action: fAction || undefined, limit: 500 }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (tab === "audit") loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, fUser, fAction]);

  async function save(name: "onec" | "bitrix24") {
    setBusy(`save-${name}`);
    try {
      await api.saveIntegration(name, name === "onec" ? onec : b24);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function test(name: "onec" | "bitrix24" | "llm") {
    setBusy(`test-${name}`);
    try {
      const r = await api.testIntegration(name);
      setTests((t) => ({ ...t, [name]: r }));
      await load();
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { ok: false, message: (e as Error).message, ms: 0 } }));
    } finally {
      setBusy(null);
    }
  }

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (audit?.items ?? []).filter((i) => !s || JSON.stringify(i).toLowerCase().includes(s));
  }, [audit, q]);
  const botUrl = `${window.location.origin}${data?.bot_events_path ?? "/api/integrations/bitrix24/bot"}`;

  return (
    <div className="min-h-screen bg-page text-zinc-900">
      <header className="border-b-[3px] border-accent-400 bg-white shadow-sm">
        <div className="bg-brand-900 text-white">
          <div className="mx-auto flex max-w-[1300px] flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-1.5 text-xs sm:px-6">
            <span className="font-medium">Администрирование сервиса закупа</span>
            <span className="text-white/70">прототип HackAlem AI 2026 · команда Ads Tech</span>
          </div>
        </div>
        <div className="mx-auto flex max-w-[1300px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-4">
            <img src="/ekt-logo.svg" alt="Группа компаний Электрокомплект" className="h-8 w-auto sm:h-9" />
            <div className="border-l border-zinc-200 pl-4">
              <h1 className="text-lg font-bold leading-tight text-brand-900">Администрирование</h1>
              <p className="text-xs text-zinc-500">интеграции, журнал действий, пользователи</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button onClick={onBack} className="rounded-md bg-brand-600 px-3 py-1.5 font-semibold text-white hover:bg-brand-900">
              К заказам
            </button>
            <span className="text-zinc-600">
              {user.name} · {user.role_label ?? user.role}
            </span>
            <button onClick={onLogout} className="rounded-md border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-50">
              Выйти
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1300px] space-y-5 px-4 py-6 sm:px-6">
        {err && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Ошибка: {err}</p>}
        <nav className="flex gap-1 overflow-x-auto border-b border-zinc-200" aria-label="Разделы администрирования">
          {(
            [
              ["integrations", "Интеграции"],
              ["audit", "Журнал действий"],
              ["users", "Пользователи и роли"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} aria-current={tab === id} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === id ? "border-brand-600 text-brand-900" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}>
              {label}
            </button>
          ))}
        </nav>

        {tab === "integrations" && data && (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="1С:Предприятие (OData)" status={data.onec.status} checked={data.onec.checked_at} message={tests.onec?.message ?? data.onec.message}>
              <p className="text-xs text-zinc-600">Чтение номенклатуры, продаж, остатков и заказов поставщику через стандартный интерфейс OData; запись утверждённого заказа документом «Заказ поставщику». Сейчас данные загружаются выгрузками xlsx/CSV.</p>
              <Toggle label="Интеграция включена" value={onec.enabled} onChange={(v) => setOnec({ ...onec, enabled: v })} />
              <Input label="Адрес OData" value={onec.base_url} placeholder="http://1c-server/base/odata/standard.odata" onChange={(v) => setOnec({ ...onec, base_url: v })} />
              <div className="grid grid-cols-2 gap-2">
                <Input label="Пользователь 1С" value={onec.username} onChange={(v) => setOnec({ ...onec, username: v })} />
                <Input label="Пароль" type="password" value={onec.password} onChange={(v) => setOnec({ ...onec, password: v })} />
              </div>
              <Buttons busy={busy} name="onec" onSave={() => save("onec")} onTest={() => test("onec")} />
            </Card>

            <Card title="Bitrix24: чат-бот «Закупщик»" status={data.bitrix24.status} checked={data.bitrix24.checked_at} message={tests.bitrix24?.message ?? data.bitrix24.message}>
              <p className="text-xs text-zinc-600">Сотрудники задают вопросы нашему ассистенту прямо в мессенджере Bitrix24; утренняя сводка агента приходит в чат отдела закупа; утверждение заказа может создавать задачу ответственному.</p>
              <Toggle label="Интеграция включена" value={b24.enabled} onChange={(v) => setB24({ ...b24, enabled: v })} />
              <Input label="Входящий вебхук портала" value={b24.webhook_url} placeholder="https://company.bitrix24.kz/rest/1/xxxxxxxx/" onChange={(v) => setB24({ ...b24, webhook_url: v })} />
              <Input label="Имя бота" value={b24.bot_name} onChange={(v) => setB24({ ...b24, bot_name: v })} />
              <div className="rounded-md bg-zinc-50 p-2 text-[11px] text-zinc-600">
                Адрес обработчика событий бота (ONIMBOTMESSAGEADD): <span className="break-all font-mono text-zinc-800">{botUrl}</span>
                <div className="mt-1 text-amber-700">Обработчик событий бота — следующий этап внедрения; проверка вебхука работает уже сейчас.</div>
              </div>
              <Buttons busy={busy} name="bitrix24" onSave={() => save("bitrix24")} onTest={() => test("bitrix24")} />
            </Card>

            <Card title="Языковая модель ассистента" status={data.llm.demo_mode ? "DEMO: без модели" : data.llm.key_configured ? "настроено" : "нет ключа"} checked={null} message={tests.llm?.message ?? ""}>
              <p className="text-xs text-zinc-600">Модель только объясняет расчёт через инструменты движка и не считает цифры. Подходит любой OpenAI-совместимый провайдер, в том числе локальная модель на сервере компании.</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-zinc-500">Провайдер</dt>
                <dd className="break-all">{data.llm.provider}</dd>
                <dt className="text-zinc-500">Модель</dt>
                <dd>{data.llm.model}</dd>
                <dt className="text-zinc-500">Ключ</dt>
                <dd>{data.llm.key_configured ? "задан в .env" : "не задан"}</dd>
              </dl>
              <p className="text-[11px] text-zinc-500">Меняется в .env: LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, DEMO_MODE.</p>
              <div className="flex gap-2">
                <button onClick={() => test("llm")} disabled={busy !== null} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
                  {busy === "test-llm" ? "Проверяю…" : "Проверить ответ модели"}
                </button>
              </div>
            </Card>
          </div>
        )}

        {tab === "audit" && (
          <section className="space-y-3">
            {audit && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Mini label="Всего действий" value={fmt(audit.summary.total)} />
                <Mini label="Расчётов" value={fmt(audit.summary.by_action["Расчёт заказов"] ?? 0)} />
                <Mini label="Утверждено заказов" value={fmt(audit.summary.by_action["Утверждение заказа"] ?? 0)} />
                <Mini label="Вопросов ассистенту" value={fmt(audit.summary.by_action["Вопрос ассистенту"] ?? 0)} />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <select value={fAction} onChange={(e) => setFAction(e.target.value)} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm" aria-label="Действие">
                <option value="">Все действия</option>
                {Object.entries(audit?.actions ?? {}).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <select value={fUser} onChange={(e) => setFUser(e.target.value)} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm" aria-label="Пользователь">
                <option value="">Все пользователи</option>
                {Object.keys(audit?.summary.by_user ?? {}).map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по журналу" className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm" />
              <button onClick={loadAudit} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">
                Обновить
              </button>
              <a href={api.auditCsvUrl({ user: fUser || undefined, action: fAction || undefined })} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 sm:ml-auto">
                Выгрузить CSV
              </a>
            </div>
            <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  <tr className="border-b border-zinc-200">
                    <th className="px-4 py-2">Время</th>
                    <th className="px-2 py-2">Пользователь</th>
                    <th className="px-2 py-2">Действие</th>
                    <th className="px-2 py-2">Подробности</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i, k) => (
                    <tr key={k} className="border-b border-zinc-100 align-top">
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-zinc-600">{i.ts.replace("T", " ")}</td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <div>{i.name || i.user}</div>
                        <div className="text-xs text-zinc-500">{i.user}</div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <span className={`inline-block h-2 w-2 rounded-full align-middle ${i.ok ? "bg-emerald-500" : "bg-red-500"}`} /> <span className="font-medium">{i.label}</span>
                      </td>
                      <td className="px-2 py-2 text-xs text-zinc-600">{describe(i.details)}</td>
                    </tr>
                  ))}
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-zinc-500">
                        Записей нет
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500">Журнал хранится на сервере в data/audit.jsonl и дополняется при каждом действии: вход, расчёт, утверждение, экспорт, импорт, вопросы ассистенту, настройки интеграций.</p>
          </section>
        )}

        {tab === "users" && data && (
          <section className="space-y-3">
            <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  <tr className="border-b border-zinc-200">
                    <th className="px-4 py-2">Логин</th>
                    <th className="px-2 py-2">Имя</th>
                    <th className="px-2 py-2">Роль</th>
                    <th className="px-2 py-2">Доступ</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.username} className="border-b border-zinc-100">
                      <td className="px-4 py-2 font-mono">{u.username}</td>
                      <td className="px-2 py-2">{u.name}</td>
                      <td className="px-2 py-2">{u.role_label}</td>
                      <td className="px-2 py-2 text-xs text-zinc-600">{u.role === "admin" ? "всё, включая интеграции и журнал действий" : "расчёт, обоснование, утверждение, экспорт, ассистент"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500">Пользователи задаются переменной AUTH_USERS в .env. В промышленной эксплуатации вход через учётные записи Bitrix24 (OAuth) или корпоративный каталог.</p>
          </section>
        )}
      </main>
    </div>
  );
}

function describe(d: Record<string, unknown>): string {
  const map: Record<string, string> = {
    warehouse: "склад",
    category: "категория",
    positions: "позиций",
    critical: "критичных",
    calibrated: "калибровка",
    service_level: "уровень сервиса",
    order_id: "заказ",
    supplier: "поставщик",
    lines: "строк",
    total_qty: "штук",
    format: "формат",
    rows: "строк",
    question: "вопрос",
    tools: "инструменты",
    sku: "артикул",
    from: "было",
    to: "стало",
    integration: "интеграция",
    message: "результат",
    files: "файлов",
    products: "артикулов",
    sales_rows: "строк продаж",
    table: "таблица",
    file: "файл",
    llm: "LLM",
    steps: "шаги",
    enabled: "включена",
  };
  return Object.entries(d || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${map[k] ?? k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? "да" : "нет") : String(v)}`)
    .join(" · ");
}

function Card({ title, status, checked, message, children }: { title: string; status: string; checked: string | null; message: string; children: React.ReactNode }) {
  const tone = status === "подключено" || status === "настроено" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : status === "ошибка" ? "bg-red-50 text-red-700 ring-red-200" : "bg-zinc-100 text-zinc-600 ring-zinc-200";
  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-brand-900">{title}</h2>
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ring-1 ${tone}`}>{status}</span>
      </div>
      {children}
      {(message || checked) && (
        <p className="text-[11px] text-zinc-500">
          {message}
          {checked ? ` · проверено ${checked.replace("T", " ")}` : ""}
        </p>
      )}
    </section>
  );
}

function Input({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
      {label}
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500" />
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-700">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#2c7294]" />
      {label}
    </label>
  );
}

function Buttons({ busy, name, onSave, onTest }: { busy: string | null; name: string; onSave: () => void; onTest: () => void }) {
  return (
    <div className="mt-auto flex gap-2 pt-1">
      <button onClick={onSave} disabled={busy !== null} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-900 disabled:opacity-50">
        {busy === `save-${name}` ? "Сохраняю…" : "Сохранить"}
      </button>
      <button onClick={onTest} disabled={busy !== null} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
        {busy === `test-${name}` ? "Проверяю…" : "Проверить соединение"}
      </button>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-brand-900">{value}</div>
    </div>
  );
}

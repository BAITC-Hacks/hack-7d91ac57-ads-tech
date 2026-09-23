import { useEffect, useState } from "react";
import { api, type ChatStep, type NewsItem } from "../api";
import AgentSteps from "./AgentSteps";

const DIR_TONE: Record<string, string> = {
  "рост спроса": "bg-emerald-100 text-emerald-800",
  "спад спроса": "bg-zinc-200 text-zinc-700",
  "риск поставок": "bg-red-100 text-red-800",
  "рост цен": "bg-amber-100 text-amber-800",
  нейтрально: "bg-zinc-100 text-zinc-600",
};

export default function NewsTab() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [fields, setFields] = useState<{ key: string; label: string }[]>([]);
  const [steps, setSteps] = useState<ChatStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showFields, setShowFields] = useState(false);

  const load = () =>
    api
      .news()
      .then((r) => {
        setItems(r.items);
        setFields(r.fields);
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function refresh() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.refreshNews();
      setSteps(r.steps);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="text-sm font-semibold text-brand-900">Агент мониторинга СМИ: рынок, цены, стройка, логистика</h2>
          <p className="mt-1 text-xs text-zinc-600">
            Агент собирает новостные ленты Казахстана, оставляет то, что влияет на спрос, цены или поставки электротоваров, и заполняет фиксированные поля. На расчёт не влияет автоматически: подсказывает закупщику, где проверить запас или прайс.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowFields(!showFields)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50">
            Поля, которые заполняет агент
          </button>
          <button onClick={refresh} disabled={busy} className="rounded-md bg-accent-400 px-4 py-1.5 text-xs font-bold text-brand-900 hover:bg-accent-500 disabled:opacity-50">
            {busy ? "Агент собирает новости…" : "Обновить мониторинг"}
          </button>
        </div>
      </div>
      {showFields && (
        <ul className="grid gap-x-6 gap-y-1 rounded-md bg-zinc-50 p-3 text-xs text-zinc-700 sm:grid-cols-2">
          {fields.map((f) => (
            <li key={f.key}>
              <span className="font-mono text-[10px] text-zinc-400">{f.key}</span> {f.label}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Ошибка: {err}</p>}
      <AgentSteps steps={steps} title="Что сделал агент" />
      {items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left uppercase tracking-wide text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="py-1.5 pr-2">Дата, источник</th>
                <th className="py-1.5 pr-2">Новость</th>
                <th className="py-1.5 pr-2">Тема</th>
                <th className="py-1.5 pr-2">Влияние</th>
                <th className="py-1.5 pr-2">Категории, поставщики</th>
                <th className="py-1.5">Что сделать закупщику</th>
              </tr>
            </thead>
            <tbody>
              {items.map((n) => (
                <tr key={n.id} className="border-b border-zinc-100 align-top">
                  <td className="whitespace-nowrap py-1.5 pr-2 text-zinc-600">
                    {n.date}
                    <div className="text-[10px] text-zinc-400">{n.source}</div>
                  </td>
                  <td className="max-w-[340px] py-1.5 pr-2">
                    <a href={n.url} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">{n.title}</a>
                    <div className="mt-0.5 line-clamp-2 text-zinc-500">{n.summary}</div>
                  </td>
                  <td className="py-1.5 pr-2">{n.topic}</td>
                  <td className="whitespace-nowrap py-1.5 pr-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] ${DIR_TONE[n.direction] ?? DIR_TONE["нейтрально"]}`}>{n.direction}</span>
                    <div className="mt-0.5 text-[10px] text-zinc-400">сила {n.strength} · {n.horizon} · релевантность {Math.round((n.relevance || 0) * 100)} %</div>
                  </td>
                  <td className="py-1.5 pr-2 text-zinc-600">{[...(n.categories || []), ...(n.suppliers || [])].join(", ") || "—"}</td>
                  <td className="py-1.5 text-zinc-700">
                    {n.action}
                    <div className="text-[10px] text-zinc-400">{n.region} · извлечено: {n.extracted_by}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">Мониторинг ещё не запускался. Нажмите «Обновить мониторинг».</p>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import { api, fmt, type ChatStep, type SignalsResponse } from "../api";
import AgentSteps from "./AgentSteps";

const TYPE_TONE: Record<string, string> = {
  "крупный разовый заказ": "bg-brand-100 text-brand-900",
  "регулярный рост": "bg-emerald-100 text-emerald-800",
  "снижение или отказ": "bg-red-100 text-red-800",
  "перенос сроков": "bg-amber-100 text-amber-800",
  "цены и условия поставщика": "bg-accent-300/40 text-brand-900",
  "проблема у поставщика": "bg-red-50 text-red-700",
  другое: "bg-zinc-100 text-zinc-700",
};

export default function SignalsTab({ onOpenSku, onChanged }: { onOpenSku: (sku: string) => void; onChanged: () => void }) {
  const [data, setData] = useState<SignalsResponse | null>(null);
  const [steps, setSteps] = useState<ChatStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [channel, setChannel] = useState("");

  const load = () => api.signals().then(setData).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function runImport(kind: "files" | "sample" | "text", files: File[] = []) {
    setBusy(true);
    setErr(null);
    try {
      const r = kind === "sample" ? await api.importSignalsSample() : await api.importSignals(files, kind === "text" ? text : "", channel);
      setSteps(r.steps);
      setText("");
      await load();
      onChanged();
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
          <h2 className="text-sm font-semibold text-brand-900">Агент сигналов продаж: чаты менеджеров Bitrix24, WhatsApp, Telegram</h2>
          <p className="mt-1 text-xs text-zinc-600">
            Агент читает переписку продажников и находит то, чего нет в истории продаж: планируемые крупные заказы, рост у клиентов, отказы, переносы, новости о ценах и сроках поставщиков. Каждый сигнал привязывается к артикулу, клиенты обезличиваются. В регулярный спрос сигналы не входят, в заказ их можно добавить галочкой «Учитывать сигналы продаж».
          </p>
        </div>
        {data && data.summary.total > 0 && (
          <button onClick={() => api.clearSignals().then(() => { load(); onChanged(); setSteps([]); })} className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50">
            Очистить сигналы
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-md bg-zinc-50 p-3 text-xs text-zinc-700">
          <div className="font-semibold text-brand-900">Загрузить выгрузку чата</div>
          <p className="mt-1 text-zinc-600">Telegram: «Экспорт чата» в JSON. WhatsApp: «Экспорт чата» без медиа (.txt). Bitrix24: CSV или JSON с колонками дата, автор, сообщение.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs" aria-label="Канал">
              <option value="">канал определить по файлу</option>
              <option value="Bitrix24">Bitrix24</option>
              <option value="WhatsApp">WhatsApp</option>
              <option value="Telegram">Telegram</option>
            </select>
            <label className="cursor-pointer rounded-md bg-brand-900 px-3 py-1.5 font-medium text-white hover:bg-brand-700">
              {busy ? "Агент работает…" : "Выбрать файлы"}
              <input type="file" multiple accept=".json,.txt,.csv" className="hidden" disabled={busy} onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) runImport("files", fs); }} />
            </label>
            <button onClick={() => runImport("sample")} disabled={busy} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
              Загрузить пример из трёх каналов
            </button>
          </div>
        </div>
        <div className="rounded-md bg-zinc-50 p-3 text-xs text-zinc-700">
          <div className="font-semibold text-brand-900">Или вставить сообщения</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="18.09.2026, 10:00 - Айдос: ТОО «Ромашка» берёт 300 шт УЗО ВД1 63 32А в октябре, договор подписали" className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs" />
          <button onClick={() => runImport("text")} disabled={busy || !text.trim()} className="mt-1 rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-900 disabled:opacity-50">
            Разобрать
          </button>
        </div>
      </div>

      {err && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Ошибка: {err}</p>}
      <AgentSteps steps={steps} title="Что сделал агент" />

      {data && data.summary.total > 0 ? (
        <>
          <p className="text-xs text-zinc-600">
            Сигналов: <b>{fmt(data.summary.total)}</b>, привязано к артикулам: <b>{fmt(data.summary.linked)}</b> · {Object.entries(data.summary.by_channel).map(([k, v]) => `${k}: ${v}`).join(" · ")}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left uppercase tracking-wide text-zinc-500">
                <tr className="border-b border-zinc-200">
                  <th className="py-1.5 pr-2">Дата, канал</th>
                  <th className="py-1.5 pr-2">Тип</th>
                  <th className="py-1.5 pr-2">Товар</th>
                  <th className="py-1.5 pr-2 text-right">Кол-во</th>
                  <th className="py-1.5 pr-2">Когда</th>
                  <th className="py-1.5 pr-2 text-right">Вероятность</th>
                  <th className="py-1.5">Сообщение (клиент обезличен)</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.id} className="border-b border-zinc-100 align-top">
                    <td className="whitespace-nowrap py-1.5 pr-2 text-zinc-600">
                      {s.date || "—"}
                      <div className="text-[10px] text-zinc-400">{s.channel} · {s.manager || "—"}</div>
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] ${TYPE_TONE[s.type] ?? TYPE_TONE["другое"]}`}>{s.type}</span>
                    </td>
                    <td className="max-w-[260px] py-1.5 pr-2">
                      {s.sku ? (
                        <>
                          <button className="font-mono text-brand-600 hover:underline" onClick={() => onOpenSku(s.sku!)}>{s.sku}</button>
                          <div className="truncate text-zinc-700" title={s.sku_name ?? ""}>{s.sku_name}</div>
                        </>
                      ) : (
                        <span className="text-zinc-400">не привязан к артикулу</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-right tabular-nums">{s.qty != null ? fmt(s.qty) : "—"}</td>
                    <td className="whitespace-nowrap py-1.5 pr-2">{s.expected_month ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{Math.round(s.probability * 100)} %</td>
                    <td className="py-1.5 text-zinc-600">
                      {s.quote}
                      <div className="text-[10px] text-zinc-400">{s.client ? `${s.client} · ` : ""}извлечено: {s.extracted_by}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">Сигналов пока нет. Загрузите выгрузку чата или пример.</p>
      )}
    </section>
  );
}

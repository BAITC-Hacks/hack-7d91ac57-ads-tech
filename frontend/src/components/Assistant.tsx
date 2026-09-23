import { useState } from "react";
import { api, type ChatStep, type Msg } from "../api";

const SUGGESTIONS = (sku?: string) => [
  sku ? `Почему по ${sku} такое количество?` : "Почему такое количество по самой критичной позиции?",
  "Покажи критичные позиции по IEK",
  sku ? `Что если по ${sku} в пути придёт ещё 200?` : "Что если по критичной позиции в пути придёт ещё 200?",
  "Подготовь черновик письма поставщику Systeme Electric",
];

export default function Assistant({ focusSku, demoMode }: { focusSku?: string; demoMode: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<ChatStep[]>([]);
  const [latency, setLatency] = useState<number | null>(null);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: t }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const res = await api.chat(next);
      setMsgs([...next, { role: "assistant", content: res.answer }]);
      setSteps(res.steps);
      setLatency(res.latency_ms);
    } catch (e) {
      setMsgs([...next, { role: "assistant", content: `Ошибка: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex h-full flex-col rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Ассистент закупщика</h2>
          <p className="text-xs text-zinc-500">{demoMode ? "DEMO: ответы по шаблонам через инструменты, без LLM" : "LLM + инструменты движка"}</p>
        </div>
        {latency !== null && <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">{latency} мс</span>}
      </div>
      <div className="flex min-h-[260px] flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {msgs.length === 0 && <p className="text-sm text-zinc-400">Спросите, почему рекомендовано именно такое количество, или что изменится при новых поставках.</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`max-w-[92%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "self-end bg-indigo-600 text-white" : "self-start bg-zinc-100 text-zinc-800"}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="self-start text-sm text-zinc-400">думает…</div>}
      </div>
      {steps.length > 0 && (
        <div className="border-t border-zinc-200 px-4 py-2">
          <div className="mb-1 text-xs font-semibold text-zinc-600">Шаги агента</div>
          <ul className="space-y-1">
            {steps.map((s, i) => (
              <li key={i} className="rounded border border-zinc-200 bg-zinc-50 p-2">
                <div className="font-mono text-xs text-indigo-700">{s.tool}<span className="text-zinc-400"> {s.args}</span></div>
                <div className="line-clamp-2 font-mono text-[11px] text-zinc-500">{s.result}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="border-t border-zinc-200 px-4 py-3">
        <div className="mb-2 flex flex-wrap gap-1">
          {SUGGESTIONS(focusSku).map((s) => (
            <button key={s} onClick={() => send(s)} disabled={busy} className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Вопрос ассистенту" />
          <button className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy}>
            →
          </button>
        </form>
      </div>
    </aside>
  );
}

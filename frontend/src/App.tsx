import React, { useEffect, useState } from "react";
import { chat, health, uploadDocument, type Msg } from "./api";

export default function App() {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<{ tool: string; result: string }[]>([]);
  const [docs, setDocs] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    try {
      const res = await uploadDocument(f);
      setDocs((d) => [...d, `${res.source} (${res.chunks})`]);
    } catch (err) {
      setDocs((d) => [...d, `Ошибка: ${(err as Error).message}`]);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  useEffect(() => {
    health().then(setStatus).catch(() => setStatus({ status: "backend unreachable" }));
  }, []);

  async function send() {
    if (!input.trim() || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: input.trim() }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const res = await chat(next);
      setMsgs([...next, { role: "assistant", content: res.answer }]);
      setSteps(res.steps);
    } catch (e) {
      setMsgs([...next, { role: "assistant", content: `Ошибка: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b bg-white px-6 py-4">
        <h1 className="text-xl font-semibold">HackAlem App</h1>
        <p className="text-sm text-zinc-500">
          backend: {String(status?.status ?? "…")} · model: {String(status?.model ?? "")}
          {status?.demo_mode ? " · DEMO MODE" : ""}
        </p>
      </header>
      <main className="mx-auto grid max-w-5xl gap-6 p-6 md:grid-cols-[2fr_1fr]">
        <section className="flex flex-col gap-3 rounded-xl border bg-white p-4">
          <div className="flex min-h-[50vh] flex-col gap-2 overflow-y-auto">
            {msgs.length === 0 && <p className="text-zinc-400">Напишите сообщение агенту…</p>}
            {msgs.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.role === "user" ? "self-end bg-indigo-600 text-white" : "self-start bg-zinc-100"
                }`}
              >
                {m.content}
              </div>
            ))}
            {busy && <div className="self-start text-sm text-zinc-400">думает…</div>}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Сообщение"
            />
            <button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy}>
              Отправить
            </button>
          </form>
        </section>
        <aside className="space-y-4 rounded-xl border bg-white p-4 text-sm">
          <div>
            <h2 className="mb-2 font-semibold">Материалы</h2>
            <label className="block cursor-pointer rounded-lg border border-dashed px-3 py-2 text-center text-zinc-500 hover:bg-zinc-50">
              {uploading ? "загрузка…" : "Загрузить PDF / DOCX / TXT / CSV"}
              <input type="file" className="hidden" accept=".pdf,.docx,.txt,.md,.csv,.json" onChange={onUpload} disabled={uploading} />
            </label>
            <ul className="mt-2 space-y-1 text-xs text-zinc-600">
              {docs.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
          <h2 className="mb-2 font-semibold">Шаги агента</h2>
          {steps.length === 0 && <p className="text-zinc-400">Пока нет вызовов инструментов</p>}
          <ul className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="rounded border bg-zinc-50 p-2">
                <div className="font-mono text-xs text-indigo-700">{s.tool}</div>
                <div className="line-clamp-4 font-mono text-xs text-zinc-600">{s.result}</div>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
}

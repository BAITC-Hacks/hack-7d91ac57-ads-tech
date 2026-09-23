import type { ChatStep } from "../api";

export default function AgentSteps({ steps, title = "Шаги агента" }: { steps: ChatStep[]; title?: string }) {
  if (!steps.length) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-zinc-600">{title}</div>
      <ol className="space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs">
            <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-brand-600 text-[10px] font-bold text-white">{i + 1}</span>
            <span className="min-w-[170px]">
              <span className="block font-semibold text-brand-900">{s.label ?? s.tool}</span>
              <span className="font-mono text-[10px] text-zinc-400">{s.tool}</span>
            </span>
            <span className="flex-1 text-zinc-600">{s.summary || s.result}</span>
            {s.ms !== undefined && s.ms > 0 && <span className="text-zinc-400">{s.ms} мс</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

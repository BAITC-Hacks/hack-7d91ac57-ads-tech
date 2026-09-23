import type { SkuDetail } from "../api";

/** Monthly demand chart on plain SVG: raw bars, cleaned line, forecast dashed, stockout shading, outlier markers. */
export default function SkuChart({ d }: { d: SkuDetail }) {
  const W = 680;
  const H = 240;
  const padL = 44;
  const padR = 12;
  const padT = 14;
  const padB = 34;
  const rows = d.monthly;
  const n = rows.length;
  if (!n) return <p className="text-sm text-zinc-500">Нет данных по месяцам</p>;
  const maxV = Math.max(1, ...rows.map((r) => Math.max(r.raw ?? 0, r.cleaned ?? 0, r.forecast ?? 0)));
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xw = innerW / n;
  const x = (i: number) => padL + i * xw;
  const y = (v: number) => padT + innerH - (v / maxV) * innerH;

  const monthIdx = new Map(rows.map((r, i) => [r.month, i]));
  const stockoutMonths = new Set<number>();
  for (const s of d.stockouts) {
    const a = s.from.slice(0, 7);
    const b = s.to.slice(0, 7);
    rows.forEach((r, i) => {
      if (r.month >= a && r.month <= b) stockoutMonths.add(i);
    });
  }
  const outlierPts = d.outliers.map((o) => ({ i: monthIdx.get(o.date.slice(0, 7)), o })).filter((p) => p.i !== undefined) as { i: number; o: SkuDetail["outliers"][number] }[];

  const cleanedPath = rows
    .map((r, i) => (r.cleaned === null ? null : `${i === 0 || rows[i - 1].cleaned === null ? "M" : "L"}${x(i) + xw / 2},${y(r.cleaned)}`))
    .filter(Boolean)
    .join(" ");
  const firstFc = rows.findIndex((r) => r.forecast !== null);
  const lastActual = firstFc > 0 ? firstFc - 1 : -1;
  const fcPts = rows.map((r, i) => (r.forecast === null ? null : `${x(i) + xw / 2},${y(r.forecast)}`)).filter(Boolean) as string[];
  const fcPath = fcPts.length ? `M${lastActual >= 0 && rows[lastActual].cleaned !== null ? `${x(lastActual) + xw / 2},${y(rows[lastActual].cleaned!)} L` : ""}${fcPts.join(" L")}` : "";

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxV * f));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="График спроса по месяцам">
        {stockoutMonths.size > 0 &&
          [...stockoutMonths].map((i) => <rect key={`so${i}`} x={x(i)} y={padT} width={xw} height={innerH} fill="#fee2e2" />)}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#e4e4e7" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} fontSize={10} textAnchor="end" fill="#71717a">
              {t.toLocaleString("ru-RU")}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          r.raw === null ? null : (
            <rect key={`b${i}`} x={x(i) + xw * 0.15} y={y(r.raw)} width={xw * 0.7} height={Math.max(0, y(0) - y(r.raw))} fill="#d4d4d8" rx={1} />
          )
        )}
        {cleanedPath && <path d={cleanedPath} fill="none" stroke="#4f46e5" strokeWidth={2} />}
        {fcPath && <path d={fcPath} fill="none" stroke="#059669" strokeWidth={2} strokeDasharray="5 4" />}
        {outlierPts.map(({ i, o }, k) => (
          <g key={`o${k}`}>
            <circle cx={x(i) + xw / 2} cy={y(rows[i].raw ?? 0)} r={5} fill="#ef4444" stroke="white" strokeWidth={1.5}>
              <title>{`Разовая продажа ${o.qty.toLocaleString("ru-RU")} шт, ${o.date}, ${o.client_id}: ${o.reason}`}</title>
            </circle>
          </g>
        ))}
        {rows.map((r, i) =>
          i % 3 === 0 ? (
            <text key={`l${i}`} x={x(i) + xw / 2} y={H - padB + 14} fontSize={10} textAnchor="middle" fill="#71717a">
              {r.month.slice(2).replace("-", ".")}
            </text>
          ) : null
        )}
        {firstFc > 0 && <line x1={x(firstFc)} x2={x(firstFc)} y1={padT} y2={padT + innerH} stroke="#a1a1aa" strokeDasharray="2 3" />}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
        <span><i className="inline-block h-2.5 w-2.5 rounded-sm bg-zinc-300 align-middle" /> сырые продажи</span>
        <span><i className="inline-block h-0.5 w-4 bg-indigo-600 align-middle" /> очищенный спрос</span>
        <span><i className="inline-block h-0.5 w-4 border-t-2 border-dashed border-emerald-600 align-middle" /> прогноз</span>
        <span><i className="inline-block h-2.5 w-2.5 rounded-full bg-red-500 align-middle" /> разовая продажа</span>
        <span><i className="inline-block h-2.5 w-2.5 bg-red-100 align-middle" /> дефицит</span>
      </div>
    </div>
  );
}

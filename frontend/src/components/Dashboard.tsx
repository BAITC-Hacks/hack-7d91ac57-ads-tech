import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { fmt, fmtMoney, type Backtest, type CategoryTrends, type Impact, type Order, type Overstock, type RunResult } from "../api";

/** Everything from a finished calculation on one screen, as charts. Reads the data the page already has, computes nothing new on the server. */

const U_KEYS = ["critical", "high", "normal"] as const;
type UK = (typeof U_KEYS)[number];
type Counts = Record<UK, number>;
// dark-surface steps, checked with the dataviz validator (lightness band, CVD, contrast)
const U_COLOR: Record<UK, string> = { critical: "#e5406a", high: "#c28400", normal: "#2a93c9" };
const U_LIGHT: Record<UK, string> = { critical: "#ff7a9a", high: "#ffc13d", normal: "#5cc4f5" };
const U_LABEL: Record<UK, string> = { critical: "Критично", high: "Высокая", normal: "Плановая" };
const grad = (k: UK, dir = "90deg") => `linear-gradient(${dir}, ${U_COLOR[k]}, ${U_LIGHT[k]})`;
const CONF: [string, string, string][] = [
  ["высокая", "linear-gradient(90deg,#1a9e6c,#39e0a0)", "высокая"],
  ["средняя", grad("high"), "средняя"],
  ["низкая", grad("critical"), "низкая, проверить"],
  ["штучный спрос", "linear-gradient(90deg,#3a4b5e,#566a80)", "штучный спрос"],
];
const CYAN = "linear-gradient(90deg,#0b98d0,#7c5cff)";
const zero = (): Counts => ({ critical: 0, high: 0, normal: 0 });
const isUK = (u: string): u is UK => u === "critical" || u === "high" || u === "normal";
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const dm = (iso: string) => iso.slice(5).split("-").reverse().join(".");
const delay = (ms: number) => ({ animationDelay: `${ms}ms` });

type Tip = { x: number; y: number; lines: string[] } | null;
type TipFn = (e: React.MouseEvent | null, lines?: string[]) => void;
const TipCtx = createContext<TipFn>(() => undefined);
const hov = (tip: TipFn, lines: string[]) => ({ onMouseMove: (e: React.MouseEvent) => tip(e, lines.filter(Boolean)), onMouseLeave: () => tip(null) });

function useCount(target: number, ms = 1100) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduce = false;
    }
    if (reduce) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

type Props = {
  result: RunResult;
  bt: Backtest | null;
  over: Overstock | null;
  impact: Impact | null;
  trends: CategoryTrends | null;
  onClose: () => void;
  onOpenSku: (sku: string) => void;
};

export default function Dashboard({ result, bt, over, impact, trends, onClose, onOpenSku }: Props) {
  const [tip, setTip] = useState<Tip>(null);
  const tipFn: TipFn = (e, lines) => setTip(e && lines ? { x: e.clientX, y: e.clientY, lines } : null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const s = result.summary;
  const today = result.today;
  const orders = result.orders;

  const weeks = useMemo(() => {
    const b = Array.from({ length: 9 }, (_, i) => ({ label: i === 8 ? "позже" : dm(addDays(today, i * 7)), sub: i === 8 ? `с ${dm(addDays(today, 56))}` : `по ${dm(addDays(today, i * 7 + 6))}`, c: zero(), qty: 0 }));
    for (const o of orders) {
      if (!o.order_by || !isUK(o.urgency)) continue;
      const i = Math.min(8, Math.max(0, Math.floor(dayDiff(today, o.order_by) / 7)));
      b[i].c[o.urgency] += 1;
      b[i].qty += o.recommended_qty;
    }
    return b;
  }, [orders, today]);

  const bySupplier = useMemo(
    () =>
      result.suppliers.map((g) => {
        const c = zero();
        g.orders.forEach((o) => isUK(o.urgency) && (c[o.urgency] += 1));
        return { key: g.supplier, c, total: g.positions, qty: g.total_qty, value: g.total_value ?? 0, lead: g.lead_time_days };
      }),
    [result]
  );

  const byCategory = useMemo(() => {
    const m = new Map<string, { c: Counts; total: number; qty: number }>();
    for (const o of orders) {
      const e = m.get(o.category) ?? { c: zero(), total: 0, qty: 0 };
      if (isUK(o.urgency)) e.c[o.urgency] += 1;
      e.total += 1;
      e.qty += o.recommended_qty;
      m.set(o.category, e);
    }
    const all = [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.total - a.total);
    const top = all.slice(0, 7);
    const rest = all.slice(7);
    if (rest.length) {
      const c = zero();
      rest.forEach((r) => U_KEYS.forEach((k) => (c[k] += r.c[k])));
      top.push({ key: `Остальные ${rest.length} кат.`, c, total: rest.reduce((a, r) => a + r.total, 0), qty: rest.reduce((a, r) => a + r.qty, 0) });
    }
    return top;
  }, [orders]);

  const conf = useMemo(() => {
    const m: Record<string, number> = {};
    orders.forEach((o) => {
      const k = o.forecast_confidence ?? "штучный спрос";
      m[k] = (m[k] ?? 0) + 1;
    });
    return m;
  }, [orders]);

  const critical = useMemo(
    () =>
      orders
        .filter((o) => o.urgency === "critical")
        .sort((a, b) => a.days_of_cover - b.days_of_cover || b.forecast_daily - a.forecast_daily)
        .slice(0, 8),
    [orders]
  );

  const thisWeek = weeks[0].c.critical + weeks[0].c.high + weeks[0].c.normal;
  const wOurs = bt?.test.regular_vs_clean.auto?.wape ?? null;
  const wExcel = bt?.test.regular_vs_clean.naive_90d?.wape ?? null;
  const firstOut = orders.map((o) => o.stockout_date).filter((d): d is string => !!d && d > today).sort()[0];

  const headline: [string, React.ReactNode][] = [
    ["#2a93c9", <>К заказу <b>{fmt(s.positions)}</b> позиций у {s.suppliers} поставщиков, {fmt(s.total_qty)} шт{s.total_value ? <>, ≈ <b>{fmtMoney(s.total_value)}</b> там, где известна себестоимость</> : null}.</>],
    ["#e5406a", <><b>{fmt(s.critical)}</b> критичных: запаса меньше, чем срок поставки. До {dm(addDays(today, 6))} нужно заказать <b>{fmt(thisWeek)}</b> позиций{firstOut ? <>, ближайший дефицит {dm(firstOut)}</> : null}.</>],
    ["#39e0a0", <>Из истории исключено <b>{fmt(s.outliers_excluded_total)}</b> разовых продаж и восстановлено <b>{fmt(s.lost_demand_total)} шт</b> спроса, упущенного в дефиците.</>],
  ];
  if (wOurs != null && wExcel != null) headline.push(["#9d8cff", <>Ошибка прогноза на отложенных данных <b>{fmt(wOurs, 1)} %</b> против {fmt(wExcel, 1)} % у Excel-среднего за 90 дней.</>]);
  if (impact && impact.positions_differ > 0)
    headline.push(["#ffc13d", <>Excel заказал бы лишних <b>{fmt(impact.naive_overorder_qty)} шт</b> и недозаказал <b>{fmt(impact.naive_underorder_qty)} шт</b> по {fmt(impact.positions_differ)} позициям.</>]);
  if (over)
    headline.push(["#8a9bb0", <>Не заказывать: <b>{fmt(over.overstock_positions)}</b> позиций с запасом больше {over.months_threshold} мес.{over.overstock_value ? <> (≈ {fmtMoney(over.overstock_value)})</> : null} и {fmt(over.dead_positions)} без продаж полгода.</>]);

  return (
    <TipCtx.Provider value={tipFn}>
      <div className="viz-bg fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Обзор расчёта на графиках">
        <div className="viz-head sticky top-0 z-10">
          <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="ai-orb grid h-10 w-10 shrink-0 place-items-center rounded-full text-white shadow-[0_0_24px_-4px_rgba(124,92,255,0.8)]">
                <Sparkle className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-bold leading-tight text-white">Обзор расчёта на одном экране</h2>
                <p className="flex items-center gap-2 text-xs text-slate-400">
                  <i className="viz-live inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                  <span className="truncate">расчёт на {result.today} · {fmt(s.positions)} позиций · те же данные, что в таблице заказов · наведите на график, чтобы увидеть числа</span>
                </p>
              </div>
            </div>
            <button onClick={onClose} className="shrink-0 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-sm text-slate-200 backdrop-blur hover:bg-white/10">
              Закрыть <span className="ml-1 rounded border border-white/15 px-1 font-mono text-[10px] text-slate-400">Esc</span>
            </button>
          </div>
        </div>

        <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-4 px-4 py-6 sm:px-6 lg:grid-cols-12">
          <section className="viz-hero rounded-2xl p-5 lg:col-span-5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-300">
                <Sparkle className="h-3.5 w-3.5" /> Главное
              </span>
              <span className="font-mono text-[10px] text-slate-500">{result.elapsed_ms > 0 ? `посчитано за ${fmt(result.elapsed_ms / 1000, 1)} с` : "из кэша"}</span>
            </div>
            <ul className="mt-3 space-y-2.5 text-sm leading-snug text-slate-300 [&_b]:font-semibold [&_b]:text-white">
              {headline.map(([c, t], i) => (
                <li key={i} className="flex gap-3" style={{ animation: "viz-rise .5s both", ...delay(120 + i * 70) }}>
                  <i className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: c, boxShadow: `0 0 10px ${c}` }} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:col-span-7">
            <Kpi i={0} label="Сумма заказа" num={s.total_value ?? null} format={fmtMoney} sub={s.value_known_positions != null ? `цена известна для ${fmt(s.value_known_positions)} поз.` : ""} accent="#5cc4f5" />
            <Kpi i={1} label="Позиций к заказу" num={s.positions} format={(n) => fmt(n)} sub={`${fmt(s.total_qty)} шт · ${s.suppliers} поставщ.`} accent="#5cc4f5" />
            <Kpi i={2} label="Критичных" num={s.critical} format={(n) => fmt(n)} sub={`${Math.round((s.critical / Math.max(1, s.positions)) * 100)} % позиций`} accent={U_LIGHT.critical} />
            <Kpi i={3} label={`Заказать до ${dm(addDays(today, 6))}`} num={thisWeek} format={(n) => `${fmt(n)} поз.`} sub={`${fmt(weeks[0].qty)} шт на этой неделе`} accent={U_LIGHT.high} />
            <Kpi i={4} label="Ошибка прогноза" num={wOurs} format={(n) => `${fmt(n, 1)} %`} sub={wExcel != null ? `у Excel ${fmt(wExcel, 1)} %` : "бэктест считается"} accent="#9d8cff" />
            <Kpi i={5} label="Лишнее на складе" num={over ? over.overstock_value || over.overstock_positions : null} format={(n) => (over?.overstock_value ? fmtMoney(n) : `${fmt(n)} поз.`)} sub={over ? `${fmt(over.overstock_positions)} поз. · ${fmt(over.overstock_units)} шт` : "считается"} accent="#ffc13d" />
          </section>

          <Card i={2} title="Когда заказывать" note="Позиции по неделе, до которой нужно разместить заказ, чтобы товар пришёл до дефицита" className="lg:col-span-8">
            <UrgencyLegend />
            <Columns weeks={weeks} />
          </Card>

          <Card i={3} title="Срочность и надёжность" note="Доля позиций в заказе" className="lg:col-span-4">
            <div className="text-xs font-medium text-slate-400">По срочности</div>
            <Stack100 parts={U_KEYS.map((k) => ({ label: U_LABEL[k], value: s[k], fill: grad(k) }))} unit="поз." />
            <div className="mt-5 text-xs font-medium text-slate-400">Надёжность прогноза</div>
            <Stack100 parts={CONF.map(([k, c, l]) => ({ label: l, value: conf[k] ?? 0, fill: c }))} unit="поз." />
            <p className="mt-4 text-xs leading-snug text-slate-500">
              Штучный спрос: товар продаётся редко, любой метод ошибается сильно, поэтому заказ идёт от минимальной партии. Низкая надёжность: {fmt(conf["низкая"] ?? 0)} позиций стоит проверить глазами.
            </p>
          </Card>

          <Card i={4} title="Поставщики" note="Позиции по срочности" className="lg:col-span-4">
            <UrgencyLegend />
            <HBars rows={bySupplier.map((r) => ({ key: r.key, c: r.c, total: r.total, right: `${fmt(r.qty)} шт${r.value ? ` · ${fmtMoney(r.value)}` : ""}`, extra: `срок поставки ${r.lead} дн.` }))} />
          </Card>

          <Card i={5} title="Категории" note="Где больше всего позиций к заказу" className="lg:col-span-4">
            <UrgencyLegend />
            <HBars rows={byCategory.map((r) => ({ key: r.key, c: r.c, total: r.total, right: `${fmt(r.total)} поз.`, extra: `${fmt(r.qty)} шт` }))} compact />
          </Card>

          <Card i={6} title="Критичные: запас против срока поставки" note="Самые короткие запасы; клик откроет позицию" className="lg:col-span-4">
            <Bullets
              rows={critical}
              onOpen={(sku) => {
                onClose();
                onOpenSku(sku);
              }}
            />
          </Card>

          <Card i={7} title="Точность прогноза" note={bt ? `WAPE на отложенных ${bt.test.months.join(", ")}, меньше лучше` : "бэктест считается"} className="lg:col-span-4">
            {bt ? <Accuracy bt={bt} /> : <Wait />}
          </Card>

          <Card i={8} title="Против Excel «среднее за 90 дней»" note="Что изменится, если заказывать по сервису" className="lg:col-span-4">
            {impact ? <ImpactBars impact={impact} /> : <Wait />}
          </Card>

          <Card i={9} title="Избытки: не заказывать" note={over ? `Запас больше ${over.months_threshold} мес. и товар без продаж полгода` : ""} className="lg:col-span-4">
            {over ? <OverBars over={over} /> : <Wait />}
          </Card>

          {trends && trends.categories.length > 0 && (
            <Card i={10} title="Спрос по категориям" note={`Помесячно за ${trends.months.length} мес., рост по тренду`} className="lg:col-span-12">
              <Trends t={trends} />
            </Card>
          )}
        </div>
        <p className="mx-auto max-w-[1500px] px-4 pb-10 text-xs text-slate-500 sm:px-6">Числа из того же расчёта, что во вкладках. Заказы утверждает менеджер во вкладке «Заказы», автоматически ничего не отправляется.</p>
      </div>
      {tip && (
        <div
          className="pointer-events-none fixed z-[60] max-w-[280px] rounded-lg border border-white/15 bg-[#0b1a2c]/95 px-3 py-2 text-xs text-slate-100 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.8)] backdrop-blur"
          style={{ left: Math.min(tip.x + 16, window.innerWidth - 290), top: tip.y + 16 }}
        >
          {tip.lines.map((l, i) => (
            <div key={i} className={i === 0 ? "font-semibold text-white" : "font-mono text-[11px] text-slate-300"}>{l}</div>
          ))}
        </div>
      )}
    </TipCtx.Provider>
  );
}

export function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z" />
      <path d="M19 14.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" opacity=".75" />
    </svg>
  );
}

function Card({ i, title, note, className, children }: { i: number; title: string; note?: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`viz-card min-w-0 rounded-2xl p-5 ${className ?? ""}`} style={delay(80 + i * 60)}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <i className="inline-block h-3.5 w-1 rounded-full" style={{ background: CYAN }} />
        {title}
      </h3>
      {note && <p className="mt-1 pl-3 text-xs text-slate-400">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Wait() {
  return <p className="py-6 text-center font-mono text-xs text-slate-500">считается…</p>;
}

function Kpi({ i, label, num, format, sub, accent }: { i: number; label: string; num: number | null; format: (n: number) => string; sub?: string; accent: string }) {
  const v = useCount(num ?? 0);
  return (
    <div className="viz-card flex min-h-[104px] flex-col overflow-hidden rounded-2xl px-4 py-3.5" style={delay(i * 60)}>
      <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
      <div className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-400">{label}</div>
      <div className="viz-num mt-1.5 text-[26px] font-bold leading-none tabular-nums">{num == null ? "…" : format(v)}</div>
      {sub && <div className="mt-auto pt-2 text-[11px] leading-tight text-slate-500">{sub}</div>}
      <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-25 blur-2xl" style={{ background: accent }} />
    </div>
  );
}

function UrgencyLegend() {
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
      {U_KEYS.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: grad(k), boxShadow: `0 0 8px ${U_COLOR[k]}` }} />
          {U_LABEL[k]}
        </span>
      ))}
    </div>
  );
}

function Columns({ weeks }: { weeks: { label: string; sub: string; c: Counts; qty: number }[] }) {
  const tip = useContext(TipCtx);
  const max = Math.max(1, ...weeks.map((w) => w.c.critical + w.c.high + w.c.normal));
  return (
    <div className="relative">
      <div className="pointer-events-none absolute inset-x-0 bottom-6 top-6 flex flex-col justify-between">
        {[0, 1, 2, 3].map((g) => (
          <div key={g} className="border-t border-dashed border-white/[0.07]" />
        ))}
      </div>
      <div className="relative flex h-60 items-end gap-2 pt-6 sm:gap-4">
        {weeks.map((w, i) => {
          const tot = w.c.critical + w.c.high + w.c.normal;
          const shown = U_KEYS.filter((k) => w.c[k]);
          return (
            <div
              key={i}
              className="group flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end"
              {...hov(tip, [i === 0 ? `Эта неделя (${w.sub}), включая просроченные` : i === 8 ? `Позже, ${w.sub}` : `Неделя ${w.label} … ${w.sub.slice(3)}`, `${fmt(tot)} поз. · ${fmt(w.qty)} шт`, ...shown.map((k) => `${U_LABEL[k]}: ${fmt(w.c[k])}`)])}
            >
              <span className="mb-1.5 font-mono text-xs font-semibold tabular-nums text-slate-200">{tot ? fmt(tot) : ""}</span>
              <div className="viz-gy flex w-full max-w-[46px] flex-col-reverse gap-[2px] transition-[filter] group-hover:brightness-125" style={{ height: `${(tot / max) * 100}%`, ...delay(250 + i * 60) }}>
                {shown.map((k, j) => (
                  <div
                    key={k}
                    className={j === shown.length - 1 ? "rounded-t-md" : ""}
                    style={{ background: grad(k, "0deg"), flexGrow: w.c[k], flexBasis: 0, minHeight: 2, boxShadow: j === shown.length - 1 ? `0 -4px 18px -4px ${U_COLOR[k]}` : undefined }}
                  />
                ))}
              </div>
              <span className={`mt-2 font-mono text-[11px] tabular-nums ${i === 0 ? "font-semibold text-sky-300" : "text-slate-500"}`}>{i === 0 ? "сейчас" : w.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stack100({ parts, unit }: { parts: { label: string; value: number; fill: string }[]; unit: string }) {
  const tip = useContext(TipCtx);
  const tot = Math.max(1, parts.reduce((a, p) => a + p.value, 0));
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className="mt-2">
      <div className="viz-gx flex h-3.5 w-full gap-[2px] overflow-hidden rounded-full bg-white/5" style={delay(300)}>
        {shown.map((p) => (
          <div key={p.label} style={{ background: p.fill, flexGrow: p.value, flexBasis: 0 }} className="hover:brightness-125" {...hov(tip, [p.label, `${fmt(p.value)} ${unit} · ${Math.round((p.value / tot) * 100)} %`])} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        {shown.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.fill }} />
            {p.label} <b className="font-mono tabular-nums text-slate-100">{fmt(p.value)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function HBars({ rows, compact }: { rows: { key: string; c: Counts; total: number; right: string; extra?: string }[]; compact?: boolean }) {
  const tip = useContext(TipCtx);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className={compact ? "space-y-2" : "space-y-4"}>
      {rows.map((r, i) => {
        const shown = U_KEYS.filter((k) => r.c[k]);
        return (
          <div key={r.key} {...hov(tip, [r.key, `${fmt(r.total)} поз.${r.extra ? ` · ${r.extra}` : ""}`, ...shown.map((k) => `${U_LABEL[k]}: ${fmt(r.c[k])}`)])} className="group cursor-default">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-slate-300 group-hover:text-white" title={r.key}>{r.key}</span>
              <span className="shrink-0 font-mono tabular-nums text-slate-400">{r.right}</span>
            </div>
            <div className={`mt-1 rounded-full bg-white/[0.04] ${compact ? "h-2.5" : "h-4"}`}>
              <div className="viz-gx flex h-full gap-[2px] group-hover:brightness-125" style={{ width: `${Math.max(2, (r.total / max) * 100)}%`, ...delay(300 + i * 50) }}>
                {shown.map((k, j) => (
                  <div key={k} className={`${j === 0 ? "rounded-l-full" : ""} ${j === shown.length - 1 ? "rounded-r-full" : ""}`} style={{ background: grad(k), flexGrow: r.c[k], flexBasis: 0 }} />
                ))}
              </div>
            </div>
            {!compact && (
              <div className="mt-1.5 font-mono text-[11px] text-slate-500">
                {fmt(r.total)} поз.{shown.map((k) => ` · ${U_LABEL[k].toLowerCase()} ${fmt(r.c[k])}`).join("")}
                {r.extra ? ` · ${r.extra}` : ""}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Bullets({ rows, onOpen }: { rows: Order[]; onOpen: (sku: string) => void }) {
  const tip = useContext(TipCtx);
  if (!rows.length) return <p className="py-6 text-center text-xs text-slate-500">критичных позиций нет</p>;
  const max = Math.max(1, ...rows.map((o) => Math.max(o.lead_time_days, Math.min(o.days_of_cover, 999)))) * 1.1;
  return (
    <div className="space-y-1.5">
      <div className="mb-2 flex gap-4 text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-4 rounded-sm" style={{ background: grad("critical") }} /> запас, дн.
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-3 w-0.5 bg-white shadow-[0_0_6px_#fff]" /> срок поставки
        </span>
      </div>
      {rows.map((o, i) => (
        <button
          key={o.sku}
          onClick={() => onOpen(o.sku)}
          className="block w-full rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/5"
          {...hov(tip, [o.name, `запас на ${fmt(o.days_of_cover)} дн., поставка ${o.lead_time_days} дн.`, `остаток ${fmt(o.stock)} · в пути ${fmt(o.in_transit)}`, `заказать ${fmt(o.recommended_qty)} шт${o.order_by ? ` до ${dm(o.order_by)}` : ""}`])}
        >
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-slate-300">{o.name}</span>
            <span className="shrink-0 font-mono tabular-nums text-slate-400">
              <b className="font-semibold" style={{ color: U_LIGHT.critical }}>{fmt(o.days_of_cover)}</b>/{o.lead_time_days} дн · {fmt(o.recommended_qty)} шт
            </span>
          </div>
          <div className="relative mt-1 h-2 rounded-full bg-white/[0.06]">
            <div className="viz-gx absolute inset-y-0 left-0 rounded-full" style={{ width: `${(Math.min(o.days_of_cover, max) / max) * 100}%`, background: grad("critical"), ...delay(300 + i * 50) }} />
            <div className="absolute -inset-y-1 w-0.5 rounded bg-white shadow-[0_0_6px_#fff]" style={{ left: `${(o.lead_time_days / max) * 100}%` }} />
          </div>
        </button>
      ))}
    </div>
  );
}

function Accuracy({ bt }: { bt: Backtest }) {
  const tip = useContext(TipCtx);
  const rows = bt.models
    .map((m) => ({ m, w: bt.test.regular_vs_clean[m]?.wape ?? null, b: bt.test.regular_vs_clean[m]?.bias ?? null }))
    .filter((r): r is { m: string; w: number; b: number | null } => r.w != null)
    .sort((a, b) => a.w - b.w);
  const max = Math.max(1, ...rows.map((r) => r.w));
  return (
    <div className="space-y-2.5">
      {rows.map((r, i) => {
        const ours = r.m === "auto";
        const excel = r.m === "naive_90d";
        return (
          <div key={r.m} className="group cursor-default" {...hov(tip, [bt.labels[r.m] ?? r.m, `WAPE ${fmt(r.w, 1)} %`, r.b != null ? `смещение ${r.b > 0 ? "+" : ""}${fmt(r.b, 1)} %` : ""])}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className={`flex min-w-0 items-center gap-1.5 ${ours ? "font-semibold text-white" : "text-slate-400"}`}>
                <span className="truncate">{bt.labels[r.m] ?? r.m}</span>
                {ours && <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-bold text-white" style={{ background: CYAN }}>сервис</span>}
                {excel && <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-px text-[10px] font-semibold text-slate-200">Excel</span>}
              </span>
              <span className={`shrink-0 font-mono tabular-nums ${ours ? "font-semibold text-white" : "text-slate-400"}`}>{fmt(r.w, 1)} %</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-white/[0.04]">
              <div
                className="viz-gx h-full rounded-full group-hover:brightness-125"
                style={{ width: `${(r.w / max) * 100}%`, background: ours ? CYAN : excel ? "linear-gradient(90deg,#6b7c90,#a3b1c2)" : "rgba(120,170,210,0.3)", boxShadow: ours ? "0 0 14px -2px rgba(124,92,255,0.8)" : undefined, ...delay(300 + i * 50) }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ImpactBars({ impact }: { impact: Impact }) {
  const tip = useContext(TipCtx);
  const max = Math.max(1, impact.naive_overorder_qty, impact.naive_underorder_qty);
  const rows = [
    { l: "Excel заказал бы лишнего", q: impact.naive_overorder_qty, m: impact.naive_overorder_money, k: "high" as UK, t: "деньги, замороженные в запасе" },
    { l: "Excel недозаказал бы", q: impact.naive_underorder_qty, m: impact.naive_underorder_money, k: "critical" as UK, t: "риск дефицита и упущенных продаж" },
  ];
  const share = impact.positions ? impact.positions_differ / impact.positions : 0;
  return (
    <div>
      <div className="space-y-4">
        {rows.map((r, i) => (
          <div key={r.l} className="group cursor-default" {...hov(tip, [r.l, `${fmt(r.q)} шт${r.m ? ` · ≈ ${fmtMoney(r.m)}` : ""}`, r.t])}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-slate-300">{r.l}</span>
              <span className="font-mono font-semibold tabular-nums text-white">{fmt(r.q)} шт</span>
            </div>
            <div className="mt-1 h-4 rounded-full bg-white/[0.04]">
              <div className="viz-gx h-full rounded-full group-hover:brightness-125" style={{ width: `${Math.max(1, (r.q / max) * 100)}%`, background: grad(r.k), boxShadow: `0 0 16px -4px ${U_COLOR[r.k]}`, ...delay(300 + i * 80) }} />
            </div>
            {r.m > 0 && <div className="mt-1 font-mono text-[11px] text-slate-500">≈ {fmtMoney(r.m)}</div>}
          </div>
        ))}
      </div>
      <div className="mt-5 text-xs text-slate-400">
        Расходится с Excel: <b className="font-mono text-white">{fmt(impact.positions_differ)}</b> из {fmt(impact.positions)} позиций
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="viz-gx h-full rounded-full" style={{ width: `${share * 100}%`, background: CYAN, ...delay(500) }} />
      </div>
    </div>
  );
}

function OverBars({ over }: { over: Overstock }) {
  const tip = useContext(TipCtx);
  const byValue = over.overstock.some((r) => r.excess_value > 0);
  const top = [...over.overstock].sort((a, b) => (byValue ? b.excess_value - a.excess_value : b.excess_units - a.excess_units)).slice(0, 5);
  const max = Math.max(1, ...top.map((r) => (byValue ? r.excess_value : r.excess_units)));
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2.5">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-amber-300/90">Избыток</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-white">
            {fmt(over.overstock_positions)} <span className="text-xs font-medium text-slate-400">поз.</span>
          </div>
          <div className="font-mono text-[11px] text-slate-400">{fmt(over.overstock_units)} шт{over.overstock_value ? ` · ${fmtMoney(over.overstock_value)}` : ""}</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-slate-400">Без продаж 6 мес.</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-white">
            {fmt(over.dead_positions)} <span className="text-xs font-medium text-slate-400">поз.</span>
          </div>
          <div className="font-mono text-[11px] text-slate-400">{fmt(over.dead_units)} шт{over.dead_value ? ` · ${fmtMoney(over.dead_value)}` : ""}</div>
        </div>
      </div>
      <div className="mt-4 text-xs font-medium text-slate-400">Больше всего лишнего{byValue ? ", ₸" : ", шт"}</div>
      <div className="mt-2 space-y-2">
        {top.map((r, i) => {
          const v = byValue ? r.excess_value : r.excess_units;
          return (
            <div key={r.sku} className="group cursor-default" {...hov(tip, [r.name, `запас на ${fmt(r.months_of_cover, 1)} мес.`, `лишних ${fmt(r.excess_units)} шт${r.excess_value ? ` · ${fmtMoney(r.excess_value)}` : ""}`])}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-slate-300">{r.name}</span>
                <span className="shrink-0 font-mono tabular-nums text-slate-400">{byValue ? fmtMoney(v) : `${fmt(v)} шт`}</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-white/[0.04]">
                <div className="viz-gx h-full rounded-full group-hover:brightness-125" style={{ width: `${Math.max(2, (v / max) * 100)}%`, background: grad("high"), ...delay(300 + i * 50) }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Trends({ t }: { t: CategoryTrends }) {
  const tip = useContext(TipCtx);
  const cats = [...t.categories].filter((c) => c.qty.length > 1).sort((a, b) => b.total - a.total).slice(0, 12);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cats.map((c, idx) => {
        const w = 160;
        const h = 48;
        const max = Math.max(1, ...c.qty);
        const n = Math.max(1, c.qty.length - 1);
        const pts = c.qty.map((v, i) => [(i / n) * (w - 4) + 2, h - 3 - (v / max) * (h - 8)] as const);
        const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const up = c.growth_pct > 5;
        const down = c.growth_pct < -5;
        const last = pts[pts.length - 1];
        return (
          <div
            key={c.category}
            className="min-w-0 cursor-default rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-colors hover:border-sky-400/30 hover:bg-white/[0.05]"
            {...hov(tip, [c.category, `${fmt(c.total)} шт за ${c.qty.length} мес.`, `рост ${c.growth_pct > 0 ? "+" : ""}${fmt(c.growth_pct, 1)} %`, c.growth_basis])}
          >
            <div className="flex items-baseline justify-between gap-1">
              <span className="truncate text-xs text-slate-300" title={c.category}>{c.category}</span>
              <span className={`shrink-0 font-mono text-xs font-semibold tabular-nums ${up ? "text-emerald-400" : down ? "text-rose-400" : "text-slate-400"}`}>
                {up ? "▲" : down ? "▼" : "•"} {c.growth_pct > 0 ? "+" : ""}
                {fmt(c.growth_pct, 0)} %
              </span>
            </div>
            <svg viewBox={`0 0 ${w} ${h}`} className="mt-1.5 block h-12 w-full overflow-visible" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id={`tl${idx}`} x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0" stopColor="#0b98d0" />
                  <stop offset="1" stopColor="#9d8cff" />
                </linearGradient>
                <linearGradient id={`ta${idx}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#2a93c9" stopOpacity="0.35" />
                  <stop offset="1" stopColor="#2a93c9" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${line} L${last[0]},${h} L${pts[0][0]},${h} Z`} fill={`url(#ta${idx})`} />
              <path d={line} className="viz-draw" fill="none" stroke={`url(#tl${idx})`} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" style={delay(400 + idx * 60)} />
            </svg>
            <div className="mt-1 font-mono text-[11px] tabular-nums text-slate-500">{fmt(c.total)} шт</div>
          </div>
        );
      })}
    </div>
  );
}

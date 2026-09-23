import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { fmt, fmtMoney, type Backtest, type CategoryTrends, type Impact, type Order, type Overstock, type RunResult } from "../api";

/** Everything from a finished calculation on one screen, as charts. Reads the data the page already has, computes nothing new on the server. */

const U_KEYS = ["critical", "high", "normal"] as const;
type UK = (typeof U_KEYS)[number];
type Counts = Record<UK, number>;
const U_COLOR: Record<UK, string> = { critical: "#d93a3a", high: "#eda100", normal: "#2c7294" };
const U_LABEL: Record<UK, string> = { critical: "Критично", high: "Высокая", normal: "Плановая" };
const CONF: [string, string, string][] = [
  ["высокая", "#1f9d6b", "высокая"],
  ["средняя", "#eda100", "средняя"],
  ["низкая", "#d93a3a", "низкая, проверить"],
  ["штучный спрос", "#c4c9ce", "штучный спрос"],
];
const zero = (): Counts => ({ critical: 0, high: 0, normal: 0 });
const isUK = (u: string): u is UK => u === "critical" || u === "high" || u === "normal";
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const dm = (iso: string) => iso.slice(5).split("-").reverse().join(".");

type Tip = { x: number; y: number; lines: string[] } | null;
type TipFn = (e: React.MouseEvent | null, lines?: string[]) => void;
const TipCtx = createContext<TipFn>(() => undefined);
const hov = (tip: TipFn, lines: string[]) => ({ onMouseMove: (e: React.MouseEvent) => tip(e, lines), onMouseLeave: () => tip(null) });

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
    ["#0b98d0", <>К заказу <b>{fmt(s.positions)}</b> позиций у {s.suppliers} поставщиков, {fmt(s.total_qty)} шт{s.total_value ? <>, ≈ <b>{fmtMoney(s.total_value)}</b> там, где известна себестоимость</> : null}.</>],
    ["#d93a3a", <><b>{fmt(s.critical)}</b> критичных: запаса меньше, чем срок поставки. До {dm(addDays(today, 6))} нужно заказать <b>{fmt(thisWeek)}</b> позиций{firstOut ? <>, ближайший дефицит {dm(firstOut)}</> : null}.</>],
    ["#1f9d6b", <>Из истории исключено <b>{fmt(s.outliers_excluded_total)}</b> разовых продаж и восстановлено <b>{fmt(s.lost_demand_total)} шт</b> спроса, упущенного в дефиците.</>],
  ];
  if (wOurs != null && wExcel != null)
    headline.push(["#7c5cff", <>Ошибка прогноза на отложенных данных <b>{fmt(wOurs, 1)} %</b> против {fmt(wExcel, 1)} % у Excel-среднего за 90 дней.</>]);
  if (impact && impact.positions_differ > 0)
    headline.push(["#eda100", <>Excel заказал бы лишних <b>{fmt(impact.naive_overorder_qty)} шт</b> и недозаказал <b>{fmt(impact.naive_underorder_qty)} шт</b> по {fmt(impact.positions_differ)} позициям.</>]);
  if (over)
    headline.push(["#71717a", <>Не заказывать: <b>{fmt(over.overstock_positions)}</b> позиций с запасом больше {over.months_threshold} мес.{over.overstock_value ? <> (≈ {fmtMoney(over.overstock_value)})</> : null} и {fmt(over.dead_positions)} без продаж полгода.</>]);

  return (
    <TipCtx.Provider value={tipFn}>
      <div className="fixed inset-0 z-50 overflow-y-auto bg-page" role="dialog" aria-modal="true" aria-label="Обзор расчёта на графиках">
        <div className="ai-hairline sticky top-0 z-10 border-b border-zinc-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="ai-orb grid h-9 w-9 shrink-0 place-items-center rounded-full text-white">
                <Sparkle className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-bold leading-tight text-brand-900">Обзор расчёта на одном экране</h2>
                <p className="truncate text-xs text-zinc-500">
                  расчёт на {result.today} · {fmt(s.positions)} позиций · данные того же расчёта, что в таблице заказов · наведите на график, чтобы увидеть числа
                </p>
              </div>
            </div>
            <button onClick={onClose} className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">
              Закрыть <span className="text-zinc-400">Esc</span>
            </button>
          </div>
        </div>

        <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-4 px-4 py-5 sm:px-6 lg:grid-cols-12">
          {/* headline + kpis */}
          <section className="ai-card rounded-lg p-4 lg:col-span-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-600">
              <Sparkle className="h-3.5 w-3.5" /> Главное
            </div>
            <ul className="mt-2 space-y-2 text-sm leading-snug text-zinc-800">
              {headline.map(([c, t], i) => (
                <li key={i} className="flex gap-2.5">
                  <i className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: c }} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:col-span-7">
            <Kpi label="Сумма заказа" value={s.total_value ? fmtMoney(s.total_value) : "—"} sub={s.value_known_positions != null ? `цена известна для ${fmt(s.value_known_positions)} поз.` : ""} />
            <Kpi label="Позиций к заказу" value={fmt(s.positions)} sub={`${fmt(s.total_qty)} шт · ${s.suppliers} поставщ.`} />
            <Kpi label="Критичных" value={fmt(s.critical)} tone="#d93a3a" sub={`${Math.round((s.critical / Math.max(1, s.positions)) * 100)} % позиций`} />
            <Kpi label="Заказать до " value={fmt(thisWeek)} valueSuffix="поз." labelSuffix={dm(addDays(today, 6))} sub={`${fmt(weeks[0].qty)} шт на этой неделе`} />
            <Kpi label="Ошибка прогноза" value={wOurs != null ? `${fmt(wOurs, 1)} %` : "…"} tone="#2c7294" sub={wExcel != null ? `у Excel ${fmt(wExcel, 1)} %` : "бэктест считается"} />
            <Kpi label="Лишнее на складе" value={over ? (over.overstock_value ? fmtMoney(over.overstock_value) : `${fmt(over.overstock_positions)} поз.`) : "…"} tone="#b27a00" sub={over ? `${fmt(over.overstock_positions)} поз. · ${fmt(over.overstock_units)} шт` : "считается"} />
          </section>

          {/* order calendar */}
          <Card title="Когда заказывать" note="Позиции по неделе, до которой нужно разместить заказ, чтобы товар пришёл до дефицита" className="lg:col-span-8">
            <UrgencyLegend />
            <Columns weeks={weeks} />
          </Card>

          <Card title="Срочность и надёжность" note="Доля позиций в заказе" className="lg:col-span-4">
            <div className="text-xs font-medium text-zinc-600">По срочности</div>
            <Stack100 parts={U_KEYS.map((k) => ({ label: U_LABEL[k], value: s[k], color: U_COLOR[k] }))} unit="поз." />
            <div className="mt-4 text-xs font-medium text-zinc-600">Надёжность прогноза</div>
            <Stack100 parts={CONF.map(([k, c, l]) => ({ label: l, value: conf[k] ?? 0, color: c }))} unit="поз." />
            <p className="mt-3 text-xs leading-snug text-zinc-500">
              Штучный спрос: товар продаётся редко, любой метод ошибается сильно, поэтому заказ идёт от минимальной партии. Низкая надёжность: {fmt(conf["низкая"] ?? 0)} позиций стоит проверить глазами.
            </p>
          </Card>

          <Card title="Поставщики" note="Позиции по срочности" className="lg:col-span-4">
            <UrgencyLegend />
            <HBars rows={bySupplier.map((r) => ({ key: r.key, c: r.c, total: r.total, right: `${fmt(r.qty)} шт${r.value ? ` · ${fmtMoney(r.value)}` : ""}`, extra: `срок поставки ${r.lead} дн.` }))} />
          </Card>

          <Card title="Категории" note="Где больше всего позиций к заказу" className="lg:col-span-4">
            <UrgencyLegend />
            <HBars rows={byCategory.map((r) => ({ key: r.key, c: r.c, total: r.total, right: `${fmt(r.total)} поз.`, extra: `${fmt(r.qty)} шт` }))} compact />
          </Card>

          <Card title="Критичные: запас против срока поставки" note="Самые короткие запасы; клик откроет позицию" className="lg:col-span-4">
            <Bullets rows={critical} onOpen={(sku) => { onClose(); onOpenSku(sku); }} />
          </Card>

          <Card title="Точность прогноза" note={bt ? `WAPE на отложенных ${bt.test.months.join(", ")}, меньше лучше` : "бэктест считается"} className="lg:col-span-4">
            {bt ? <Accuracy bt={bt} /> : <Wait />}
          </Card>

          <Card title="Против Excel «среднее за 90 дней»" note="Что изменится, если заказывать по сервису" className="lg:col-span-4">
            {impact ? <ImpactBars impact={impact} /> : <Wait />}
          </Card>

          <Card title="Избытки: не заказывать" note={over ? `Запас больше ${over.months_threshold} мес. и товар без продаж полгода` : ""} className="lg:col-span-4">
            {over ? <OverBars over={over} /> : <Wait />}
          </Card>

          {trends && trends.categories.length > 0 && (
            <Card title="Спрос по категориям" note={`Помесячно за ${trends.months.length} мес., рост по тренду`} className="lg:col-span-12">
              <Trends t={trends} />
            </Card>
          )}
        </div>
        <p className="mx-auto max-w-[1500px] px-4 pb-8 text-xs text-zinc-500 sm:px-6">Числа из того же расчёта, что во вкладках. Заказы утверждает менеджер во вкладке «Заказы», автоматически ничего не отправляется.</p>
      </div>
      {tip && (
        <div
          className="pointer-events-none fixed z-[60] max-w-[260px] rounded-md bg-zinc-900/95 px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{ left: Math.min(tip.x + 14, window.innerWidth - 270), top: tip.y + 14 }}
        >
          {tip.lines.map((l, i) => (
            <div key={i} className={i === 0 ? "font-semibold" : "text-zinc-300"}>{l}</div>
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

function Card({ title, note, className, children }: { title: string; note?: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`min-w-0 rounded-lg border border-zinc-200 bg-white p-4 ${className ?? ""}`}>
      <h3 className="text-sm font-semibold text-brand-900">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-zinc-500">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Wait() {
  return <p className="py-6 text-center text-xs text-zinc-400">считается…</p>;
}

function Kpi({ label, labelSuffix, value, valueSuffix, sub, tone }: { label: string; labelSuffix?: string; value: string; valueSuffix?: string; sub?: string; tone?: string }) {
  return (
    <div className="flex min-h-[92px] flex-col rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
        {labelSuffix}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">
        {tone && <i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: tone }} />}
        {value}
        {valueSuffix && <span className="ml-1 text-sm font-semibold text-zinc-500">{valueSuffix}</span>}
      </div>
      {sub && <div className="mt-auto pt-1 text-[11px] leading-tight text-zinc-500">{sub}</div>}
    </div>
  );
}

function UrgencyLegend() {
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600">
      {U_KEYS.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: U_COLOR[k] }} />
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
    <div className="flex h-56 items-end gap-2 border-b border-zinc-200 pt-5 sm:gap-3">
      {weeks.map((w, i) => {
        const tot = w.c.critical + w.c.high + w.c.normal;
        return (
          <div
            key={i}
            className="group flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end"
            {...hov(tip, [i === 0 ? `Эта неделя (${w.sub}), включая просроченные` : i === 8 ? `Позже, ${w.sub}` : `Неделя ${w.label} … ${w.sub.slice(3)}`, `${fmt(tot)} поз. · ${fmt(w.qty)} шт`, ...U_KEYS.filter((k) => w.c[k]).map((k) => `${U_LABEL[k]}: ${fmt(w.c[k])}`)])}
          >
            <span className="mb-1 text-xs font-semibold tabular-nums text-zinc-700">{tot ? fmt(tot) : ""}</span>
            <div className="flex w-full max-w-[44px] flex-col-reverse gap-[2px] transition-opacity group-hover:opacity-80" style={{ height: `${(tot / max) * 100}%` }}>
              {U_KEYS.map((k, j) =>
                w.c[k] ? (
                  <div
                    key={k}
                    className={j === U_KEYS.length - 1 || U_KEYS.slice(j + 1).every((kk) => !w.c[kk]) ? "rounded-t" : ""}
                    style={{ background: U_COLOR[k], flexGrow: w.c[k], flexBasis: 0, minHeight: 2 }}
                  />
                ) : null
              )}
            </div>
            <span className={`mt-1.5 text-[11px] tabular-nums ${i === 0 ? "font-semibold text-brand-900" : "text-zinc-500"}`}>{i === 0 ? "сейчас" : w.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Stack100({ parts, unit }: { parts: { label: string; value: number; color: string }[]; unit: string }) {
  const tip = useContext(TipCtx);
  const tot = Math.max(1, parts.reduce((a, p) => a + p.value, 0));
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className="mt-1.5">
      <div className="flex h-5 w-full gap-[2px] overflow-hidden rounded">
        {shown.map((p) => (
          <div key={p.label} style={{ background: p.color, flexGrow: p.value, flexBasis: 0 }} className="hover:opacity-80" {...hov(tip, [p.label, `${fmt(p.value)} ${unit} · ${Math.round((p.value / tot) * 100)} %`])} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600">
        {shown.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
            {p.label} <b className="tabular-nums text-zinc-800">{fmt(p.value)}</b>
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
    <div className={compact ? "space-y-1.5" : "space-y-3"}>
      {rows.map((r) => (
        <div key={r.key} {...hov(tip, [r.key, `${fmt(r.total)} поз.${r.extra ? ` · ${r.extra}` : ""}`, ...U_KEYS.filter((k) => r.c[k]).map((k) => `${U_LABEL[k]}: ${fmt(r.c[k])}`)])} className="cursor-default">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-zinc-700" title={r.key}>{r.key}</span>
            <span className="shrink-0 tabular-nums text-zinc-500">{r.right}</span>
          </div>
          <div className="mt-0.5 flex gap-[2px]" style={{ width: `${Math.max(2, (r.total / max) * 100)}%` }}>
            {U_KEYS.map((k, j) =>
              r.c[k] ? <div key={k} className={`${compact ? "h-2.5" : "h-4"} ${j === 0 ? "rounded-l" : ""} last:rounded-r`} style={{ background: U_COLOR[k], flexGrow: r.c[k], flexBasis: 0 }} /> : null
            )}
          </div>
          {!compact && (
            <div className="mt-1 text-[11px] text-zinc-500">
              {fmt(r.total)} поз.{U_KEYS.map((k) => (r.c[k] ? ` · ${U_LABEL[k].toLowerCase()} ${fmt(r.c[k])}` : "")).join("")}
              {r.extra ? ` · ${r.extra}` : ""}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Bullets({ rows, onOpen }: { rows: Order[]; onOpen: (sku: string) => void }) {
  const tip = useContext(TipCtx);
  if (!rows.length) return <p className="py-6 text-center text-xs text-zinc-400">критичных позиций нет</p>;
  const max = Math.max(1, ...rows.map((o) => Math.max(o.lead_time_days, Math.min(o.days_of_cover, 999)))) * 1.1;
  return (
    <div className="space-y-2">
      <div className="flex gap-3 text-xs text-zinc-600">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-4 rounded-sm" style={{ background: "#d93a3a" }} /> запас, дн.</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-3 w-0.5 bg-zinc-800" /> срок поставки</span>
      </div>
      {rows.map((o) => (
        <button
          key={o.sku}
          onClick={() => onOpen(o.sku)}
          className="block w-full rounded px-1 py-0.5 text-left hover:bg-brand-50"
          {...hov(tip, [o.name, `запас на ${fmt(o.days_of_cover)} дн., поставка ${o.lead_time_days} дн.`, `остаток ${fmt(o.stock)} · в пути ${fmt(o.in_transit)}`, `заказать ${fmt(o.recommended_qty)} шт${o.order_by ? ` до ${dm(o.order_by)}` : ""}`])}
        >
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-zinc-700">{o.name}</span>
            <span className="shrink-0 tabular-nums text-zinc-500">
              <b className="font-semibold text-red-700">{fmt(o.days_of_cover)}</b> из {o.lead_time_days} дн. · {fmt(o.recommended_qty)} шт
            </span>
          </div>
          <div className="relative mt-0.5 h-2.5 rounded-sm bg-zinc-100">
            <div className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${(Math.min(o.days_of_cover, max) / max) * 100}%`, background: "#d93a3a" }} />
            <div className="absolute -inset-y-0.5 w-0.5 bg-zinc-800" style={{ left: `${(o.lead_time_days / max) * 100}%` }} />
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
    <div className="space-y-2">
      {rows.map((r) => {
        const ours = r.m === "auto";
        const excel = r.m === "naive_90d";
        return (
          <div key={r.m} className="cursor-default" {...hov(tip, [bt.labels[r.m] ?? r.m, `WAPE ${fmt(r.w, 1)} %`, r.b != null ? `смещение ${r.b > 0 ? "+" : ""}${fmt(r.b, 1)} %` : ""])}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className={`truncate ${ours ? "font-semibold text-brand-900" : "text-zinc-700"}`}>
                {bt.labels[r.m] ?? r.m}
                {ours && <span className="ml-1.5 rounded bg-accent-400 px-1 py-px text-[10px] font-bold text-brand-900">сервис</span>}
                {excel && <span className="ml-1.5 rounded bg-zinc-200 px-1 py-px text-[10px] font-semibold text-zinc-700">Excel</span>}
              </span>
              <span className={`shrink-0 tabular-nums ${ours ? "font-semibold text-brand-900" : "text-zinc-500"}`}>{fmt(r.w, 1)} %</span>
            </div>
            <div className="mt-0.5 h-2.5 rounded-r" style={{ width: `${(r.w / max) * 100}%`, background: ours ? "#0b4366" : excel ? "#8a9097" : "#c4d7e2" }} />
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
    { l: "Excel заказал бы лишнего", q: impact.naive_overorder_qty, m: impact.naive_overorder_money, c: "#eda100", t: "деньги, замороженные в запасе" },
    { l: "Excel недозаказал бы", q: impact.naive_underorder_qty, m: impact.naive_underorder_money, c: "#d93a3a", t: "риск дефицита и упущенных продаж" },
  ];
  const share = impact.positions ? impact.positions_differ / impact.positions : 0;
  return (
    <div>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.l} className="cursor-default" {...hov(tip, [r.l, `${fmt(r.q)} шт${r.m ? ` · ≈ ${fmtMoney(r.m)}` : ""}`, r.t])}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-zinc-700">{r.l}</span>
              <span className="tabular-nums font-semibold text-zinc-800">{fmt(r.q)} шт</span>
            </div>
            <div className="mt-0.5 h-4 rounded-r" style={{ width: `${Math.max(1, (r.q / max) * 100)}%`, background: r.c }} />
            {r.m > 0 && <div className="mt-0.5 text-[11px] text-zinc-500">≈ {fmtMoney(r.m)}</div>}
          </div>
        ))}
      </div>
      <div className="mt-4 text-xs text-zinc-600">
        Расходится с Excel: <b className="text-zinc-800">{fmt(impact.positions_differ)}</b> из {fmt(impact.positions)} позиций
      </div>
      <div className="mt-1 flex h-2 gap-[2px] overflow-hidden rounded">
        <div style={{ flexGrow: share, flexBasis: 0, background: "#2c7294" }} />
        <div style={{ flexGrow: 1 - share, flexBasis: 0, background: "#e4e7ea" }} />
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
        <div className="rounded-md bg-amber-50 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-amber-800">Избыток</div>
          <div className="text-lg font-bold tabular-nums text-zinc-900">{fmt(over.overstock_positions)} <span className="text-xs font-medium text-zinc-500">поз.</span></div>
          <div className="text-[11px] text-zinc-600">{fmt(over.overstock_units)} шт{over.overstock_value ? ` · ${fmtMoney(over.overstock_value)}` : ""}</div>
        </div>
        <div className="rounded-md bg-zinc-100 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-zinc-600">Без продаж 6 мес.</div>
          <div className="text-lg font-bold tabular-nums text-zinc-900">{fmt(over.dead_positions)} <span className="text-xs font-medium text-zinc-500">поз.</span></div>
          <div className="text-[11px] text-zinc-600">{fmt(over.dead_units)} шт{over.dead_value ? ` · ${fmtMoney(over.dead_value)}` : ""}</div>
        </div>
      </div>
      <div className="mt-3 text-xs font-medium text-zinc-600">Больше всего лишнего{byValue ? ", ₸" : ", шт"}</div>
      <div className="mt-1 space-y-1.5">
        {top.map((r) => {
          const v = byValue ? r.excess_value : r.excess_units;
          return (
            <div key={r.sku} className="cursor-default" {...hov(tip, [r.name, `запас на ${fmt(r.months_of_cover, 1)} мес.`, `лишних ${fmt(r.excess_units)} шт${r.excess_value ? ` · ${fmtMoney(r.excess_value)}` : ""}`])}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-zinc-700">{r.name}</span>
                <span className="shrink-0 tabular-nums text-zinc-500">{byValue ? fmtMoney(v) : `${fmt(v)} шт`}</span>
              </div>
              <div className="mt-0.5 h-2 rounded-r" style={{ width: `${Math.max(2, (v / max) * 100)}%`, background: "#b27a00" }} />
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
      {cats.map((c) => {
        const w = 160;
        const h = 44;
        const max = Math.max(1, ...c.qty);
        const n = Math.max(1, c.qty.length - 1);
        const pts = c.qty.map((v, i) => [(i / n) * (w - 4) + 2, h - 3 - (v / max) * (h - 8)] as const);
        const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const up = c.growth_pct > 5;
        const down = c.growth_pct < -5;
        return (
          <div key={c.category} className="min-w-0 rounded-md border border-zinc-100 bg-zinc-50/60 p-2.5" {...hov(tip, [c.category, `${fmt(c.total)} шт за ${c.qty.length} мес.`, `рост ${c.growth_pct > 0 ? "+" : ""}${fmt(c.growth_pct, 1)} %`, c.growth_basis])}>
            <div className="flex items-baseline justify-between gap-1">
              <span className="truncate text-xs text-zinc-700" title={c.category}>{c.category}</span>
              <span className={`shrink-0 text-xs font-semibold tabular-nums ${up ? "text-emerald-700" : down ? "text-red-700" : "text-zinc-500"}`}>
                {up ? "▲" : down ? "▼" : "•"} {c.growth_pct > 0 ? "+" : ""}
                {fmt(c.growth_pct, 0)} %
              </span>
            </div>
            <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 block h-11 w-full" preserveAspectRatio="none" aria-hidden="true">
              <path d={`${line} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`} fill="#2c7294" opacity={0.12} />
              <path d={line} fill="none" stroke="#2c7294" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
            <div className="text-[11px] tabular-nums text-zinc-500">{fmt(c.total)} шт</div>
          </div>
        );
      })}
    </div>
  );
}

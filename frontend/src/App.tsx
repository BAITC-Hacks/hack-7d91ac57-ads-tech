import React, { useEffect, useMemo, useState } from "react";
import { api, fmt, type CategoryTrends, type Health, type Impact, type RunResult, type SkuDetail, type SupplierGroup, type Urgency } from "./api";
import Assistant from "./components/Assistant";
import OrdersTable, { UrgencyBadge } from "./components/OrdersTable";
import SkuChart from "./components/SkuChart";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [warehouse, setWarehouse] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [serviceLevel, setServiceLevel] = useState<string>("");
  const [reviewDays, setReviewDays] = useState<number>(14);
  const [urgencyFilter, setUrgencyFilter] = useState<Urgency | "">("");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [trends, setTrends] = useState<CategoryTrends | null>(null);
  const [showTrends, setShowTrends] = useState(false);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [qtyEdits, setQtyEdits] = useState<Record<string, number>>({});
  const [approved, setApproved] = useState<Record<string, string>>({});
  const [approvedCount, setApprovedCount] = useState(0);
  const [detailSku, setDetailSku] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkuDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [whatIf, setWhatIf] = useState<{ in_transit: string; stock: string; lead: string }>({ in_transit: "", stock: "", lead: "" });
  const [whatIfRes, setWhatIfRes] = useState<{ scenario_qty: number; base_qty: number; delta: number; justification: string } | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  // health + polling until the startup precompute is ready
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const h = await api.health();
        if (stop) return;
        setHealth(h);
        setHealthErr(null);
        if (!warehouse) setWarehouse(h.data.default_warehouse);
        if (!h.calculation_ready) setTimeout(tick, 2500);
      } catch (e) {
        if (!stop) {
          setHealthErr((e as Error).message);
          setTimeout(tick, 4000);
        }
      }
    }
    tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.orders().then((r) => setApprovedCount(r.orders.length)).catch(() => undefined);
  }, [approved]);

  async function run() {
    setRunning(true);
    setRunErr(null);
    try {
      const r = await api.run({ warehouse: warehouse || null, category: category || null, service_level: serviceLevel ? Number(serviceLevel) : null, review_days: reviewDays });
      setResult(r);
      setQtyEdits({});
      setApproved({});
      api.impact().then(setImpact).catch(() => setImpact(null));
      api.categories(warehouse || undefined).then(setTrends).catch(() => setTrends(null));
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function openSku(sku: string) {
    setDetailSku(sku);
    setDetail(null);
    setDetailErr(null);
    setWhatIfRes(null);
    setWhatIf({ in_transit: "", stock: "", lead: "" });
    try {
      setDetail(await api.sku(sku, warehouse || undefined));
    } catch (e) {
      setDetailErr((e as Error).message);
    }
  }

  async function runWhatIf() {
    if (!detailSku) return;
    try {
      const r = await api.whatif({
        sku: detailSku,
        warehouse: warehouse || undefined,
        in_transit: whatIf.in_transit === "" ? null : Number(whatIf.in_transit),
        stock: whatIf.stock === "" ? null : Number(whatIf.stock),
        lead_time_days: whatIf.lead === "" ? null : Number(whatIf.lead),
      });
      setWhatIfRes({ scenario_qty: r.scenario.recommended_qty, base_qty: r.base.recommended_qty, delta: r.delta_qty, justification: r.scenario.justification });
    } catch (e) {
      setWhatIfRes({ scenario_qty: 0, base_qty: 0, delta: 0, justification: `Ошибка: ${(e as Error).message}` });
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>, kind: string) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadMsg("загрузка…");
    try {
      const r = await api.upload(kind, f);
      setUploadMsg(`${r.kind}: загружено ${r.rows} строк. Нажмите «Рассчитать».`);
      setResult(null);
    } catch (err) {
      setUploadMsg(`Ошибка: ${(err as Error).message}`);
    } finally {
      e.target.value = "";
    }
  }

  const groups: SupplierGroup[] = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    return result.suppliers
      .map((g) => ({
        ...g,
        orders: g.orders.filter((o) => (!urgencyFilter || o.urgency === urgencyFilter) && (!q || o.sku.toLowerCase().includes(q) || o.name.toLowerCase().includes(q) || (o.article ?? "").toLowerCase().includes(q))),
      }))
      .map((g) => ({ ...g, positions: g.orders.length, total_qty: g.orders.reduce((s, o) => s + o.recommended_qty, 0), critical: g.orders.filter((o) => o.urgency === "critical").length }))
      .filter((g) => g.orders.length > 0);
  }, [result, urgencyFilter, search]);

  const ready = health?.calculation_ready ?? false;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <div>
            <h1 className="text-lg font-semibold leading-tight">Расчёт заказов поставщикам</h1>
            <p className="text-xs text-zinc-500">ТОО «Электрокомплект» · отдел закупа</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Chip ok={!!health && !healthErr} label={healthErr ? `backend недоступен: ${healthErr}` : health ? `backend ok · ${health.demo_mode ? "DEMO без LLM" : health.model}` : "подключение…"} />
            {health && (
              <>
                <Chip label={`${fmt(health.data.skus)} артикулов`} />
                <Chip label={`продажи ${health.data.sales_from} … ${health.data.sales_to}`} />
                <Chip label={`${health.data.suppliers} поставщ. · ${health.data.in_transit_lines} поз. в пути · ${health.data.stockout_periods} периодов дефицита`} />
                <Chip ok={ready} label={ready ? "расчёт готов" : "идёт предрасчёт…"} />
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-zinc-500">Утверждённых заказов: {approvedCount}</span>
            <label className="cursor-pointer rounded-lg border border-zinc-300 px-2.5 py-1.5 text-zinc-700 hover:bg-zinc-50">
              Загрузить CSV
              <select className="ml-1 bg-transparent text-zinc-500" onChange={() => undefined} defaultValue="sales" id="upload-kind" onClick={(e) => e.stopPropagation()}>
                {["sales", "stock", "in_transit", "stockouts", "suppliers", "products"].map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <input type="file" accept=".csv" className="hidden" onChange={(e) => onUpload(e, (document.getElementById("upload-kind") as HTMLSelectElement).value)} />
            </label>
          </div>
        </div>
        {uploadMsg && <div className="mx-auto max-w-[1500px] px-6 pb-2 text-xs text-zinc-600">{uploadMsg}</div>}
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          {/* filters */}
          <section className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 bg-white p-4">
            <Field label="Склад">
              <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm">
                {(health?.data.warehouses ?? []).map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </Field>
            <Field label="Категория">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="max-w-[240px] rounded-lg border border-zinc-300 px-2 py-1.5 text-sm">
                <option value="">Все категории</option>
                {(health?.data.categories ?? []).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Уровень сервиса">
              <select value={serviceLevel} onChange={(e) => setServiceLevel(e.target.value)} className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm">
                <option value="">по категории</option>
                <option value="0.9">90 %</option>
                <option value="0.95">95 %</option>
                <option value="0.98">98 %</option>
              </select>
            </Field>
            <Field label="Период между заказами">
              <select value={reviewDays} onChange={(e) => setReviewDays(Number(e.target.value))} className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm">
                {[7, 14, 30].map((d) => (
                  <option key={d} value={d}>{d} дней</option>
                ))}
              </select>
            </Field>
            <button onClick={run} disabled={running || !health} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {running ? "Считаю…" : "Рассчитать"}
            </button>
            {result && <span className="text-xs text-zinc-500">за {result.elapsed_ms} мс · дата расчёта {result.today}</span>}
            {runErr && <span className="text-sm text-red-700">Ошибка: {runErr}</span>}
            {!ready && !result && <span className="text-xs text-zinc-500">Первый расчёт на полных данных занимает до минуты; можно нажать сразу.</span>}
          </section>

          {!result && !running && (
            <section className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-zinc-500">
              <p className="text-base">Выберите склад и категорию и нажмите «Рассчитать».</p>
              <p className="mt-1 text-sm">Сервис учтёт историю продаж, остатки, товар в пути, периоды дефицита, сезонность, тренд и MOQ поставщика, исключит разовые крупные заказы и объяснит каждую цифру.</p>
            </section>
          )}

          {result && (
            <>
              {/* summary */}
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Позиций к заказу" value={fmt(result.summary.positions)} />
                <Stat label="Поставщиков" value={fmt(result.summary.suppliers)} />
                <Stat label="Критичных" value={fmt(result.summary.critical)} tone="red" />
                <Stat label="Высокий приоритет" value={fmt(result.summary.high)} tone="amber" />
                <Stat label="Исключено разовых продаж" value={fmt(result.summary.outliers_excluded_total)} />
                <Stat label="Учтён упущенный спрос" value={`${fmt(result.summary.lost_demand_total)} шт`} />
              </section>

              {impact && (
                <section className="rounded-xl border border-zinc-200 bg-white p-4">
                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                    <h2 className="text-sm font-semibold">Эффект относительно расчёта «среднее за 90 дней» в Excel</h2>
                    <span className="text-sm text-zinc-700">
                      Excel заказал бы лишних <b className="text-amber-700">{fmt(impact.naive_overorder_qty)} шт</b>
                      {impact.naive_overorder_money > 0 && <> (≈ {fmt(impact.naive_overorder_money)} ₸ по себестоимости)</>} и недозаказал{" "}
                      <b className="text-red-700">{fmt(impact.naive_underorder_qty)} шт</b>
                      {impact.naive_underorder_money > 0 && <> (≈ {fmt(impact.naive_underorder_money)} ₸)</>} по {impact.positions_differ} позициям из {impact.positions}.
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{impact.note}</p>
                </section>
              )}

              {trends && trends.categories.length > 0 && (
                <section className="rounded-xl border border-zinc-200 bg-white p-4">
                  <button onClick={() => setShowTrends(!showTrends)} className="flex w-full items-center justify-between text-left">
                    <h2 className="text-sm font-semibold">Тренды спроса по категориям, последние {trends.months.length} мес.</h2>
                    <span className="text-xs text-zinc-500">{showTrends ? "свернуть" : "показать"}</span>
                  </button>
                  {showTrends && (
                    <table className="mt-3 w-full text-sm">
                      <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                        <tr>
                          <th className="py-1">Категория</th>
                          <th className="py-1">Динамика</th>
                          <th className="py-1 text-right">Всего, шт</th>
                          <th className="py-1 text-right">Рост</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trends.categories.slice(0, 12).map((c) => (
                          <tr key={c.category} className="border-t border-zinc-100">
                            <td className="py-1.5 pr-3">{c.category}</td>
                            <td className="py-1.5"><Sparkline values={c.qty} /></td>
                            <td className="py-1.5 text-right tabular-nums">{fmt(c.total)}</td>
                            <td className={`py-1.5 text-right tabular-nums ${c.growth_pct > 5 ? "text-emerald-700" : c.growth_pct < -5 ? "text-red-700" : "text-zinc-600"}`} title={c.growth_basis}>
                              {c.growth_pct > 0 ? "+" : ""}{fmt(c.growth_pct, 1)} %
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              )}

              {/* list filters */}
              <section className="flex flex-wrap items-center gap-2">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по артикулу или названию" className="w-72 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm" />
                {(["", "critical", "high", "normal"] as const).map((u) => (
                  <button key={u} onClick={() => setUrgencyFilter(u)} className={`rounded-full border px-3 py-1 text-xs ${urgencyFilter === u ? "border-indigo-600 bg-indigo-600 text-white" : "border-zinc-300 bg-white text-zinc-700"}`}>
                    {u === "" ? "Все" : u === "critical" ? "Критичные" : u === "high" ? "Высокие" : "Плановые"}
                  </button>
                ))}
                <span className="ml-auto flex gap-2">
                  <a href={api.exportUrl("xlsx")} className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">Экспорт XLSX (все)</a>
                  <a href={api.exportUrl("csv")} className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">CSV для 1С (все)</a>
                </span>
              </section>

              {groups.length === 0 ? (
                <p className="rounded-xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">Нет позиций под текущие фильтры.</p>
              ) : (
                <OrdersTable
                  groups={groups}
                  qtyEdits={qtyEdits}
                  onEditQty={(sku, qty) => setQtyEdits({ ...qtyEdits, [sku]: qty })}
                  onOpenSku={openSku}
                  approved={approved}
                  onApproved={(sid, oid) => setApproved({ ...approved, [sid]: oid })}
                />
              )}
            </>
          )}
        </div>

        <div className="lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]">
          <Assistant focusSku={detailSku ?? result?.orders.find((o) => o.urgency === "critical")?.sku} demoMode={health?.demo_mode ?? true} />
        </div>
      </main>

      {/* SKU drawer */}
      {detailSku && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={() => setDetailSku(null)}>
          <div className="h-full w-full max-w-3xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-sm text-indigo-700">{detailSku}</div>
                <h2 className="text-lg font-semibold">{detail?.name ?? "…"}</h2>
                {detail && (
                  <p className="text-sm text-zinc-500">
                    {detail.category} · {detail.supplier} · срок поставки {detail.lead_time_days} дн. · <UrgencyBadge u={detail.urgency} />
                  </p>
                )}
              </div>
              <button onClick={() => setDetailSku(null)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm">Закрыть</button>
            </div>
            {detailErr && <p className="mt-4 text-sm text-red-700">Ошибка: {detailErr}</p>}
            {!detail && !detailErr && <p className="mt-4 text-sm text-zinc-500">Загрузка…</p>}
            {detail && (
              <>
                <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
                  <Stat label="Рекомендовано" value={`${fmt(detail.recommended_qty)}`} tone="indigo" />
                  <Stat label="Остаток" value={fmt(detail.stock)} />
                  <Stat label="В пути" value={fmt(detail.in_transit)} />
                  <Stat label="Прогноз/день" value={fmt(detail.forecast_daily, 1)} />
                  <Stat label="Покрытие" value={`${detail.days_of_cover >= 999 ? "∞" : fmt(detail.days_of_cover)} дн.`} />
                  <Stat label="Страховой запас" value={fmt(detail.safety_stock)} />
                </div>
                <div className="mt-5">
                  <h3 className="mb-2 text-sm font-semibold">Продажи по месяцам, очищенный спрос и прогноз</h3>
                  <SkuChart d={detail} />
                </div>
                <p className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm leading-relaxed text-zinc-800">{detail.justification}</p>
                {(detail.outliers.length > 0 || detail.stockouts.length > 0) && (
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    {detail.outliers.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Исключённые разовые продажи</h4>
                        <ul className="mt-1 space-y-1 text-sm">
                          {detail.outliers.slice(0, 8).map((o, i) => (
                            <li key={i} className="flex justify-between gap-2">
                              <span className="text-zinc-600">{o.date} · {o.client_id}</span>
                              <span className="tabular-nums">{fmt(o.qty)} шт <span className="text-xs text-zinc-400">({o.reason})</span></span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {detail.stockouts.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Периоды дефицита</h4>
                        <ul className="mt-1 space-y-1 text-sm">
                          {detail.stockouts.slice(0, 8).map((s, i) => (
                            <li key={i} className="flex justify-between gap-2">
                              <span className="text-zinc-600">{s.from} → {s.to} ({s.days} дн.)</span>
                              <span className="tabular-nums">упущено {fmt(s.lost_demand_qty)} шт</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-5 rounded-xl border border-zinc-200 p-4">
                  <h3 className="text-sm font-semibold">Что если</h3>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <Field label="В пути, шт">
                      <input type="number" value={whatIf.in_transit} onChange={(e) => setWhatIf({ ...whatIf, in_transit: e.target.value })} placeholder={String(detail.in_transit)} className="w-28 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm" />
                    </Field>
                    <Field label="Остаток, шт">
                      <input type="number" value={whatIf.stock} onChange={(e) => setWhatIf({ ...whatIf, stock: e.target.value })} placeholder={String(detail.stock)} className="w-28 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm" />
                    </Field>
                    <Field label="Срок поставки, дн.">
                      <input type="number" value={whatIf.lead} onChange={(e) => setWhatIf({ ...whatIf, lead: e.target.value })} placeholder={String(detail.lead_time_days)} className="w-28 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm" />
                    </Field>
                    <button onClick={runWhatIf} className="rounded-lg bg-zinc-800 px-3 py-2 text-sm font-medium text-white">Пересчитать</button>
                  </div>
                  {whatIfRes && (
                    <div className="mt-3 text-sm">
                      <p>
                        Было <b>{fmt(whatIfRes.base_qty)}</b> → станет <b>{fmt(whatIfRes.scenario_qty)}</b>{" "}
                        <span className={whatIfRes.delta < 0 ? "text-emerald-700" : whatIfRes.delta > 0 ? "text-red-700" : "text-zinc-500"}>({whatIfRes.delta > 0 ? "+" : ""}{fmt(whatIfRes.delta)})</span>
                      </p>
                      <p className="mt-1 text-xs text-zinc-600">{whatIfRes.justification}</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 160;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * (w - 2) + 1},${h - 1 - (v / max) * (h - 4)}`).join(" ");
  return (
    <svg width={w} height={h} className="block">
      <polyline points={pts} fill="none" stroke="#4f46e5" strokeWidth={1.5} />
    </svg>
  );
}

function Chip({ label, ok }: { label: string; ok?: boolean }) {
  const tone = ok === undefined ? "bg-zinc-100 text-zinc-600" : ok ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  return <span className={`rounded-full px-2.5 py-1 ${tone}`}>{label}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-500">
      {label}
      {children}
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" | "amber" | "indigo" }) {
  const cls = tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : tone === "indigo" ? "text-indigo-700" : "text-zinc-900";
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

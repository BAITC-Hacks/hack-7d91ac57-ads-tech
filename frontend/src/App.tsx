import React, { useEffect, useMemo, useState } from "react";
import { api, fmt, fmtMoney, type Backtest, type CategoryTrends, type DailyBrief, type Health, type Impact, type Order, type Overstock, type RunResult, type SkuDetail, type SupplierGroup, type Urgency, type User } from "./api";
import Tour, { type TourStep } from "./components/Tour";
import NewsTab from "./components/NewsTab";
import SignalsTab from "./components/SignalsTab";
import Assistant from "./components/Assistant";
import OrdersTable, { UrgencyBadge } from "./components/OrdersTable";
import SkuChart from "./components/SkuChart";

type Tab = "orders" | "signals" | "news" | "accuracy" | "overstock" | "impact" | "trends";
type SortKey = "urgency" | "value" | "qty" | "cover";

const SELECT = "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800 focus:outline-none focus:ring-2 focus:ring-brand-500";
const UPLOAD_KINDS: [string, string][] = [
  ["sales", "Продажи: date, sku, qty, client_id, price, warehouse"],
  ["stock", "Остатки: sku, warehouse, stock, as_of"],
  ["in_transit", "Товар в пути: sku, warehouse, qty, eta"],
  ["stockouts", "Дефициты: sku, warehouse, date_from, date_to"],
  ["suppliers", "Поставщики: supplier_id, supplier, lead_time_days, moq"],
  ["products", "Товары: sku, name, category, supplier_id, pack_size"],
];

const TOUR_KEY = "ekt_tour_done_v1";
const TOUR_STEPS: TourStep[] = [
  { title: "Добро пожаловать", text: "Сервис считает, что и сколько заказать у поставщиков, и объясняет каждую цифру. Пройдём по экрану за минуту: стрелки на клавиатуре тоже работают." },
  { sel: "[data-tour=params]", title: "Параметры расчёта", text: "Склад, категория, уровень сервиса, период между заказами и плановый прирост. По умолчанию уже стоят разумные значения." },
  { sel: "[data-tour=calib]", title: "Калибровка страхового запаса", text: "Бэктест показал, что классическая формула обещает 95 %, а даёт 81 %. С калибровкой обещание выполняется, но заказ больше. Решение за вами." },
  { sel: "[data-tour=run]", title: "Рассчитать", text: "Одна кнопка: очистка разовых заказов, восстановление спроса в дефиците, сезонность, тренд, страховой запас, кратность и MOQ.", action: "run" },
  { sel: "[data-tour=stats]", title: "Сводка", text: "Сколько позиций заказать, сколько критичных, на какую сумму, насколько точен прогноз и сколько лишнего лежит на складе." },
  { sel: "[data-tour=tabs]", title: "Разделы", text: "Заказы, точность прогноза, избытки, сравнение с Excel и тренды категорий. Главная работа во вкладке «Заказы»." },
  { sel: "[data-tour=orders] tbody tr:first-child", title: "Строка заказа", text: "Остаток и товар в пути, прогноз в день с точкой надёжности, дни покрытия и дата, до которой нужно заказать." },
  { sel: "[data-tour=orders] tbody tr:first-child input", title: "Количество можно поправить", text: "Рекомендацию можно изменить вручную: сервис подсветит правку и покажет исходное число." },
  { sel: "[data-tour=orders] tbody tr:first-child td:last-child button", title: "Почему столько?", text: "Обоснование каждой цифры: прогноз, сезонность, исключённые разовые продажи, упущенный спрос, запас. Клик по артикулу откроет график и «что если»." },
  { sel: "[data-tour=approve]", title: "Утверждение", text: "Заказ поставщику утверждает человек. Автоматически ничего не отправляется, после утверждения готов черновик письма и выгрузка для 1С." },
  { sel: "[data-tour=assistant]", title: "Ассистент закупщика", text: "Спросите обычными словами: «почему столько?», «что если придёт ещё 200?». Ассистент отвечает только числами из расчёта и показывает свои шаги." },
  { sel: "[data-tour=brief]", title: "Утренняя сводка агента", text: "Агент сам проходит по расчёту, дефициту и избыткам и пишет, что сделать сегодня." },
  { sel: "[data-tour=data]", title: "Данные и импорт", text: "Откуда данные, какие допущения приняты, импорт выгрузок 1С как есть." },
  { sel: "[data-tour=admin]", title: "Администрирование", text: "Интеграции с 1С и Bitrix24, журнал действий и пользователи.", optional: true },
  { title: "Готово", text: "Кнопка «Обучение» в шапке запускает этот тур снова." },
];

export default function App({ user, onLogout, onAdmin }: { user: User; onLogout: () => void; onAdmin: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [warehouse, setWarehouse] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [serviceLevel, setServiceLevel] = useState<string>("");
  const [reviewDays, setReviewDays] = useState<number>(14);
  const [growthPlan, setGrowthPlan] = useState<string>("");
  const [ssCalibrated, setSsCalibrated] = useState(true);
  const [includeSignals, setIncludeSignals] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("orders");
  const [bt, setBt] = useState<Backtest | null>(null);
  const [over, setOver] = useState<Overstock | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [trends, setTrends] = useState<CategoryTrends | null>(null);
  const [urgencyFilter, setUrgencyFilter] = useState<Urgency | "">("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("urgency");
  const [qtyEdits, setQtyEdits] = useState<Record<string, number>>({});
  const [approved, setApproved] = useState<Record<string, string>>({});
  const [approvedCount, setApprovedCount] = useState(0);
  const [detailSku, setDetailSku] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkuDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [whatIf, setWhatIf] = useState<{ in_transit: string; stock: string; lead: string }>({ in_transit: "", stock: "", lead: "" });
  const [whatIfRes, setWhatIfRes] = useState<{ scenario_qty: number; base_qty: number; delta: number; justification: string } | null>(null);
  const [showData, setShowData] = useState(false);
  const [uploadKind, setUploadKind] = useState("sales");
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefErr, setBriefErr] = useState<string | null>(null);
  const [tourOn, setTourOn] = useState(false);

  useEffect(() => {
    let done = false;
    try {
      done = localStorage.getItem(TOUR_KEY) === "1";
    } catch {
      done = false;
    }
    if (!done) setTourOn(true);
  }, []);

  function closeTour() {
    setTourOn(false);
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  // health + polling until the startup precompute is ready
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const h = await api.health();
        if (stop) return;
        setHealth(h);
        setHealthErr(null);
        setWarehouse((w) => w || h.data.default_warehouse);
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
  }, []);

  useEffect(() => {
    api.orders().then((r) => setApprovedCount(r.orders.length)).catch(() => undefined);
  }, [approved]);

  // the backtest is computed in the background at startup: poll until it is there
  useEffect(() => {
    if (!result || bt) return;
    let stop = false;
    const t = setInterval(() => {
      api.backtest().then((b) => !stop && b && setBt(b)).catch(() => undefined);
    }, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [result, bt]);

  async function run() {
    setRunning(true);
    setRunErr(null);
    try {
      const r = await api.run({ warehouse: warehouse || null, category: category || null, service_level: serviceLevel ? Number(serviceLevel) : null, review_days: reviewDays, growth_plan_pct_year: growthPlan ? Number(growthPlan) : null, ss_calibrated: ssCalibrated, include_signals: includeSignals });
      setResult(r);
      setQtyEdits({});
      setApproved({});
      setImpact(null);
      setOver(null);
      api.impact().then(setImpact).catch(() => setImpact(null));
      api.categories(warehouse || undefined).then(setTrends).catch(() => setTrends(null));
      api.overstock(warehouse || undefined).then(setOver).catch(() => setOver(null));
      api.backtest().then(setBt).catch(() => setBt(null));
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function loadBrief() {
    setBriefBusy(true);
    setBriefErr(null);
    try {
      setBrief(await api.dailyBrief(warehouse || undefined));
    } catch (e) {
      setBriefErr((e as Error).message);
    } finally {
      setBriefBusy(false);
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

  async function onImportPartner(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setImporting(true);
    setUploadMsg(`Импорт ${files.length} файлов 1С…`);
    try {
      const r = await api.importPartner(files);
      const info = r.imported as Record<string, number | string>;
      setUploadMsg(`Импортировано: ${fmt(Number(info.products))} артикулов, ${fmt(Number(info.sales_rows))} строк продаж, ${fmt(Number(info.in_transit))} позиций в пути. Идёт предрасчёт и бэктест, затем нажмите «Рассчитать».`);
      setResult(null);
      setBt(null);
      setHealth(await api.health());
    } catch (err) {
      setUploadMsg(`Ошибка импорта: ${(err as Error).message}`);
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadMsg("Загрузка…");
    try {
      const r = await api.upload(uploadKind, f);
      setUploadMsg(`${r.kind}: загружено ${fmt(r.rows)} строк. Нажмите «Рассчитать».`);
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
    const sorter = (a: Order, b: Order) =>
      sortKey === "value"
        ? b.order_value - a.order_value || b.recommended_qty - a.recommended_qty
        : sortKey === "qty"
          ? b.recommended_qty - a.recommended_qty
          : sortKey === "cover"
            ? a.days_of_cover - b.days_of_cover
            : 0;
    return result.suppliers
      .map((g) => {
        const orders = g.orders.filter((o) => (!urgencyFilter || o.urgency === urgencyFilter) && (!q || o.sku.toLowerCase().includes(q) || o.name.toLowerCase().includes(q) || (o.article ?? "").toLowerCase().includes(q)));
        if (sortKey !== "urgency") orders.sort(sorter);
        return {
          ...g,
          orders,
          positions: orders.length,
          total_qty: orders.reduce((s, o) => s + o.recommended_qty, 0),
          total_value: orders.reduce((s, o) => s + (o.order_value || 0), 0),
          critical: orders.filter((o) => o.urgency === "critical").length,
        };
      })
      .filter((g) => g.orders.length > 0);
  }, [result, urgencyFilter, search, sortKey]);

  const ready = health?.calculation_ready ?? false;
  const wapeOurs = bt?.test.regular_vs_clean.trend.wape;
  const wapeExcel = bt?.test.regular_vs_clean.naive_90d.wape;

  const tabs: [Tab, string, string | null][] = [
    ["orders", "Заказы", result ? fmt(result.summary.positions) : null],
    ["signals", "Сигналы продаж", null],
    ["news", "Рынок и СМИ", null],
    ["accuracy", "Точность прогноза", wapeOurs != null ? `${fmt(wapeOurs, 1)} %` : null],
    ["overstock", "Избытки", over ? fmt(over.overstock_positions + over.dead_positions) : null],
    ["impact", "Против Excel", null],
    ["trends", "Тренды категорий", null],
  ];

  return (
    <div className="min-h-screen bg-page text-zinc-900">
      <header className="border-b-[3px] border-accent-400 bg-white shadow-sm">
        <div className="bg-brand-900 text-white">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-1.5 text-xs sm:px-6">
            <span className="font-medium">Сервис отдела закупа · автоматический расчёт заказов поставщикам</span>
            <span className="text-white/70">прототип HackAlem AI 2026 · команда Ads Tech</span>
          </div>
        </div>
        <div className="mx-auto max-w-[1500px] px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-4">
              <img src="/ekt-logo.svg" alt="Группа компаний Электрокомплект" className="h-8 w-auto shrink-0 sm:h-9" />
              <div className="min-w-0 border-l border-zinc-200 pl-4">
                <h1 className="text-lg font-bold leading-tight text-brand-900">Заказы поставщикам</h1>
                <p className="truncate text-xs text-zinc-500">{health?.data.source || "отдел закупа"}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-zinc-500">
                Утверждено заказов: <b className="text-zinc-800">{approvedCount}</b>
              </span>
              <button onClick={() => setTourOn(true)} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50">
                Обучение
              </button>
              <button
                data-tour="data"
                onClick={() => setShowData(!showData)}
                aria-expanded={showData}
                className={`rounded-md border px-3 py-1.5 font-medium ${showData ? "border-brand-600 bg-brand-50 text-brand-900" : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"}`}
              >
                Данные и импорт
              </button>
              <button data-tour="brief" onClick={loadBrief} disabled={briefBusy || !health} className="rounded-md bg-brand-600 px-3 py-1.5 font-semibold text-white hover:bg-brand-900 disabled:opacity-50">
                {briefBusy ? "Агент работает…" : "Утренняя сводка агента"}
              </button>
              {user.role === "admin" && (
                <button data-tour="admin" onClick={onAdmin} className="rounded-md bg-brand-900 px-3 py-1.5 font-semibold text-white hover:bg-brand-700">
                  Администрирование
                </button>
              )}
              <span className="flex items-center gap-2 border-l border-zinc-200 pl-2">
                <span className="text-zinc-600" title={user.username}>
                  {user.name} · {user.role_label ?? user.role}
                </span>
                <button onClick={onLogout} className="rounded-md border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-50">
                  Выйти
                </button>
              </span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <Chip ok={!!health && !healthErr} label={healthErr ? `сервер недоступен: ${healthErr}` : health ? `сервер ok · ${health.demo_mode ? "DEMO без LLM" : health.model}` : "подключение…"} />
            {health && (
              <>
                <Chip label={`${fmt(health.data.skus)} артикулов`} />
                <Chip label={`продажи ${health.data.sales_from} … ${health.data.sales_to}`} />
                <Chip label={`${health.data.suppliers} поставщ. · ${fmt(health.data.in_transit_lines)} поз. в пути · ${fmt(health.data.stockout_periods)} периодов дефицита`} />
                <Chip ok={ready} label={ready ? "расчёт готов" : "идёт предрасчёт…"} />
                {health.data.notes && health.data.notes.length > 0 && (
                  <button onClick={() => setShowData(true)} className="rounded-full bg-accent-300/40 px-2.5 py-1 text-brand-900 ring-1 ring-accent-400 hover:bg-accent-300/70">
                    Допущения данных ({health.data.notes.length})
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {showData && health && (
          <div className="border-t border-zinc-200 bg-zinc-50">
            <div className="mx-auto grid max-w-[1500px] gap-4 px-4 py-4 text-xs sm:px-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <div>
                <div className="font-semibold text-brand-900">Источник: {health.data.source}</div>
                <p className="mt-0.5 text-zinc-500">Что взято из данных, а что принято допущением:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-700">
                  {(health.data.notes ?? []).map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-md border border-zinc-200 bg-white p-3">
                <div className="font-semibold text-brand-900">Импорт выгрузок 1С</div>
                <p className="mt-1 text-zinc-600">12 файлов Excel по IEK и Systeme Electric как есть: продажи, остатки, товар в пути, MOQ, сезонность.</p>
                <label className="mt-2 inline-block cursor-pointer rounded-md bg-brand-900 px-3 py-1.5 font-medium text-white hover:bg-brand-700">
                  {importing ? "Импорт…" : "Выбрать файлы xlsx"}
                  <input type="file" accept=".xlsx" multiple className="hidden" onChange={onImportPartner} disabled={importing} />
                </label>
              </div>
              <div className="rounded-md border border-zinc-200 bg-white p-3">
                <div className="font-semibold text-brand-900">Заменить одну таблицу (CSV)</div>
                <select value={uploadKind} onChange={(e) => setUploadKind(e.target.value)} className={`${SELECT} mt-2 text-xs`}>
                  {UPLOAD_KINDS.map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </select>
                <label className="mt-2 inline-block cursor-pointer rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50">
                  Выбрать CSV
                  <input type="file" accept=".csv" className="hidden" onChange={onUpload} />
                </label>
              </div>
              {uploadMsg && <p className="rounded-md bg-white px-3 py-2 text-zinc-700 ring-1 ring-zinc-200 lg:col-span-3">{uploadMsg}</p>}
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {/* parameters */}
          <section data-tour="params" className="rounded-md border border-zinc-200 bg-white p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
              <Field label="Склад">
                <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className={SELECT}>
                  {(health?.data.warehouses ?? []).map((w) => (
                    <option key={w} value={w}>{w}</option>
                  ))}
                </select>
              </Field>
              <Field label="Категория">
                <select value={category} onChange={(e) => setCategory(e.target.value)} className={SELECT}>
                  <option value="">Все категории</option>
                  {(health?.data.categories ?? []).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="Уровень сервиса">
                <select value={serviceLevel} onChange={(e) => setServiceLevel(e.target.value)} className={SELECT}>
                  <option value="">по категории</option>
                  <option value="0.9">90 %</option>
                  <option value="0.95">95 %</option>
                  <option value="0.98">98 %</option>
                </select>
              </Field>
              <Field label="Период между заказами">
                <select value={reviewDays} onChange={(e) => setReviewDays(Number(e.target.value))} className={SELECT}>
                  {[7, 14, 30].map((d) => (
                    <option key={d} value={d}>{d} дней</option>
                  ))}
                </select>
              </Field>
              <Field label="Плановый прирост, %/год">
                <input type="number" value={growthPlan} onChange={(e) => setGrowthPlan(e.target.value)} placeholder="0" className={SELECT} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-100 pt-3">
              <label data-tour="calib" className="flex items-center gap-2 text-sm text-zinc-700" title="Множитель страхового запаса подобран бэктестом так, чтобы фактическое покрытие спроса соответствовало заявленному уровню сервиса">
                <input type="checkbox" checked={ssCalibrated} onChange={(e) => setSsCalibrated(e.target.checked)} className="h-4 w-4 accent-[#2c7294]" />
                Калибровать страховой запас по бэктесту{health?.ss_multiplier && health.ss_multiplier !== 1 ? ` (×${health.ss_multiplier.toLocaleString("ru-RU")})` : ""}
              </label>
              <span className="text-xs text-zinc-500">
                {running
                  ? "Считаю: очистка выбросов, восстановление дефицита, сезонность, страховой запас…"
                  : runErr
                    ? ""
                    : result
                      ? `Дата расчёта ${result.today} · ${result.elapsed_ms > 0 ? `посчитано за ${fmt(result.elapsed_ms / 1000, 1)} с` : "из кэша"}`
                      : !ready
                        ? "Идёт предрасчёт после запуска, можно нажимать сразу"
                        : ""}
              </span>
              <label className="flex items-center gap-2 text-sm text-zinc-700" title="Добавить в заказ проектный спрос из чатов продажников, взвешенный по вероятности">
                <input type="checkbox" checked={includeSignals} onChange={(e) => setIncludeSignals(e.target.checked)} className="h-4 w-4 accent-[#2c7294]" />
                Учитывать сигналы продаж
              </label>
              {runErr && <span className="text-sm text-red-700">Ошибка: {runErr}</span>}
              <button data-tour="run" onClick={run} disabled={running || !health} className="ml-auto rounded-md bg-accent-400 px-6 py-2 text-sm font-bold text-brand-900 shadow-sm hover:bg-accent-500 disabled:opacity-50">
                {running ? "Считаю…" : "Рассчитать"}
              </button>
            </div>
            {running && <div className="mt-3 h-1 w-full animate-pulse rounded bg-brand-200" />}
          </section>

          {!result && !running && (
            <section className="rounded-md border border-dashed border-zinc-300 bg-white p-10 text-center text-zinc-500">
              <p className="text-base text-zinc-700">Выберите склад и категорию и нажмите «Рассчитать».</p>
              <p className="mx-auto mt-1 max-w-2xl text-sm">
                Сервис учтёт историю продаж, остатки, товар в пути, периоды дефицита, сезонность, тренд и MOQ поставщика, исключит разовые крупные заказы и объяснит каждую цифру. Или начните с утренней сводки агента.
              </p>
            </section>
          )}

          {result && (
            <>
              <section data-tour="stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Позиций к заказу" value={fmt(result.summary.positions)} sub={`у ${result.summary.suppliers} поставщиков · ${fmt(result.summary.total_qty)} шт`} />
                <Stat label="Критичных" value={fmt(result.summary.critical)} tone="red" sub="запаса меньше, чем срок поставки" />
                <Stat label="Высокий приоритет" value={fmt(result.summary.high)} tone="amber" sub="заказать в этом цикле" />
                <Stat
                  label="Сумма заказа"
                  value={result.summary.total_value ? fmtMoney(result.summary.total_value) : "—"}
                  sub={result.summary.value_known_positions != null ? `себестоимость известна для ${fmt(result.summary.value_known_positions)} из ${fmt(result.summary.positions)}` : ""}
                />
                <Stat label="Ошибка прогноза" value={wapeOurs != null ? `${fmt(wapeOurs, 1)} %` : "…"} tone="brand" sub={wapeExcel != null ? `у Excel-среднего ${fmt(wapeExcel, 1)} % · бэктест` : "бэктест считается"} />
                <Stat label="Исключено разовых продаж" value={fmt(result.summary.outliers_excluded_total)} sub="не завышают регулярный спрос" />
                <Stat label="Упущенный спрос" value={`${fmt(result.summary.lost_demand_total)} шт`} sub="восстановлен в периодах дефицита" />
                <Stat label="Избыток на складе" value={over ? `${fmt(over.overstock_positions)} поз.` : "…"} tone="amber" sub={over ? `запас > ${over.months_threshold} мес.; ${fmt(over.dead_positions)} без продаж полгода` : "считается"} />
              </section>

              <nav data-tour="tabs" className="flex gap-1 overflow-x-auto border-b border-zinc-200" aria-label="Разделы">
                {tabs.map(([id, label, badge]) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    aria-current={tab === id}
                    className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === id ? "border-brand-600 text-brand-900" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}
                  >
                    {label}
                    {badge && <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] ${tab === id ? "bg-brand-100 text-brand-900" : "bg-zinc-100 text-zinc-600"}`}>{badge}</span>}
                  </button>
                ))}
              </nav>

              {tab === "orders" && (
                <>
                  <section className="flex flex-wrap items-center gap-2">
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Артикул или название" aria-label="Поиск по артикулу или названию" className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm sm:w-56" />
                    {(["", "critical", "high", "normal"] as const).map((u) => (
                      <button key={u} onClick={() => setUrgencyFilter(u)} className={`rounded-full border px-3 py-1 text-xs ${urgencyFilter === u ? "border-brand-600 bg-brand-600 text-white" : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"}`}>
                        {u === "" ? "Все" : u === "critical" ? "Критичные" : u === "high" ? "Высокие" : "Плановые"}
                      </button>
                    ))}
                    <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700" aria-label="Сортировка">
                      <option value="urgency">по срочности</option>
                      <option value="value">по сумме заказа</option>
                      <option value="qty">по количеству</option>
                      <option value="cover">по дням покрытия</option>
                    </select>
                    <span className="flex gap-2 sm:ml-auto">
                      <a href={api.exportUrl("xlsx")} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">Экспорт XLSX</a>
                      <a href={api.exportUrl("csv")} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">CSV для 1С</a>
                    </span>
                  </section>
                  {groups.length === 0 ? (
                    <p className="rounded-md border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">Нет позиций под текущие фильтры.</p>
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
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                    <span>Надёжность прогноза:</span>
                    {[
                      ["bg-emerald-500", "высокая, ошибка ≤ 25 %"],
                      ["bg-amber-400", "средняя, ≤ 50 %"],
                      ["bg-red-400", "низкая, проверить глазами"],
                      ["bg-zinc-300", "штучный спрос"],
                    ].map(([c, l]) => (
                      <span key={l} className="flex items-center gap-1">
                        <i className={`inline-block h-2 w-2 rounded-full ${c}`} />
                        {l}
                      </span>
                    ))}
                  </p>
                </>
              )}

              {tab === "signals" && <SignalsTab onOpenSku={openSku} onChanged={() => result && run()} />}
              {tab === "news" && <NewsTab />}

              {tab === "accuracy" &&
                (bt ? (
                  <section className="rounded-md border border-zinc-200 bg-white p-4">
                    <h2 className="text-sm font-semibold text-brand-900">Честная проверка на отложенных данных</h2>
                    <p className="mt-1 text-xs text-zinc-600">
                      Модель обучена только на данных до {bt.test.cutoff}, прогноз на {bt.test.months.join(", ")} сравнён с фактом. {fmt(bt.test.regular_skus)} регулярных артикулов из {fmt(bt.test.skus_evaluated)}. WAPE = суммарная ошибка в % от продаж, меньше лучше.
                    </p>
                    <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="text-left uppercase tracking-wide text-zinc-500">
                            <tr>
                              <th className="py-1">Метод</th>
                              <th className="py-1 pl-3 text-right">WAPE</th>
                              <th className="py-1 pl-3 text-right">Смещение</th>
                              <th className="py-1 pl-3 text-right">К сырым продажам</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bt.models.map((m) => {
                              const a = bt.test.regular_vs_clean[m];
                              const r = bt.test.regular_vs_raw[m];
                              const prod = m === bt.production.model;
                              return (
                                <tr key={m} className={`border-t border-zinc-100 ${prod ? "bg-brand-50 font-semibold text-brand-900" : ""}`}>
                                  <td className="py-1.5 pr-2">{bt.labels[m]}</td>
                                  <td className="py-1.5 pl-3 text-right tabular-nums">{fmt(a.wape, 1)} %</td>
                                  <td className="py-1.5 pl-3 text-right tabular-nums">{a.bias != null && a.bias > 0 ? "+" : ""}{fmt(a.bias, 1)} %</td>
                                  <td className="py-1.5 pl-3 text-right tabular-nums text-zinc-500">{fmt(r.wape, 1)} %</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="space-y-2 text-xs text-zinc-700">
                        <div className="rounded-md bg-brand-50 p-3">
                          <div className="font-semibold text-brand-900">Страховой запас: обещание против факта</div>
                          <p className="mt-1">
                            Цель {fmt(bt.test.calibration.target_pct)} % артикулов без дефицита. Без калибровки фактически {fmt(bt.test.calibration.coverage_raw_pct, 1)} %. С множителем ×{fmt(bt.test.calibration.multiplier_from_previous_window, 1)}, подобранным на предыдущем окне, вне выборки {fmt(bt.test.calibration.coverage_out_of_sample_pct, 1)} %. В работе множитель ×{fmt(bt.production.ss_multiplier, 1)} по последнему окну, его можно выключить в параметрах расчёта.
                          </p>
                        </div>
                        <div className="rounded-md bg-accent-300/20 p-3">
                          <div className="font-semibold text-brand-900">Что показала проверка</div>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4">
                            <li>Очистка разовых заказов и дефицита снижает ошибку с {fmt(bt.test.regular_vs_clean.ours_no_cleaning.wape, 1)} % до {fmt(bt.test.regular_vs_clean.trend.wape, 1)} %.</li>
                            <li>Авто-выбор модели по артикулу ({fmt(bt.test.regular_vs_clean.auto.wape, 1)} %) не обыграл единую модель, поэтому не включён.</li>
                            <li>Нерегулярные артикулы любой метод прогнозирует с ошибкой около {fmt(bt.test.intermittent_vs_clean.trend.wape, 0)} %: для них в таблице метка надёжности.</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  </section>
                ) : (
                  <Placeholder text="Бэктест считается в фоне после запуска сервера. Раздел обновится сам." />
                ))}

              {tab === "overstock" &&
                (over ? (
                  <section className="rounded-md border border-amber-200 bg-white p-4">
                    <h2 className="text-sm font-semibold text-brand-900">Не заказывать, разгружать</h2>
                    <p className="mt-1 text-sm text-zinc-700">
                      Запас больше чем на {over.months_threshold} мес.: <b>{fmt(over.overstock_positions)}</b> поз., {fmt(over.overstock_units)} шт{over.overstock_value ? ` (≈ ${fmtMoney(over.overstock_value)})` : ""}. Без продаж полгода: <b>{fmt(over.dead_positions)}</b> поз., {fmt(over.dead_units)} шт{over.dead_value ? ` (≈ ${fmtMoney(over.dead_value)})` : ""}.
                    </p>
                    <div className="mt-3 grid gap-4 xl:grid-cols-2">
                      <MiniTable
                        title="Избыток, топ-15"
                        rows={over.overstock.slice(0, 15).map((r) => ({ sku: r.sku, name: r.name, a: `${r.months_of_cover} мес.`, b: `${fmt(r.excess_units)} шт${r.excess_value ? ` · ${fmtMoney(r.excess_value)}` : ""}` }))}
                        onOpen={openSku}
                      />
                      <MiniTable
                        title="Без продаж 6 месяцев, топ-15"
                        rows={over.dead.slice(0, 15).map((r) => ({ sku: r.sku, name: r.name, a: `${fmt(r.stock)} шт`, b: r.value ? fmtMoney(r.value) : "" }))}
                        onOpen={openSku}
                      />
                    </div>
                    <p className="mt-3 text-xs text-zinc-500">{over.note}</p>
                  </section>
                ) : (
                  <Placeholder text="Отчёт об избытках считается…" />
                ))}

              {tab === "impact" &&
                (impact ? (
                  <section className="rounded-md border border-zinc-200 bg-white p-4">
                    <h2 className="text-sm font-semibold text-brand-900">Что изменится относительно расчёта «среднее за 90 дней» в Excel</h2>
                    <p className="mt-1 text-sm text-zinc-700">
                      Excel заказал бы лишних <b className="text-amber-700">{fmt(impact.naive_overorder_qty)} шт</b>
                      {impact.naive_overorder_money > 0 && <> (≈ {fmtMoney(impact.naive_overorder_money)})</>} и недозаказал <b className="text-red-700">{fmt(impact.naive_underorder_qty)} шт</b>
                      {impact.naive_underorder_money > 0 && <> (≈ {fmtMoney(impact.naive_underorder_money)})</>} по {fmt(impact.positions_differ)} позициям из {fmt(impact.positions)}.
                    </p>
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-left uppercase tracking-wide text-zinc-500">
                          <tr>
                            <th className="py-1">Товар</th>
                            <th className="py-1 pl-3 text-right">Excel</th>
                            <th className="py-1 pl-3 text-right">Сервис</th>
                            <th className="py-1 pl-3 text-right">Разница, ₸</th>
                            <th className="py-1 pl-3">Причина расхождения</th>
                          </tr>
                        </thead>
                        <tbody>
                          {impact.top.map((t) => (
                            <tr key={t.sku} className="border-t border-zinc-100">
                              <td className="max-w-[340px] py-1.5 pr-2">
                                <button className="font-mono text-brand-600 hover:underline" onClick={() => openSku(t.sku)}>{t.sku}</button>{" "}
                                <span className="text-zinc-700">{t.name}</span>
                              </td>
                              <td className="py-1.5 pl-3 text-right tabular-nums">{fmt(t.naive_qty)}</td>
                              <td className="py-1.5 pl-3 text-right tabular-nums font-semibold">{fmt(t.recommended_qty)}</td>
                              <td className={`py-1.5 pl-3 text-right tabular-nums ${t.diff_money > 0 ? "text-amber-700" : "text-red-700"}`}>{t.diff_money ? fmtMoney(t.diff_money) : "—"}</td>
                              <td className="py-1.5 pl-3 text-zinc-600">{t.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">{impact.note} Положительная разница: Excel заказал бы больше, отрицательная: меньше.</p>
                  </section>
                ) : (
                  <Placeholder text="Сравнение с Excel считается…" />
                ))}

              {tab === "trends" &&
                (trends && trends.categories.length > 0 ? (
                  <section className="rounded-md border border-zinc-200 bg-white p-4">
                    <h2 className="text-sm font-semibold text-brand-900">Спрос по категориям за последние {trends.months.length} мес.</h2>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                          <tr>
                            <th className="py-1">Категория</th>
                            <th className="py-1">Динамика</th>
                            <th className="py-1 text-right">Всего, шт</th>
                            <th className="py-1 text-right">Рост</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trends.categories.map((c) => (
                            <tr key={c.category} className="border-t border-zinc-100">
                              <td className="py-1.5 pr-3">{c.category}</td>
                              <td className="py-1.5">
                                <Sparkline values={c.qty} />
                              </td>
                              <td className="py-1.5 text-right tabular-nums">{fmt(c.total)}</td>
                              <td className={`py-1.5 text-right tabular-nums ${c.growth_pct > 5 ? "text-emerald-700" : c.growth_pct < -5 ? "text-red-700" : "text-zinc-600"}`} title={c.growth_basis}>
                                {c.growth_pct > 0 ? "+" : ""}
                                {fmt(c.growth_pct, 1)} %
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ) : (
                  <Placeholder text="Тренды считаются…" />
                ))}
            </>
          )}
        </div>

        <div data-tour="assistant" className="lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]">
          <Assistant focusSku={detailSku ?? result?.orders.find((o) => o.urgency === "critical")?.sku} demoMode={health?.demo_mode ?? true} />
        </div>
      </main>

      <footer className="mx-auto max-w-[1500px] px-4 pb-8 text-xs text-zinc-500 sm:px-6">
        {health?.data.source ? `${health.data.source} · ` : ""}
        {result ? `расчёт на ${result.today} · ` : ""}
        {bt ? `бэктест: обучение до ${bt.test.cutoff}, проверка ${bt.test.months[0]}…${bt.test.months[bt.test.months.length - 1]} · ` : ""}
        заказы не отправляются поставщикам автоматически, утверждает ответственный сотрудник.
      </footer>

      {(brief || briefErr) && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
          onClick={() => {
            setBrief(null);
            setBriefErr(null);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-md bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-brand-900">Утренняя сводка агента-закупщика</h2>
                <p className="text-xs text-zinc-500">{brief ? `${brief.generated_at} · ${brief.llm ? "приоритеты сформулированы LLM, факты из инструментов движка" : "без LLM: шаблон по фактам инструментов"}` : ""}</p>
              </div>
              <button
                onClick={() => {
                  setBrief(null);
                  setBriefErr(null);
                }}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
              >
                Закрыть
              </button>
            </div>
            {briefErr && <p className="mt-3 text-sm text-red-700">Ошибка: {briefErr}</p>}
            {brief && (
              <>
                <pre className="mt-4 whitespace-pre-wrap rounded-md bg-zinc-50 p-4 font-sans text-sm leading-relaxed text-zinc-800">{brief.brief}</pre>
                <div className="mt-4">
                  <div className="mb-1 text-xs font-semibold text-zinc-600">Шаги агента</div>
                  <ul className="space-y-1">
                    {brief.steps.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs">
                        <span className="min-w-[180px]">
                          <span className="block font-semibold text-brand-900">{s.label ?? s.tool}</span>
                          <span className="font-mono text-[10px] text-zinc-400">{s.tool}</span>
                        </span>
                        <span className="flex-1 text-zinc-600">{s.summary || s.result}</span>
                        {s.ms !== undefined && <span className="text-zinc-400">{s.ms} мс</span>}
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="mt-3 text-xs text-amber-800">Агент готовит черновики и сводку; утверждение и отправка заказов остаются за менеджером.</p>
              </>
            )}
          </div>
        </div>
      )}

      {detailSku && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={() => setDetailSku(null)}>
          <div className="h-full w-full max-w-3xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-mono text-sm text-brand-600">{detailSku}</div>
                <h2 className="text-lg font-semibold text-brand-900">{detail?.name ?? "…"}</h2>
                {detail && (
                  <p className="text-sm text-zinc-500">
                    {detail.category} · {detail.supplier} · срок поставки {detail.lead_time_days} дн. · <UrgencyBadge u={detail.urgency} />
                  </p>
                )}
              </div>
              <button onClick={() => setDetailSku(null)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm">
                Закрыть
              </button>
            </div>
            {detailErr && <p className="mt-4 text-sm text-red-700">Ошибка: {detailErr}</p>}
            {!detail && !detailErr && <p className="mt-4 text-sm text-zinc-500">Загрузка…</p>}
            {detail && (
              <>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Рекомендовано" value={`${fmt(detail.recommended_qty)} шт`} tone="brand" />
                  <Stat label="Остаток / в пути" value={`${fmt(detail.stock)} / ${fmt(detail.in_transit)}`} />
                  <Stat label="Прогноз в день" value={fmt(detail.forecast_daily, 1)} />
                  <Stat label="Покрытие" value={`${detail.days_of_cover >= 999 ? "∞" : fmt(detail.days_of_cover)} дн.`} sub={detail.order_by ? `заказать до ${detail.order_by}` : ""} />
                  <Stat label="Страховой запас" value={fmt(detail.safety_stock)} sub={detail.ss_multiplier && detail.ss_multiplier !== 1 ? `калибровка ×${fmt(detail.ss_multiplier, 1)}` : ""} />
                  <Stat label="Надёжность прогноза" value={detail.forecast_confidence ?? "—"} sub={detail.forecast_wape != null ? `ошибка на бэктесте ${Math.round(detail.forecast_wape)} %` : ""} />
                  <Stat label="Исключено разовых" value={fmt(detail.outliers_excluded)} sub={detail.outlier_qty_excluded ? `${fmt(detail.outlier_qty_excluded)} шт` : ""} />
                  <Stat label="Упущенный спрос" value={`${fmt(detail.lost_demand_qty)} шт`} sub={detail.stockout_days ? `${detail.stockout_days} дн. дефицита` : "дефицита не было"} />
                </div>
                <div className="mt-5">
                  <h3 className="mb-2 text-sm font-semibold">Продажи по месяцам, очищенный спрос и прогноз</h3>
                  <SkuChart d={detail} />
                </div>
                <p className="mt-4 rounded-md bg-zinc-50 p-3 text-sm leading-relaxed text-zinc-800">{detail.justification}</p>
                {(detail.outliers.length > 0 || detail.stockouts.length > 0) && (
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    {detail.outliers.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Исключённые разовые продажи</h4>
                        <ul className="mt-1 space-y-1 text-sm">
                          {detail.outliers.slice(0, 8).map((o, i) => (
                            <li key={i} className="flex justify-between gap-2">
                              <span className="text-zinc-600">{o.date} · {o.client_id}</span>
                              <span className="tabular-nums">
                                {fmt(o.qty)} шт <span className="text-xs text-zinc-400">({o.reason})</span>
                              </span>
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
                              <span className="text-zinc-600">
                                {s.from} … {s.to} ({s.days} дн.)
                              </span>
                              <span className="tabular-nums">упущено {fmt(s.lost_demand_qty)} шт</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-5 rounded-md border border-zinc-200 p-4">
                  <h3 className="text-sm font-semibold">Что если</h3>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <Field label="В пути, шт">
                      <input type="number" value={whatIf.in_transit} onChange={(e) => setWhatIf({ ...whatIf, in_transit: e.target.value })} placeholder={String(detail.in_transit)} className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                    </Field>
                    <Field label="Остаток, шт">
                      <input type="number" value={whatIf.stock} onChange={(e) => setWhatIf({ ...whatIf, stock: e.target.value })} placeholder={String(detail.stock)} className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                    </Field>
                    <Field label="Срок поставки, дн.">
                      <input type="number" value={whatIf.lead} onChange={(e) => setWhatIf({ ...whatIf, lead: e.target.value })} placeholder={String(detail.lead_time_days)} className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                    </Field>
                    <button onClick={runWhatIf} className="rounded-md bg-brand-900 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">
                      Пересчитать
                    </button>
                  </div>
                  {whatIfRes && (
                    <div className="mt-3 text-sm">
                      <p>
                        Было <b>{fmt(whatIfRes.base_qty)}</b>, станет <b>{fmt(whatIfRes.scenario_qty)}</b>{" "}
                        <span className={whatIfRes.delta < 0 ? "text-emerald-700" : whatIfRes.delta > 0 ? "text-red-700" : "text-zinc-500"}>
                          ({whatIfRes.delta > 0 ? "+" : ""}
                          {fmt(whatIfRes.delta)})
                        </span>
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
      {tourOn && <Tour steps={TOUR_STEPS} onClose={closeTour} onAction={(a) => a === "run" && !result && !running && run()} />}
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return <p className="rounded-md border border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-500">{text}</p>;
}

function MiniTable({ title, rows, onOpen }: { title: string; rows: { sku: string; name: string; a: string; b: string }[]; onOpen: (sku: string) => void }) {
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      <table className="mt-1 w-full table-fixed text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.sku} className="border-t border-zinc-100">
              <td className="w-24 py-1.5 pr-2 font-mono">
                <button className="text-brand-600 hover:underline" onClick={() => onOpen(r.sku)}>{r.sku}</button>
              </td>
              <td className="truncate py-1.5 pr-2 text-zinc-700" title={r.name}>{r.name}</td>
              <td className="w-16 py-1.5 pr-2 text-right tabular-nums">{r.a}</td>
              <td className="w-32 py-1.5 text-right tabular-nums text-zinc-600">{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 160;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * (w - 2) + 1},${h - 1 - (v / max) * (h - 4)}`).join(" ");
  return (
    <svg width={w} height={h} className="block" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="#0b4366" strokeWidth={1.5} />
    </svg>
  );
}

function Chip({ label, ok }: { label: string; ok?: boolean }) {
  const tone = ok === undefined ? "bg-zinc-100 text-zinc-600" : ok ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  return <span className={`rounded-full px-2.5 py-1 ${tone}`}>{label}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-500">
      {label}
      {children}
    </label>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "red" | "amber" | "brand" }) {
  const cls = tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : tone === "brand" ? "text-brand-600" : "text-zinc-900";
  return (
    <div className="flex min-h-[96px] flex-col rounded-md border border-zinc-200 bg-white px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="mt-auto pt-1 text-[11px] leading-tight text-zinc-500">{sub}</div>}
    </div>
  );
}

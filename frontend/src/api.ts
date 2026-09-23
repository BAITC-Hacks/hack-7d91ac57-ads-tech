// Typed client for the backend contract (docs/API.md)
const BASE = import.meta.env.VITE_API_URL || "";

export type Urgency = "critical" | "high" | "normal" | "none";

export type Order = {
  sku: string;
  name: string;
  article?: string;
  category: string;
  warehouse: string;
  supplier_id: string;
  supplier: string;
  recommended_qty: number;
  raw_need: number;
  pack_size: number;
  moq: number;
  urgency: Urgency;
  days_of_cover: number;
  stockout_date: string | null;
  order_by: string | null;
  order_value: number;
  unit_price: number;
  lead_time_days: number;
  review_days: number;
  service_level: number;
  stock: number;
  in_transit: number;
  avg_daily_raw_90d: number;
  forecast_daily: number;
  forecast_period_qty: number;
  forecast_parts: { month: string; days: number; forecast: number; seasonal_index: number }[];
  safety_stock: number;
  sigma_daily: number;
  seasonal_factor: number;
  trend_pct_month: number;
  trend_r2: number;
  plan_pct_year: number;
  stockout_days: number;
  lost_demand_qty: number;
  lost_demand_uplift_pct: number;
  outliers_excluded: number;
  outlier_qty_excluded: number;
  justification: string;
  forecast_wape?: number | null;
  forecast_confidence?: string;
  ss_multiplier?: number;
};

export type SupplierGroup = {
  supplier_id: string;
  supplier: string;
  lead_time_days: number;
  moq: number;
  email: string;
  positions: number;
  total_qty: number;
  total_value?: number;
  critical: number;
  orders: Order[];
};

export type RunResult = {
  generated_at: string;
  elapsed_ms: number;
  today: string;
  params: Record<string, unknown>;
  summary: {
    positions: number;
    suppliers: number;
    critical: number;
    high: number;
    normal: number;
    total_qty: number;
    total_value?: number;
    value_known_positions?: number;
    lost_demand_total: number;
    outliers_excluded_total: number;
  };
  suppliers: SupplierGroup[];
  orders: Order[];
};

export type Health = {
  status: string;
  demo_mode: boolean;
  model: string;
  tools: string[];
  calculation_ready: boolean;
  backtest_ready?: boolean;
  ss_multiplier?: number;
  data: {
    skus: number;
    categories: string[];
    warehouses: string[];
    suppliers: number;
    sales_rows: number;
    sales_from: string;
    sales_to: string;
    stockout_periods: number;
    in_transit_lines: number;
    today: string;
    default_warehouse: string;
    source?: string;
    notes?: string[];
  };
};

export type SkuDetail = Order & {
  monthly: { month: string; raw: number | null; cleaned: number | null; forecast: number | null }[];
  outliers: { date: string; qty: number; client_id: string; reason: string }[];
  stockouts: { from: string; to: string; days: number; lost_demand_qty: number }[];
  seasonal_index: Record<string, number>;
};

export type Impact = {
  positions: number;
  positions_differ: number;
  naive_overorder_qty: number;
  naive_overorder_money: number;
  naive_underorder_qty: number;
  naive_underorder_money: number;
  note: string;
  top: { sku: string; name: string; supplier: string; naive_qty: number; recommended_qty: number; diff_qty: number; diff_money: number; reason: string }[];
};

type Wm = { wape: number | null; bias: number | null };
export type BacktestWindow = {
  cutoff: string;
  months: string[];
  skus_evaluated: number;
  regular_skus: number;
  regular_vs_clean: Record<string, Wm>;
  regular_vs_raw: Record<string, Wm>;
  intermittent_vs_clean: Record<string, Wm>;
  wins_regular: Record<string, number>;
  calibration: { skus: number; target_pct: number; coverage_raw_pct: number | null; multiplier: number; coverage_calibrated_in_sample_pct: number | null; multiplier_from_previous_window: number | null; coverage_out_of_sample_pct: number | null };
};
export type Backtest = { warehouse: string; labels: Record<string, string>; models: string[]; validation: BacktestWindow; test: BacktestWindow; production: { model: string; ss_multiplier: number; skus_with_error: number }; note: string };

export type Overstock = {
  warehouse: string;
  months_threshold: number;
  overstock_positions: number;
  overstock_units: number;
  overstock_value: number;
  dead_positions: number;
  dead_units: number;
  dead_value: number;
  note: string;
  overstock: { sku: string; name: string; category: string; supplier: string; stock: number; in_transit: number; forecast_daily: number; months_of_cover: number; excess_units: number; excess_value: number }[];
  dead: { sku: string; name: string; category: string; supplier: string; stock: number; value: number; last_sale_months: number }[];
};

export type CategoryTrends = {
  warehouse: string;
  months: string[];
  categories: { category: string; months: string[]; qty: number[]; total: number; growth_pct: number; growth_basis: string }[];
};

export type ChatStep = { tool: string; args: string; result: string; ms?: number };
export type DailyBrief = { brief: string; facts: Record<string, unknown>; steps: ChatStep[]; llm: boolean; generated_at: string };
export type ChatResponse = { answer: string; steps: ChatStep[]; latency_ms: number };
export type Msg = { role: "user" | "assistant"; content: string };

export type ApprovedOrder = {
  order_id: string;
  supplier_id: string;
  supplier: string;
  lines: { sku: string; qty: number }[];
  total_qty: number;
  comment: string;
  approved_by: string;
  approved_at: string;
  status: string;
};

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const body = await r.json();
      detail = body.detail ? String(body.detail) : JSON.stringify(body);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export const api = {
  health: () => fetch(`${BASE}/api/health`).then((r) => j<Health>(r)),
  run: (body: { warehouse?: string | null; category?: string | null; service_level?: number | null; review_days?: number; growth_plan_pct_year?: number | null; ss_calibrated?: boolean }) =>
    fetch(`${BASE}/api/replenish/run`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) => j<RunResult>(r)),
  impact: () => fetch(`${BASE}/api/replenish/impact`).then((r) => j<Impact>(r)),
  backtest: async (): Promise<Backtest | null> => {
    const r = await fetch(`${BASE}/api/backtest`);
    if (r.status === 202) return null;
    return j<Backtest>(r);
  },
  overstock: (warehouse?: string) =>
    fetch(`${BASE}/api/replenish/overstock${warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : ""}`).then((r) => j<Overstock>(r)),
  dailyBrief: (warehouse?: string) =>
    fetch(`${BASE}/api/agent/daily-brief${warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : ""}`).then((r) => j<DailyBrief>(r)),
  orderEmail: (orderId: string) => fetch(`${BASE}/api/orders/${encodeURIComponent(orderId)}/email`).then((r) => j<{ to: string; subject: string; body: string }>(r)),
  importPartner: (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return fetch(`${BASE}/api/data/import_partner`, { method: "POST", body: fd }).then((r) => j<{ imported: Record<string, unknown>; summary: Record<string, unknown> }>(r));
  },
  categories: (warehouse?: string) =>
    fetch(`${BASE}/api/replenish/categories${warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : ""}`).then((r) => j<CategoryTrends>(r)),
  sku: (sku: string, warehouse?: string) =>
    fetch(`${BASE}/api/sku/${encodeURIComponent(sku)}${warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : ""}`).then((r) => j<SkuDetail>(r)),
  whatif: (body: { sku: string; warehouse?: string; in_transit?: number | null; stock?: number | null; lead_time_days?: number | null; service_level?: number | null }) =>
    fetch(`${BASE}/api/replenish/whatif`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) =>
      j<{ base: Order; scenario: Order; overrides: Record<string, number>; delta_qty: number }>(r)
    ),
  approve: (body: { supplier_id: string; lines: { sku: string; qty: number }[]; comment: string }) =>
    fetch(`${BASE}/api/orders/approve`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) => j<ApprovedOrder>(r)),
  orders: () => fetch(`${BASE}/api/orders`).then((r) => j<{ orders: ApprovedOrder[] }>(r)),
  exportUrl: (format: "csv" | "xlsx", supplier?: string) =>
    `${BASE}/api/export?format=${format}${supplier ? `&supplier=${encodeURIComponent(supplier)}` : ""}`,
  chat: (messages: Msg[]) =>
    fetch(`${BASE}/api/chat`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ messages }) }).then((r) => j<ChatResponse>(r)),
  upload: (kind: string, file: File) => {
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("file", file);
    return fetch(`${BASE}/api/data/upload`, { method: "POST", body: fd }).then((r) => j<{ kind: string; rows: number }>(r));
  },
};

export const fmt = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : n.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

export const URGENCY_LABEL: Record<Urgency, string> = { critical: "Критично", high: "Высокая", normal: "Плановая", none: "Не нужен" };
export const URGENCY_CLASS: Record<Urgency, string> = {
  critical: "bg-red-100 text-red-800 ring-red-200",
  high: "bg-amber-100 text-amber-800 ring-amber-200",
  normal: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  none: "bg-zinc-50 text-zinc-500 ring-zinc-200",
};

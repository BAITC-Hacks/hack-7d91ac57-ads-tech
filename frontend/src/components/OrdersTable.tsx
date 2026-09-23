import { useState } from "react";
import { api, fmt, URGENCY_CLASS, URGENCY_LABEL, type Order, type SupplierGroup } from "../api";

type Props = {
  groups: SupplierGroup[];
  qtyEdits: Record<string, number>;
  onEditQty: (sku: string, qty: number) => void;
  onOpenSku: (sku: string) => void;
  onApproved: (supplierId: string, orderId: string) => void;
  approved: Record<string, string>;
};

export function UrgencyBadge({ u }: { u: Order["urgency"] }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${URGENCY_CLASS[u]}`}>{URGENCY_LABEL[u]}</span>;
}

export default function OrdersTable({ groups, qtyEdits, onEditQty, onOpenSku, onApproved, approved }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(groups.map((g) => [g.supplier_id, true])));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SupplierGroup | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function doApprove(g: SupplierGroup) {
    setBusy(true);
    setErr(null);
    try {
      const lines = g.orders.map((o) => ({ sku: o.sku, qty: qtyEdits[o.sku] ?? o.recommended_qty })).filter((l) => l.qty > 0);
      const res = await api.approve({ supplier_id: g.supplier_id, lines, comment });
      onApproved(g.supplier_id, res.order_id);
      setConfirm(null);
      setComment("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const total = g.orders.reduce((s, o) => s + (qtyEdits[o.sku] ?? o.recommended_qty), 0);
        return (
          <section key={g.supplier_id} className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-3">
              <button onClick={() => setOpen({ ...open, [g.supplier_id]: !open[g.supplier_id] })} className="text-left">
                <span className="mr-2 text-zinc-400">{open[g.supplier_id] ? "▾" : "▸"}</span>
                <span className="font-semibold">{g.supplier}</span>
              </button>
              <span className="text-sm text-zinc-500">срок поставки {g.lead_time_days} дн.</span>
              <span className="text-sm text-zinc-500">{g.positions} поз. · {fmt(total)} шт</span>
              {g.critical > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">{g.critical} критичных</span>}
              <span className="ml-auto flex items-center gap-2">
                {approved[g.supplier_id] ? (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800">Утверждён {approved[g.supplier_id]}</span>
                ) : (
                  <button onClick={() => setConfirm(g)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
                    Утвердить заказ
                  </button>
                )}
                <a href={api.exportUrl("xlsx", g.supplier_id)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">
                  XLSX
                </a>
                <a href={api.exportUrl("csv", g.supplier_id)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">
                  CSV для 1С
                </a>
              </span>
            </header>
            {open[g.supplier_id] && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <tr className="border-b border-zinc-200">
                      <th className="px-4 py-2">Артикул</th>
                      <th className="px-2 py-2">Наименование</th>
                      <th className="px-2 py-2 text-right">Остаток</th>
                      <th className="px-2 py-2 text-right">В пути</th>
                      <th className="px-2 py-2 text-right">Прогноз/день</th>
                      <th className="px-2 py-2 text-right">Покрытие, дн.</th>
                      <th className="px-2 py-2 text-right">Заказать</th>
                      <th className="px-2 py-2">Срочность</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.orders.map((o) => {
                      const isOpen = expanded === o.sku;
                      return (
                        <>
                          <tr key={o.sku} className={`border-b border-zinc-100 hover:bg-zinc-50 ${isOpen ? "bg-indigo-50/40" : ""}`}>
                            <td className="px-4 py-2 font-mono text-xs">
                              <button className="text-indigo-700 hover:underline" onClick={() => onOpenSku(o.sku)} title="Открыть график и детали">
                                {o.sku}
                              </button>
                              {o.article && <div className="text-[10px] text-zinc-400">{o.article}</div>}
                            </td>
                            <td className="max-w-[320px] px-2 py-2">
                              <div className="truncate" title={o.name}>{o.name}</div>
                              <div className="text-xs text-zinc-400">{o.category}</div>
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{fmt(o.stock)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{fmt(o.in_transit)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{fmt(o.forecast_daily, 1)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{o.days_of_cover >= 999 ? "∞" : fmt(o.days_of_cover)}</td>
                            <td className="px-2 py-2 text-right">
                              <input
                                type="number"
                                min={0}
                                step={o.pack_size || 1}
                                value={qtyEdits[o.sku] ?? o.recommended_qty}
                                onChange={(e) => onEditQty(o.sku, Math.max(0, Number(e.target.value)))}
                                className={`w-24 rounded border px-2 py-1 text-right tabular-nums ${qtyEdits[o.sku] !== undefined && qtyEdits[o.sku] !== o.recommended_qty ? "border-amber-400 bg-amber-50" : "border-zinc-300"}`}
                              />
                              {qtyEdits[o.sku] !== undefined && qtyEdits[o.sku] !== o.recommended_qty && (
                                <div className="text-[10px] text-amber-700">рекомендовано {fmt(o.recommended_qty)}</div>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              <UrgencyBadge u={o.urgency} />
                            </td>
                            <td className="px-2 py-2 text-right">
                              <button onClick={() => setExpanded(isOpen ? null : o.sku)} className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
                                {isOpen ? "Скрыть" : "Почему?"}
                              </button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr key={`${o.sku}-x`} className="border-b border-zinc-200 bg-indigo-50/40">
                              <td colSpan={9} className="px-4 py-3">
                                <p className="text-sm leading-relaxed text-zinc-800">{o.justification}</p>
                                <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-zinc-600 sm:grid-cols-4 lg:grid-cols-6">
                                  <Kv k="Прогноз на период" v={`${fmt(o.forecast_period_qty)} шт / ${o.lead_time_days + o.review_days} дн.`} />
                                  <Kv k="Сезонный коэф." v={fmt(o.seasonal_factor, 2)} />
                                  <Kv k="Тренд" v={o.trend_pct_month ? `${o.trend_pct_month > 0 ? "+" : ""}${fmt(o.trend_pct_month, 1)} %/мес (R² ${fmt(o.trend_r2, 2)})` : "нет устойчивого"} />
                                  <Kv k="Страховой запас" v={`${fmt(o.safety_stock)} шт (${Math.round(o.service_level * 100)} %)`} />
                                  <Kv k="Упущенный спрос" v={o.lost_demand_qty ? `${fmt(o.lost_demand_qty)} шт за ${o.stockout_days} дн.` : "нет дефицита"} />
                                  <Kv k="Исключено разовых" v={o.outliers_excluded ? `${o.outliers_excluded} шт. на ${fmt(o.outlier_qty_excluded)}` : "нет"} />
                                  <Kv k="Кратность / MOQ" v={`${o.pack_size} / ${o.moq}`} />
                                  <Kv k="Потребность до округления" v={fmt(o.raw_need)} />
                                </div>
                                <button onClick={() => onOpenSku(o.sku)} className="mt-2 text-xs text-indigo-700 hover:underline">
                                  Открыть график и what-if →
                                </button>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      {confirm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => !busy && setConfirm(null)}>
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">Утвердить заказ: {confirm.supplier}</h3>
            <p className="mt-1 text-sm text-zinc-600">
              {confirm.orders.length} позиций, {fmt(confirm.orders.reduce((s, o) => s + (qtyEdits[o.sku] ?? o.recommended_qty), 0))} шт. Изменённые количества учтены.
            </p>
            <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-sm">
              {confirm.orders.map((o) => (
                <li key={o.sku} className="flex justify-between gap-3">
                  <span className="truncate"><span className="font-mono text-xs">{o.sku}</span> {o.name}</span>
                  <span className="tabular-nums">{fmt(qtyEdits[o.sku] ?? o.recommended_qty)}</span>
                </li>
              ))}
            </ul>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий (необязательно)" className="mt-3 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm" rows={2} />
            <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">Заказ не отправляется поставщику автоматически. Утверждение фиксирует решение ответственного сотрудника; отправка выполняется отдельно.</p>
            {err && <p className="mt-2 text-sm text-red-700">Ошибка: {err}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} disabled={busy} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm">Отмена</button>
              <button onClick={() => doApprove(confirm)} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {busy ? "Сохраняю…" : "Подтверждаю"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-400">{k}</div>
      <div className="text-zinc-800">{v}</div>
    </div>
  );
}

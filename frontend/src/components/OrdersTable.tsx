import { Fragment, useState } from "react";
import { api, CONFIDENCE_DOT, fmt, fmtMoney, URGENCY_CLASS, URGENCY_LABEL, type Order, type SupplierGroup } from "../api";

type Props = {
  groups: SupplierGroup[];
  qtyEdits: Record<string, number>;
  onEditQty: (sku: string, qty: number) => void;
  onOpenSku: (sku: string) => void;
  onApproved: (supplierId: string, orderId: string) => void;
  approved: Record<string, string>;
};

const PAGE = 25;

export function UrgencyBadge({ u }: { u: Order["urgency"] }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${URGENCY_CLASS[u]}`}>{URGENCY_LABEL[u]}</span>;
}

function ConfidenceDot({ o }: { o: Order }) {
  const c = o.forecast_confidence ?? "нет данных";
  const tip = `Надёжность прогноза: ${c}${o.forecast_wape != null ? `, ошибка на бэктесте ${Math.round(o.forecast_wape)} %` : ""}`;
  return <span title={tip} aria-label={tip} className={`ml-1.5 inline-block h-2 w-2 rounded-full align-middle ${CONFIDENCE_DOT[c] ?? "bg-zinc-200"}`} />;
}

const dm = (iso: string | null) => (iso ? iso.slice(5).split("-").reverse().join(".") : "—");

export default function OrdersTable({ groups, qtyEdits, onEditQty, onOpenSku, onApproved, approved }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SupplierGroup | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState<{ to: string; subject: string; body: string } | null>(null);

  async function showEmail(orderId: string) {
    try {
      setEmail(await api.orderEmail(orderId));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

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
        const isOpen = open[g.supplier_id] ?? true;
        const lim = limit[g.supplier_id] ?? PAGE;
        const rows = g.orders.slice(0, lim);
        const total = g.orders.reduce((s, o) => s + (qtyEdits[o.sku] ?? o.recommended_qty), 0);
        return (
          <section key={g.supplier_id} className="overflow-hidden rounded-md border border-zinc-200 bg-white">
            <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 bg-zinc-50 px-4 py-3">
              <button onClick={() => setOpen({ ...open, [g.supplier_id]: !isOpen })} className="flex items-center gap-2 text-left" aria-expanded={isOpen}>
                <span className="w-3 text-zinc-400">{isOpen ? "▾" : "▸"}</span>
                <span className="font-semibold text-brand-900">{g.supplier}</span>
              </button>
              <span className="text-sm text-zinc-500">
                срок поставки {g.lead_time_days} дн. · {fmt(g.positions)} поз. · {fmt(total)} шт{g.total_value ? ` · ≈ ${fmtMoney(g.total_value)}` : ""}
              </span>
              {g.critical > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">{fmt(g.critical)} критичных</span>}
              <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
                {approved[g.supplier_id] ? (
                  <>
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800">Утверждён {approved[g.supplier_id]}</span>
                    <button onClick={() => showEmail(approved[g.supplier_id])} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">
                      Письмо поставщику
                    </button>
                  </>
                ) : (
                  <button onClick={() => setConfirm(g)} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-900">
                    Утвердить заказ
                  </button>
                )}
                <a href={api.exportUrl("xlsx", g.supplier_id)} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">XLSX</a>
                <a href={api.exportUrl("csv", g.supplier_id)} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">CSV для 1С</a>
              </span>
            </header>
            {isOpen && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    <tr className="border-b border-zinc-200">
                      <th className="px-4 py-2">Товар</th>
                      <th className="px-2 py-2 text-right leading-tight">Остаток / в пути</th>
                      <th className="px-2 py-2 text-right leading-tight">Прогноз в день</th>
                      <th className="px-2 py-2 text-right">Покрытие</th>
                      <th className="px-2 py-2 text-right">Заказать</th>
                      <th className="px-2 py-2">Срочность</th>
                      <th className="px-2 py-2" aria-label="Обоснование"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => {
                      const exp = expanded === o.sku;
                      const edited = qtyEdits[o.sku] !== undefined && qtyEdits[o.sku] !== o.recommended_qty;
                      return (
                        <Fragment key={o.sku}>
                          <tr className={`border-b border-zinc-100 align-top hover:bg-zinc-50 ${exp ? "bg-brand-50" : ""}`}>
                            <td className="min-w-[190px] max-w-[420px] px-4 py-2">
                              <div className="truncate font-medium text-zinc-900" title={o.name}>{o.name}</div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                                <button className="font-mono text-brand-600 hover:underline" onClick={() => onOpenSku(o.sku)} title="Открыть график, обоснование и what-if">
                                  {o.sku}
                                </button>
                                {o.article && <span className="font-mono text-zinc-400">{o.article}</span>}
                                <span>{o.category}</span>
                              </div>
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                              {fmt(o.stock)} <span className="text-zinc-400">/</span> {fmt(o.in_transit)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                              {fmt(o.forecast_daily, 1)}
                              <ConfidenceDot o={o} />
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                              <div>{o.days_of_cover >= 999 ? "∞" : `${fmt(o.days_of_cover)} дн.`}</div>
                              <div className="text-xs text-zinc-500" title={o.stockout_date ? `ожидаемый дефицит ${o.stockout_date}` : ""}>
                                заказать до {dm(o.order_by)}
                              </div>
                            </td>
                            <td className="px-2 py-2 text-right">
                              <input
                                type="number"
                                min={0}
                                step={o.pack_size || 1}
                                value={qtyEdits[o.sku] ?? o.recommended_qty}
                                onChange={(e) => onEditQty(o.sku, Math.max(0, Number(e.target.value)))}
                                aria-label={`Количество к заказу ${o.sku}`}
                                className={`w-20 rounded-md border px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500 ${edited ? "border-amber-400 bg-amber-50" : "border-zinc-300"}`}
                              />
                              {edited && <div className="mt-0.5 text-[10px] text-amber-700">рекомендовано {fmt(o.recommended_qty)}</div>}
                            </td>
                            <td className="px-2 py-2">
                              <UrgencyBadge u={o.urgency} />
                            </td>
                            <td className="px-2 py-2 text-right">
                              <button onClick={() => setExpanded(exp ? null : o.sku)} className="whitespace-nowrap rounded-md border border-zinc-300 px-1.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100" aria-expanded={exp}>
                                {exp ? "Скрыть" : "Почему?"}
                              </button>
                            </td>
                          </tr>
                          {exp && (
                            <tr className="border-b border-zinc-200 bg-brand-50">
                              <td colSpan={7} className="px-4 py-3">
                                <p className="text-sm leading-relaxed text-zinc-800">{o.justification}</p>
                                <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-zinc-600 sm:grid-cols-3 lg:grid-cols-4">
                                  <Kv k="Прогноз на период" v={`${fmt(o.forecast_period_qty)} шт / ${o.lead_time_days + o.review_days} дн.`} />
                                  <Kv k="Сезонный коэф." v={fmt(o.seasonal_factor, 2)} />
                                  <Kv k="Тренд" v={o.trend_pct_month ? `${o.trend_pct_month > 0 ? "+" : ""}${fmt(o.trend_pct_month, 1)} %/мес (R² ${fmt(o.trend_r2, 2)})` : "нет устойчивого"} />
                                  <Kv k="Страховой запас" v={`${fmt(o.safety_stock)} шт (${Math.round(o.service_level * 100)} %)`} />
                                  <Kv k="Упущенный спрос" v={o.lost_demand_qty ? `${fmt(o.lost_demand_qty)} шт за ${o.stockout_days} дн.` : "нет дефицита"} />
                                  <Kv k="Исключено разовых" v={o.outliers_excluded ? `${o.outliers_excluded} продаж на ${fmt(o.outlier_qty_excluded)} шт` : "нет"} />
                                  <Kv k="Кратность / MOQ" v={`${o.pack_size} / ${o.moq}`} />
                                  <Kv k="Потребность до округления" v={fmt(o.raw_need)} />
                                  <Kv k="Ожидаемый дефицит" v={o.stockout_date ?? "нет"} />
                                  <Kv k="Надёжность прогноза" v={`${o.forecast_confidence ?? "нет данных"}${o.forecast_wape != null ? ` (ошибка ${Math.round(o.forecast_wape)} %)` : ""}`} />
                                  <Kv k="Сумма заказа" v={o.order_value ? `≈ ${fmtMoney(o.order_value)}` : "себестоимость неизвестна"} />
                                </div>
                                <button onClick={() => onOpenSku(o.sku)} className="mt-2 text-xs font-medium text-brand-600 hover:underline">
                                  Открыть график и what-if
                                </button>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {g.orders.length > lim && (
                  <div className="flex flex-wrap items-center justify-center gap-2 border-t border-zinc-100 px-4 py-3 text-sm">
                    <span className="text-zinc-500">
                      показано {fmt(lim)} из {fmt(g.orders.length)}
                    </span>
                    <button onClick={() => setLimit({ ...limit, [g.supplier_id]: lim + 50 })} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-zinc-700 hover:bg-zinc-100">
                      Показать ещё 50
                    </button>
                    <button onClick={() => setLimit({ ...limit, [g.supplier_id]: g.orders.length })} className="rounded-md px-3 py-1.5 text-brand-600 hover:underline">
                      Показать все
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      {email && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => setEmail(null)}>
          <div className="w-full max-w-2xl rounded-md bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-brand-900">Черновик письма поставщику</h3>
            <p className="mt-1 text-xs text-zinc-500">Кому: {email.to} · Тема: {email.subject}</p>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-3 font-sans text-sm">{email.body}</pre>
            <p className="mt-2 text-xs text-amber-800">Письмо не отправляется из сервиса: скопируйте в почту после проверки.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => navigator.clipboard?.writeText(email.body)} className="rounded-md border border-zinc-300 px-3 py-2 text-sm">Скопировать</button>
              <button onClick={() => setEmail(null)} className="rounded-md bg-brand-900 px-3 py-2 text-sm text-white">Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => !busy && setConfirm(null)}>
          <div className="w-full max-w-lg rounded-md bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-brand-900">Утвердить заказ: {confirm.supplier}</h3>
            <p className="mt-1 text-sm text-zinc-600">
              {fmt(confirm.orders.length)} позиций, {fmt(confirm.orders.reduce((s, o) => s + (qtyEdits[o.sku] ?? o.recommended_qty), 0))} шт. Изменённые количества учтены.
            </p>
            <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-sm">
              {confirm.orders.map((o) => (
                <li key={o.sku} className="flex justify-between gap-3">
                  <span className="truncate">
                    <span className="font-mono text-xs text-zinc-500">{o.sku}</span> {o.name}
                  </span>
                  <span className="tabular-nums">{fmt(qtyEdits[o.sku] ?? o.recommended_qty)}</span>
                </li>
              ))}
            </ul>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий (необязательно)" className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm" rows={2} />
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Заказ не отправляется поставщику автоматически. Утверждение фиксирует решение ответственного сотрудника; отправка выполняется отдельно.
            </p>
            {err && <p className="mt-2 text-sm text-red-700">Ошибка: {err}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} disabled={busy} className="rounded-md border border-zinc-300 px-3 py-2 text-sm">Отмена</button>
              <button onClick={() => doApprove(confirm)} disabled={busy} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
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

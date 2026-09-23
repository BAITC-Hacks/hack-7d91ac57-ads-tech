# Контракт API (источник правды для фронтенда) — v2, 13:40

Base URL в dev: `/api` (Vite проксирует на `http://localhost:8000`). Ошибки: `{"detail": "..."}`.

## GET /api/health
`{"status":"ok","demo_mode":false,"model":"...","tools":[...]}`

## GET /api/data/summary
Сводка загруженных данных.
```json
{"skus":80,"categories":["Кабель","Освещение","Автоматика","Розетки и выключатели","Щиты","Инструмент"],
 "warehouses":["Главный","Филиал Алматы"],"suppliers":6,"sales_from":"2024-09-01","sales_to":"2026-08-31",
 "stockout_periods":12,"in_transit_lines":9}
```

## POST /api/data/upload  (multipart, поля: `kind` = sales|stock|stockouts|in_transit|suppliers|products, `file` CSV)
Заменяет соответствующую таблицу. Ответ `{"kind":"sales","rows":12345}`.

## POST /api/replenish/run
Запрос (все поля опциональны):
```json
{"warehouse":"Главный","category":null,"service_level":0.95,"review_days":14}
```
Ответ:
```json
{"generated_at":"2026-09-23T14:05:00","params":{...},
 "summary":{"positions":37,"suppliers":5,"critical":6,"high":11,"normal":20,"total_qty":4120},
 "suppliers":[
   {"supplier_id":"S1","supplier":"ТОО Кабельный дом","lead_time_days":14,"positions":12,"total_qty":900,
    "orders":[
      {"sku":"KBL-001","name":"Кабель ВВГнг 3x2.5","category":"Кабель","warehouse":"Главный",
       "recommended_qty":600,"raw_qty":583,"moq":100,"urgency":"critical",
       "days_of_cover":6.2,"lead_time_days":14,
       "stock":120,"in_transit":0,
       "forecast_daily":19.4,"forecast_period_qty":543,"safety_stock":160,
       "seasonal_factor":1.18,"trend_pct_month":2.1,
       "stockout_days":9,"lost_demand_qty":140,"outliers_excluded":2,"outlier_qty_excluded":1500,
       "justification":"Средний спрос 16,4 шт/день, сезонный коэффициент сентября 1,18, рост +2,1%/мес → прогноз 19,4 шт/день. Исключены 2 разовые продажи (1 500 шт одному клиенту). В stockout 9 дней добавлен упущенный спрос 140 шт. На 28 дней (поставка 14 + период 14) нужно 543 + страховой запас 160 = 703; на складе 120, в пути 0 → 583, округлено до кратности 100 → 600. Покрытие 6 дней при сроке поставки 14 — критично."}
    ]}
 ]}
```
`urgency`: `critical` (покрытие < срока поставки), `high` (< срок + период), `normal`.

## GET /api/replenish/orders?supplier=S1&urgency=critical
Последний результат расчёта, плоский список `orders` с теми же полями + `supplier`, `supplier_id`.

## GET /api/sku/{sku}?warehouse=Главный
Данные для графика по артикулу.
```json
{"sku":"KBL-001","name":"...","category":"...","supplier":"...",
 "monthly":[{"month":"2024-09","raw":420,"cleaned":420,"imputed":0,"forecast":null}, ..., {"month":"2026-10","raw":null,"cleaned":null,"imputed":null,"forecast":560}],
 "outliers":[{"date":"2025-03-12","qty":1500,"client_id":"C017","reason":"робастный z=9.3; 71% спроса месяца одним клиентом"}],
 "stockouts":[{"from":"2025-11-02","to":"2025-11-10","lost_demand_qty":140}],
 "seasonal_index":{"1":0.8,"2":0.85,...,"12":1.25},
 "trend_pct_month":2.1,"stock":120,"in_transit":0,"lead_time_days":14}
```

## POST /api/replenish/whatif
```json
{"sku":"KBL-001","warehouse":"Главный","in_transit":200,"stock":null,"service_level":null}
```
Ответ: одна строка заказа как в `orders` (пересчитанная) + `"delta_qty": -200`.

## POST /api/orders/approve
Подтверждение человеком (обязательное по ТЗ). Запрос:
```json
{"supplier_id":"S1","lines":[{"sku":"KBL-001","qty":600},{"sku":"KBL-004","qty":50}],"comment":"..."}
```
Ответ `{"order_id":"ORD-20260923-001","status":"approved","lines":2,"approved_at":"..."}`. Ничего не отправляется наружу.

## GET /api/orders  → список утверждённых заказов.

## GET /api/export?format=csv|xlsx&supplier=S1
Файл со всеми (или по поставщику) рекомендованными позициями; колонки совместимы с загрузкой в 1С: `Поставщик;Артикул;Наименование;Количество;Срочность;Обоснование`. CSV: UTF-8 с BOM, разделитель `;`.

## POST /api/chat  (без изменений)
`{"messages":[...]}` → `{"answer","steps":[{"tool","args","result"}],"latency_ms"}`.
Инструменты агента: `run_replenishment`, `explain_sku`, `list_orders(supplier, urgency)`, `what_if(sku, in_transit, stock)`, `draft_supplier_email(supplier_id)` (только черновик).

## Изменения
| Время | Что |
|---|---|
| 13:40 | v2: эндпоинты задачи Электрокомплект. Реализация к 14:00 (run, summary), к 15:00 (остальное). До готовности backend фронт может строить UI по примерам JSON выше. |

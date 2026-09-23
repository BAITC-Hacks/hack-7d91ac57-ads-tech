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

## GET /api/replenish/impact
Эффект vs наивный Excel-расчёт по последнему результату. Для карточек «до/после» на дашборде.
```json
{"positions":41,"naive_overorder_qty":12000,"naive_overorder_money":5400000,"naive_underorder_qty":3100,"naive_underorder_money":2100000,
 "note":"...","top":[{"sku":"KBL-001","name":"...","supplier":"...","naive_qty":900,"recommended_qty":600,"diff_qty":300,"diff_money":150000,"reason":"выброс|дефицит|сезон/тренд/страховой"}]}
```

## Вход и администрирование (17:00)
Все `/api/*`, кроме `/api/health` и `/api/auth/login`, требуют `Authorization: Bearer <token>` (для ссылок скачивания допускается `?token=`).
- `POST /api/auth/login` `{username, password}` → `{token, user:{username, role, name, role_label}}`; `GET /api/auth/me`; `POST /api/auth/logout`.
- Только администратор: `GET /api/admin/integrations`, `PUT /api/admin/integrations/{onec|bitrix24}`, `POST /api/admin/integrations/{onec|bitrix24|llm}/test`, `GET /api/admin/audit?user=&action=&limit=`, `GET /api/admin/audit.csv`, `GET|PUT /api/admin/news-settings`.
- Агент сигналов продаж: `POST /api/signals/import` (multipart `files[]`, `text`, `channel`), `POST /api/signals/import_sample`, `GET /api/signals`, `DELETE /api/signals`. Параметр расчёта `include_signals`; в строках заказа `signal_qty`, `signals_included`, `signals[]`.
- Агент мониторинга СМИ: `POST /api/news/refresh`, `GET /api/news` (`items[]` с 14 полями, `fields[]`).
- Шаги агентов: `{tool, label, summary, args, result, ms}` — `label` и `summary` человеческим языком.

## GET /api/backtest
Бэктест вне выборки (после старта считается в фоне и кэшируется на диск; до готовности 202 `{"status":"computing"}`). `{warehouse, labels, models, modes, selected_on_validation, validation:{…}, test:{cutoff, months, mode_applied, best_mode, skus_evaluated, regular_skus, regular_vs_clean:{model:{wape,bias}}, regular_vs_raw, intermittent_vs_clean, all_vs_clean, wins_regular, by_category, calibration_by_mode, calibration:{target_pct, coverage_raw_pct, multiplier, multiplier_from_previous_window, coverage_out_of_sample_pct}}, production:{model, mode_label, ss_multiplier, skus_with_error}, note}`. Модели: `auto` (вариант, выбранный на окне проверки, измерен на следующем окне), `trend`, `blend`, `blend_growth`, `blend_damped`, `ours_no_cleaning`, `naive_90d`, `seasonal_naive`, `ma_12m`. `production.model` — вариант прогноза, который движок применяет ко всему ассортименту. Параметр расчёта `ss_calibrated` (bool, по умолчанию true) в `POST /api/replenish/run`; в строках заказа `forecast_wape`, `forecast_confidence`, `ss_multiplier`, `forecast_mode` (вариант прогноза) и `forecast_model` (устаревшее поле, всегда `trend`).

## GET /api/agent/daily-brief?warehouse=…
Утренний агент-закупщик: `{brief: "текст сводки", facts: {...}, steps: [{tool,args,result,ms}], llm: bool, generated_at}`. Без LLM — шаблон по фактам инструментов; с LLM — живой текст.

## Дополнения (14:30)
- `POST /api/replenish/run` принимает `growth_plan_pct_year` (плановый прирост, %/год, ко всем позициям). Строки заказа теперь содержат `order_by` (дата, до которой разместить заказ), `stockout_date`, `order_value` (₸ по себестоимости, 0 если неизвестна), `unit_price`; сводка и группы поставщиков — `total_value`, `value_known_positions`.
- `GET /api/replenish/overstock?warehouse=…&months=6` → `{overstock_positions, overstock_units, overstock_value, dead_positions, dead_units, dead_value, note, overstock:[{sku,name,category,supplier,stock,in_transit,forecast_daily,months_of_cover,excess_units,excess_value}], dead:[{sku,name,category,supplier,stock,value,last_sale_months}]}`.
- `GET /api/orders/{order_id}/email` → `{to, subject, body, sent:false}` черновик письма по утверждённому заказу.
- `POST /api/data/import_partner` (multipart, поле `files` × N: 12 xlsx партнёра) → импорт «как есть», переключает источник данных, запускает предрасчёт.

## GET /api/replenish/categories?warehouse=…&months=12
Тренды спроса по категориям (опц. пункт ТЗ). `{"warehouse":"…","months":["2025-10",…],"categories":[{"category":"Автоматы","months":[…],"qty":[…12 чисел…],"total":12345,"growth_pct":8.4,"growth_basis":"год к году"}]}`

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
| 14:35 | Реализовано всё из v2. Уточнения: `POST /api/replenish/run` дополнительно возвращает плоский `orders` (все строки) и `elapsed_ms`; `GET /api/health` содержит `data` (сводка датасета); `POST /api/replenish/whatif` возвращает `{base, scenario, overrides, delta_qty}`, где base и scenario — полные строки заказа; строки заказа содержат также `raw_need`, `pack_size`, `review_days`, `service_level`, `avg_daily_raw_90d`, `sigma_daily`, `trend_r2`, `plan_pct_year`, `forecast_parts[]`; `GET /api/sku/{sku}` возвращает строку заказа + `monthly[]` (24 факта + 6 прогноз), `outliers[]`, `stockouts[]`, `seasonal_index{}`; `POST /api/data/reset` перечитывает образец. Срочность `none` возможна только при `include_zero=true`. |
| 13:40 | v2: эндпоинты задачи Электрокомплект. Реализация к 14:00 (run, summary), к 15:00 (остальное). До готовности backend фронт может строить UI по примерам JSON выше. |

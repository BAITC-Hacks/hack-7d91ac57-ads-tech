#!/usr/bin/env bash
# Main scenario check. Reviewers run this after `docker compose up`.
set -euo pipefail
BASE="${BASE:-http://localhost:8000}"
J='Content-Type: application/json'
py() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }
echo "[1/5] health"
curl -sf "$BASE/api/health" | py "print(' status', d['status'], '| demo_mode', d['demo_mode'], '| skus', d['data']['skus'], '| sales', d['data']['sales_from'], '..', d['data']['sales_to'])"
echo "[2/5] расчёт заказов по складу Главный"
curl -sf -X POST "$BASE/api/replenish/run" -H "$J" -d '{"warehouse":"Главный"}' | py "s=d['summary']; print(' positions', s['positions'], '| suppliers', s['suppliers'], '| critical', s['critical'], '| outliers excluded', s['outliers_excluded_total'], '| lost demand', s['lost_demand_total'], '| elapsed_ms', d['elapsed_ms'])"
echo "[3/5] объяснение позиции с разовой продажей (LMP-011)"
curl -sf "$BASE/api/sku/LMP-011" | py "print(' ', d['justification'][:220], '...'); print('  outliers:', d['outliers'][:1])"
echo "[4/5] what-if: +300 в пути по LMP-012"
curl -sf -X POST "$BASE/api/replenish/whatif" -H "$J" -d '{"sku":"LMP-012","in_transit":300}' | py "print('  base', d['base']['recommended_qty'], '-> scenario', d['scenario']['recommended_qty'], '| delta', d['delta_qty'])"
echo "[5/5] ассистент + экспорт"
curl -sf -X POST "$BASE/api/chat" -H "$J" -d '{"messages":[{"role":"user","content":"Почему по LMP-012 такое количество?"}]}' | py "print('  tool:', [s['tool'] for s in d['steps']], '| latency_ms', d['latency_ms']); print('  ', d['answer'][:160], '...')"
curl -sf "$BASE/api/export?format=csv" | head -2 | cut -c1-120
curl -sf -o /dev/null -w "  xlsx HTTP %{http_code}, %{size_download} bytes\n" "$BASE/api/export?format=xlsx"
echo "OK"

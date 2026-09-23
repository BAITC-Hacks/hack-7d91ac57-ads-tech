#!/usr/bin/env bash
# Main scenario check. Works on any dataset (synthetic sample or partner data): SKUs are picked from the live result.
set -euo pipefail
BASE="${BASE:-http://localhost:8000}"
J='Content-Type: application/json'
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
py() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }

echo "[1/6] health и вход (демо-пользователь ${VERIFY_USER:-manager})"
curl -sf "$BASE/api/health" | py "print('  status', d['status'], '| demo_mode', d['demo_mode'], '| skus', d['data']['skus'], '| sales', d['data']['sales_from'], '..', d['data']['sales_to'], '| warehouse', d['data']['default_warehouse'])"
TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" -H "$J" -d "{\"username\":\"${VERIFY_USER:-manager}\",\"password\":\"${VERIFY_PASSWORD:-demo}\"}" | py "print(d['token'])")
A="Authorization: Bearer $TOKEN"
echo "   вход выполнен"

echo "[2/6] расчёт заказов (склад по умолчанию)"
curl -sf -X POST "$BASE/api/replenish/run" -H "$J" -H "$A" -d '{}' > "$TMP"
py "s=d['summary']; print('  positions', s['positions'], '| suppliers', s['suppliers'], '| critical', s['critical'], '| outliers excluded', s['outliers_excluded_total'], '| lost demand', s['lost_demand_total'], '| elapsed_ms', d['elapsed_ms'])" < "$TMP"
CRIT=$(py "print(next((o['sku'] for o in d['orders'] if o['urgency']=='critical'), d['orders'][0]['sku']))" < "$TMP")
CRIT_QTY=$(py "print(next(o['recommended_qty'] for o in d['orders'] if o['sku']=='$CRIT'))" < "$TMP")
OUT=$(py "print(next((o['sku'] for o in d['orders'] if o['outliers_excluded']>0), '$CRIT'))" < "$TMP")

echo "[3/6] обоснование позиции с исключённой разовой продажей: $OUT"
curl -sf -H "$A" "$BASE/api/sku/$OUT" | py "print('  ', d['justification'][:240], '...'); print('   outliers:', d['outliers'][:1])"

echo "[4/6] what-if: в пути приходит $CRIT_QTY шт по критичной позиции $CRIT"
curl -sf -X POST "$BASE/api/replenish/whatif" -H "$J" -H "$A" -d "{\"sku\":\"$CRIT\",\"in_transit\":$CRIT_QTY}" | py "print('   было', d['base']['recommended_qty'], '-> стало', d['scenario']['recommended_qty'], '| delta', d['delta_qty'])"

echo "[5/6] утренний агент и ассистент"
curl -sf -H "$A" "$BASE/api/agent/daily-brief" | py "print('   agent steps:', [s.get('label', s['tool']) for s in d['steps']])"
curl -sf -X POST "$BASE/api/chat" -H "$J" -H "$A" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Почему по $CRIT такое количество?\"}]}" | py "print('   tools:', [s.get('label', s['tool']) for s in d['steps']], '| latency_ms', d['latency_ms']); print('   ', d['answer'][:160], '...')"

echo "[6/6] экспорт"
curl -sf "$BASE/api/export?format=csv&token=$TOKEN" | sed -n '1,2p' | python3 -c "import sys; [print('   ' + l.strip()[:110]) for l in sys.stdin]"
curl -sf -o /dev/null -w "   xlsx HTTP %{http_code}, %{size_download} bytes\n" "$BASE/api/export?format=xlsx&token=$TOKEN"
echo "OK"

#!/bin/bash
# MCP Protocol Smoke Test — trading-risk-metrics-mcp
# Start server first: npm run build && PORT=3000 node dist/index.js
# Then: MCP_URL=http://localhost:3000 bash test-mcp.sh

BASE_URL="${MCP_URL:-http://localhost:3000}"
MCP_ENDPOINT="$BASE_URL/mcp"
HEALTH_ENDPOINT="$BASE_URL/health"
PASSED=0
FAILED=0

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}FAIL${NC} $1: $2"; FAILED=$((FAILED + 1)); }

ACCEPT='application/json, text/event-stream'

TX_JSON='[{"datetime":"2024-01-02T15:00:00Z","symbol":"AAPL","asset_type":"equity","side":"buy","quantity":10,"price":180,"price_ccy":"USD"}]'
PX_JSON='[{"date":"2024-01-01","symbol":"AAPL","close":175,"ccy":"USD"},{"date":"2024-01-02","symbol":"AAPL","close":180,"ccy":"USD"},{"date":"2024-01-03","symbol":"AAPL","close":182,"ccy":"USD"},{"date":"2024-01-04","symbol":"AAPL","close":181,"ccy":"USD"},{"date":"2024-01-05","symbol":"AAPL","close":183,"ccy":"USD"}]'

echo "Testing MCP server at $BASE_URL"
echo "================================"

echo ""
echo "--- Health Check ---"
HEALTH=$(curl -sf "$HEALTH_ENDPOINT" 2>/dev/null) || true
if echo "$HEALTH" | grep -q "healthy"; then
  pass "GET /health returns healthy"
else
  fail "GET /health" "Expected 'healthy' in response, got: $HEALTH"
fi

echo ""
echo "--- MCP Initialize ---"
INIT_RESPONSE=$(curl -sf -X POST "$MCP_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Accept: $ACCEPT" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "smoke-test", "version": "1.0" }
    }
  }' 2>/dev/null) || true

if echo "$INIT_RESPONSE" | grep -q '"result"'; then
  pass "initialize returns result"
else
  fail "initialize" "No 'result' in response: $INIT_RESPONSE"
fi

echo ""
echo "--- List Tools ---"
TOOLS_RESPONSE=$(curl -sf -X POST "$MCP_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Accept: $ACCEPT" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }' 2>/dev/null) || true

if echo "$TOOLS_RESPONSE" | grep -q '"tools"'; then
  pass "tools/list returns tools array"
else
  fail "tools/list" "No 'tools' in response: $TOOLS_RESPONSE"
fi

EXPECTED_TOOLS=("validate_dataset" "normalize_transactions" "compute_risk_metrics" "generate_tearsheet")
for TOOL in "${EXPECTED_TOOLS[@]}"; do
  if echo "$TOOLS_RESPONSE" | grep -q "\"$TOOL\""; then
    pass "Tool '$TOOL' is registered"
  else
    fail "Tool '$TOOL'" "Not found in tools/list response"
  fi
done

echo ""
echo "--- Call validate_dataset ---"
VALIDATE_BODY=$(TX_JSON="$TX_JSON" PX_JSON="$PX_JSON" python3 <<'PY'
import json, os
print(json.dumps({
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "validate_dataset",
    "arguments": {
      "transactionsJson": os.environ["TX_JSON"],
      "pricesJson": os.environ["PX_JSON"],
      "baseCcy": "USD"
    }
  }
}))
PY
)

CALL_V=$(curl -sf -X POST "$MCP_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Accept: $ACCEPT" \
  -d "$VALIDATE_BODY" 2>/dev/null) || true

if echo "$CALL_V" | grep -q '"content"'; then
  pass "validate_dataset returns content"
else
  fail "validate_dataset" "$CALL_V"
fi

echo ""
echo "--- Call compute_risk_metrics ---"
COMPUTE_BODY=$(TX_JSON="$TX_JSON" PX_JSON="$PX_JSON" python3 <<'PY'
import json, os
tx = json.loads(os.environ["TX_JSON"])
px = json.loads(os.environ["PX_JSON"])
print(json.dumps({
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "compute_risk_metrics",
    "arguments": {
      "transactions": tx,
      "prices": px,
      "baseCcy": "USD"
    }
  }
}))
PY
)

CALL_M=$(curl -sf -X POST "$MCP_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Accept: $ACCEPT" \
  -d "$COMPUTE_BODY" 2>/dev/null) || true

if echo "$CALL_M" | grep -q "datasetFingerprint"; then
  pass "compute_risk_metrics returns fingerprint"
else
  fail "compute_risk_metrics" "$CALL_M"
fi

echo ""
echo "================================"
echo "Passed: $PASSED  Failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLUGIN_DIR="${HOME}/.gemini/config/plugins/agy-token-analytics"

SKIP_BUILD=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
  esac
done

echo "==> Project Root : ${PROJECT_ROOT}"
echo "==> Target Plugin: ${PLUGIN_DIR}"

cd "${PROJECT_ROOT}"

if [[ "${SKIP_TESTS}" -eq 0 ]]; then
  echo ""
  echo "[1/4] Running Python parser unit & integration tests..."
  python3 "${PROJECT_ROOT}/parser/test_engine.py"
fi

if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  echo ""
  echo "[2/4] Building single-file MCP App UI & Node MCP Server..."
  npm run build
fi

echo ""
echo "[3/4] Syncing release bundle to ${PLUGIN_DIR}..."
mkdir -p "${PLUGIN_DIR}/assets" "${PLUGIN_DIR}/parser" "${PLUGIN_DIR}/dist/ui"
cp -f "${PROJECT_ROOT}/plugin.json" "${PLUGIN_DIR}/plugin.json"
cp -f "${PROJECT_ROOT}/mcp_config.json" "${PLUGIN_DIR}/mcp_config.json"
cp -f "${PROJECT_ROOT}/README.md" "${PLUGIN_DIR}/README.md"
cp -f "${PROJECT_ROOT}/assets/logo.svg" "${PLUGIN_DIR}/assets/logo.svg"
cp -f "${PROJECT_ROOT}/parser/engine.py" "${PLUGIN_DIR}/parser/engine.py"
cp -f "${PROJECT_ROOT}/dist/server.cjs" "${PLUGIN_DIR}/dist/server.cjs"
cp -f "${PROJECT_ROOT}/dist/ui/index.html" "${PLUGIN_DIR}/dist/ui/index.html"

echo ""
echo "[4/4] Checking Antigravity Language Server live reload..."
if [[ -n "${ANTIGRAVITY_LS_ADDRESS:-}" && -n "${ANTIGRAVITY_CSRF_TOKEN:-}" ]]; then
  ADDR="${ANTIGRAVITY_LS_ADDRESS}"
  [[ "${ADDR}" =~ ^https?:// ]] || ADDR="http://${ADDR}"
  if curl -sfk -X POST \
    -H "Content-Type: application/json" \
    -H "Connect-Protocol-Version: 1" \
    -H "x-codeium-csrf-token: ${ANTIGRAVITY_CSRF_TOKEN}" \
    -d '{"serverName":"agy-token-analytics_analytics"}' \
    "${ADDR}/exa.language_server_pb.LanguageServerService/RefreshMcpServers" >/dev/null 2>&1; then
    echo "    Refreshed MCP server: agy-token-analytics_analytics"
  else
    echo "    Note: RefreshMcpServers skipped; Antigravity auto-discovers new plugins."
  fi
else
  echo "    ANTIGRAVITY_LS_ADDRESS not set; plugin files are ready for auto-discovery."
fi

echo ""
echo "[OK] Deployment complete!"

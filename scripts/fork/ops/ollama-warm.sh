#!/usr/bin/env bash
# FORK: keep the brain's ollama embedding model resident on the model host.
#
# Ollama unloads an idle model after 5 minutes (its default keep_alive). The next query
# then pays a cold load (measured 2026-10-21 on the home server: ~2.2 s cold vs ~0.09 s
# warm for qwen3-embedding:4b on CPU). gbrain calls ollama through /v1/embeddings, which
# ignores keep_alive, so this sends a load-only request to the native /api/embed (no input:
# nothing is embedded) every few minutes, pushing the unload time KEEP_ALIVE ahead.
#
# A bounded keep_alive (not -1) cleans up after itself: when this machine stops pinging,
# or the brain switches to another embedding model, the old one unloads within KEEP_ALIVE.
#
# Reads the model and base URL from ~/.gbrain/config.json; does nothing unless the
# embedding model is an ollama one. Logs only state changes and failures.
#
#   bash scripts/fork/ops/ollama-warm.sh            # one ping (launchd runs this)
#   OLLAMA_WARM_DRY_RUN=1 bash scripts/fork/ops/ollama-warm.sh   # print what it would do
set -uo pipefail

KEEP_ALIVE="${OLLAMA_WARM_KEEP_ALIVE:-30m}"
CONFIG="${GBRAIN_CONFIG:-${HOME}/.gbrain/config.json}"
STATE="${OLLAMA_WARM_STATE:-${HOME}/Library/Logs/gbrain-ollama-warm.state}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# One line, tab-separated: model, base URL. Empty when the brain does not embed with ollama.
target="$(python3 -I - "${CONFIG}" <<'EOF'
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
m = c.get("embedding_model") or ""
if not m.startswith("ollama:"):
    sys.exit(0)
base = ((c.get("provider_base_urls") or {}).get("ollama") or "http://localhost:11434/v1").rstrip("/")
if base.endswith("/v1"):
    base = base[:-3]
print(m[len("ollama:"):] + "\t" + base)
EOF
)"

if [ -z "${target}" ]; then
  state="skip: embedding model is not an ollama model"
else
  model="${target%%$'\t'*}"
  base="${target#*$'\t'}"
  body="$(python3 -I -c 'import json,sys; print(json.dumps({"model": sys.argv[1], "keep_alive": sys.argv[2]}))' "${model}" "${KEEP_ALIVE}")"
  if [ -n "${OLLAMA_WARM_DRY_RUN:-}" ]; then
    echo "POST ${base}/api/embed ${body}"
    exit 0
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 60 -H 'Content-Type: application/json' -d "${body}" "${base}/api/embed")"
  if [ "${code}" = "200" ]; then
    state="ok: ${model} at ${base} kept for ${KEEP_ALIVE}"
  else
    state="FAIL: ${model} at ${base} answered HTTP ${code:-none}"
  fi
fi

# Log a line only when the outcome changes, so a healthy host costs nothing in the log.
previous="$(cat "${STATE}" 2>/dev/null || true)"
if [ "${state}" != "${previous}" ]; then
  log "${state}"
  printf '%s' "${state}" > "${STATE}"
fi
case "${state}" in FAIL:*) exit 1 ;; esac
exit 0

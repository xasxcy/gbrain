#!/usr/bin/env bash
# FORK: install (or remove) the ollama warm-keeping launchd agent on this Mac.
#
#   bash scripts/fork/ops/install-ollama-warm.sh            # install + start
#   bash scripts/fork/ops/install-ollama-warm.sh --remove   # stop + remove
set -euo pipefail
cd "$(dirname "$0")"
label="com.xasxcy.gbrain-ollama-warm"
agent="${HOME}/Library/LaunchAgents/${label}.plist"
bin="${HOME}/.local/bin/gbrain-ollama-warm.sh"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
  rm -f "${agent}" "${bin}"
  echo "removed ${label}"
  exit 0
fi

mkdir -p "${HOME}/.local/bin" "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
install -m 0755 ollama-warm.sh "${bin}"
sed "s#__HOME__#${HOME}#g" "${label}.plist" > "${agent}"
plutil -lint "${agent}" >/dev/null
launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${agent}"
echo "installed ${label}: ${bin}, every 300 s; log ${HOME}/Library/Logs/gbrain-ollama-warm.log"

#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR="/run/html2pdf-watchdog"
HEALTH_URL="${WATCHDOG_URL:-http://127.0.0.1:8214/health}"
HEALTH_TIMEOUT="${WATCHDOG_TIMEOUT_SECONDS:-10}"
FAILURE_THRESHOLD="${WATCHDOG_FAILURE_THRESHOLD:-2}"
RESTART_COOLDOWN="${WATCHDOG_RESTART_COOLDOWN_SECONDS:-60}"

log() { printf '[html2pdf-watchdog] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
is_positive_integer() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }

is_positive_integer "${HEALTH_TIMEOUT}" || die "WATCHDOG_TIMEOUT_SECONDS must be positive"
is_positive_integer "${FAILURE_THRESHOLD}" || die "WATCHDOG_FAILURE_THRESHOLD must be positive"
is_positive_integer "${RESTART_COOLDOWN}" || die "WATCHDOG_RESTART_COOLDOWN_SECONDS must be positive"

install -d -o root -g root -m 0755 "${STATE_DIR}"
exec 9>"${STATE_DIR}/lock"
flock -n 9 || { log "Another check is already running; skipping"; exit 0; }

FAILURE_FILE="${STATE_DIR}/failures"
RESTART_FILE="${STATE_DIR}/last-restart"

write_state() {
  local target="$1" value="$2" temporary
  temporary="$(mktemp "${STATE_DIR}/.state.XXXXXX")"
  printf '%s\n' "${value}" > "${temporary}"
  chmod 0600 "${temporary}"
  mv -f -- "${temporary}" "${target}"
}

health_check() {
  local response_file http_status
  response_file="$(mktemp "${STATE_DIR}/.health.XXXXXX")"
  if ! http_status="$(curl --silent --show-error --max-time "${HEALTH_TIMEOUT}" \
      --output "${response_file}" --write-out '%{http_code}' "${HEALTH_URL}")"; then
    rm -f -- "${response_file}"
    return 1
  fi
  if [[ "${http_status}" != "200" ]] || ! node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.status !== "ok" || value.browser !== "connected") process.exit(1);
  ' "${response_file}"; then
    rm -f -- "${response_file}"
    return 1
  fi
  rm -f -- "${response_file}"
}

if ! systemctl is-active --quiet html2pdf.service; then
  log "html2pdf.service is inactive; not starting it"
  exit 0
fi

now="$(date +%s)"
last_restart=0
[[ ! -r "${RESTART_FILE}" ]] || read -r last_restart < "${RESTART_FILE}"
[[ "${last_restart}" =~ ^[0-9]+$ ]] || last_restart=0
if (( now - last_restart < RESTART_COOLDOWN )); then
  log "Restart cooldown active; skipping"
  exit 0
fi

if health_check; then
  write_state "${FAILURE_FILE}" 0
  exit 0
fi

failures=0
[[ ! -r "${FAILURE_FILE}" ]] || read -r failures < "${FAILURE_FILE}"
[[ "${failures}" =~ ^[0-9]+$ ]] || failures=0
failures=$((failures + 1))
write_state "${FAILURE_FILE}" "${failures}"

if (( failures < FAILURE_THRESHOLD )); then
  log "Health check failed (${failures}/${FAILURE_THRESHOLD}); waiting for confirmation"
  exit 0
fi

log "Health check failed ${failures} times; restarting html2pdf.service"
if ! systemctl is-active --quiet html2pdf.service; then
  log "html2pdf.service became inactive; not starting it"
  exit 0
fi
write_state "${RESTART_FILE}" "${now}"
write_state "${FAILURE_FILE}" 0
if ! systemctl restart html2pdf.service; then
  log "Restart command failed; cooldown active"
  exit 1
fi

for _ in {1..10}; do
  if health_check; then
    log "Service healthy after restart"
    exit 0
  fi
  sleep 1
done
log "Service still unhealthy after restart; cooldown active"
exit 1

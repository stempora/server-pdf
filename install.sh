#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-html2pdf}"
SERVICE_USER="${SERVICE_USER:-pdf}"
INSTALL_DIR="${INSTALL_DIR:-/opt/html2pdf}"
CONFIG_DIR="${CONFIG_DIR:-/etc/html2pdf}"
PORT="${PORT:-8214}"
NODE_MAJOR="${NODE_MAJOR:-22}"
CHROME_BIN="${CHROME_PATH:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GENERATED_API_KEY=""

log() { printf '[html2pdf] %s\n' "$*"; }
die() { printf '[html2pdf] ERROR: %s\n' "$*" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
  die "Run this installer as root (for example: sudo ./install.sh)."
fi

[[ -f /etc/debian_version ]] || die "Only Debian and Ubuntu are supported."
[[ "${INSTALL_DIR}" = /* && "${CONFIG_DIR}" = /* ]] || die "INSTALL_DIR and CONFIG_DIR must be absolute paths."
[[ "${PORT}" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "PORT must be between 1 and 65535."
[[ "${SERVICE_USER}" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die "Invalid SERVICE_USER."
[[ "${SERVICE_NAME}" =~ ^[A-Za-z0-9_.@-]+$ ]] || die "Invalid SERVICE_NAME."

export DEBIAN_FRONTEND=noninteractive

log "Installing operating-system prerequisites"
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl

current_node_major=0
if command -v node >/dev/null 2>&1; then
  current_node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
fi

if (( current_node_major < 18 )); then
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/html2pdf-nodesource.sh
  bash /tmp/html2pdf-nodesource.sh
  rm -f /tmp/html2pdf-nodesource.sh
  apt-get install -y --no-install-recommends nodejs
fi

if [[ -z "${CHROME_BIN}" ]] && command -v google-chrome-stable >/dev/null 2>&1; then
  CHROME_BIN="$(command -v google-chrome-stable)"
fi

if [[ -z "${CHROME_BIN}" ]]; then
  [[ "$(dpkg --print-architecture)" = "amd64" ]] || die "Google Chrome is only installed automatically on amd64. Set CHROME_PATH after installing a compatible Chromium browser."
  log "Installing Google Chrome stable"
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/html2pdf-chrome.deb
  apt-get install -y /tmp/html2pdf-chrome.deb
  rm -f /tmp/html2pdf-chrome.deb
  CHROME_BIN="$(command -v google-chrome-stable)"
fi
[[ -x "${CHROME_BIN}" ]] || die "CHROME_PATH is not an executable file: ${CHROME_BIN}"

id "${SERVICE_USER}" >/dev/null 2>&1 || useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${INSTALL_DIR}" "${INSTALL_DIR}/logs"
install -d -o root -g "${SERVICE_USER}" -m 0750 "${CONFIG_DIR}"

log "Installing application files"
install -o root -g root -m 0644 "${SCRIPT_DIR}/server.js" "${INSTALL_DIR}/server.js"
install -o root -g root -m 0644 "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/package.json"
if [[ -f "${SCRIPT_DIR}/package-lock.json" ]]; then
  install -o root -g root -m 0644 "${SCRIPT_DIR}/package-lock.json" "${INSTALL_DIR}/package-lock.json"
  npm --prefix "${INSTALL_DIR}" ci --omit=dev --ignore-scripts
else
  npm --prefix "${INSTALL_DIR}" install --omit=dev --ignore-scripts
fi

if [[ ! -s "${CONFIG_DIR}/apikeys.json" ]]; then
  GENERATED_API_KEY="${API_KEY:-$(openssl rand -hex 32)}"
  [[ "${GENERATED_API_KEY}" =~ ^[A-Za-z0-9._~-]+$ ]] || die "API_KEY may contain only URL-safe characters."
  printf '["%s"]\n' "${GENERATED_API_KEY}" > "${CONFIG_DIR}/apikeys.json"
fi
chown root:"${SERVICE_USER}" "${CONFIG_DIR}/apikeys.json"
chmod 0640 "${CONFIG_DIR}/apikeys.json"

cat > "${CONFIG_DIR}/environment" <<EOF
PORT=${PORT}
CHROME_PATH=${CHROME_BIN}
API_KEYS_FILE=${CONFIG_DIR}/apikeys.json
LOG_DIR=${INSTALL_DIR}/logs
MAX_CONCURRENT_REQUESTS=${MAX_CONCURRENT_REQUESTS:-20}
MAX_QUEUE_SIZE=${MAX_QUEUE_SIZE:-200}
NAVIGATION_TIMEOUT_MS=${NAVIGATION_TIMEOUT_MS:-30000}
PAGE_TIMEOUT_MS=${PAGE_TIMEOUT_MS:-15000}
FONT_TIMEOUT_MS=${FONT_TIMEOUT_MS:-5000}
RENDER_DELAY_MS=${RENDER_DELAY_MS:-250}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS:-15000}
EOF
chown root:"${SERVICE_USER}" "${CONFIG_DIR}/environment"
chmod 0640 "${CONFIG_DIR}/environment"

sed \
  -e "s|@SERVICE_USER@|${SERVICE_USER}|g" \
  -e "s|@INSTALL_DIR@|${INSTALL_DIR}|g" \
  -e "s|@CONFIG_DIR@|${CONFIG_DIR}|g" \
  "${SCRIPT_DIR}/html2pdf.service" > "/etc/systemd/system/${SERVICE_NAME}.service"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

log "Waiting for the health endpoint"
for _ in {1..30}; do
  if curl --silent --fail "http://127.0.0.1:${PORT}/health" >/dev/null; then
    log "Installation complete; service is healthy on port ${PORT}."
    if [[ -n "${GENERATED_API_KEY}" ]]; then
      printf '\nAPI key (save it now): %s\n' "${GENERATED_API_KEY}"
    fi
    exit 0
  fi
  sleep 1
done

systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
journalctl -u "${SERVICE_NAME}.service" -n 50 --no-pager || true
die "The service did not become healthy within 30 seconds."

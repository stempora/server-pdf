#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_USER="pdf"
INSTALL_DIR="/home/pdf/server"
SERVICE_FILE="/etc/systemd/system/html2pdf.service"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STAGING_DIR=""
GENERATED_MASTER_KEY=""
INSTALL_COMMIT=""

log() { printf '[html2pdf] %s\n' "$*"; }
die() { printf '[html2pdf] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() { [[ -z "${STAGING_DIR}" ]] || rm -rf -- "${STAGING_DIR}"; }
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || die "Run this installer as root (sudo ./install.sh)."
[[ "$(pwd -P)" == "/home/pdf/server" && -d .git ]] || die "Clone the repository into /home/pdf/server and run install.sh from there."
[[ ! -e "${INSTALL_DIR}/environment" && ! -e "${SERVICE_FILE}" ]] || die "An existing installation was found; use update.sh instead."
INSTALL_COMMIT="$(git -c safe.directory="${INSTALL_DIR}" rev-parse --verify HEAD^{commit})" || die "HEAD is not a valid commit."
[[ -r /etc/os-release ]] || die "Cannot detect the Linux distribution (/etc/os-release is missing)."

# shellcheck disable=SC1091
source /etc/os-release
OS_ID="${ID:-}"
OS_MAJOR="${VERSION_ID%%.*}"

case "${OS_ID}" in
  debian|ubuntu)
    PACKAGE_FAMILY="deb"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl
    ;;
  almalinux|rocky|rhel)
    PACKAGE_FAMILY="rpm"
    [[ "${OS_MAJOR}" = "8" || "${OS_MAJOR}" = "9" ]] || die "${OS_ID} ${VERSION_ID} is unsupported; use version 8 or 9."
    dnf install -y ca-certificates curl gnupg2 openssl shadow-utils findutils
    ;;
  *)
    die "Unsupported distribution: ${OS_ID:-unknown}. Supported: Debian, Ubuntu, AlmaLinux 8-9, Rocky Linux 8-9, RHEL 8-9."
    ;;
esac

current_node_major=0
if command -v node >/dev/null 2>&1; then
  current_node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
fi
if (( current_node_major > 22 )); then
  die "Node.js ${current_node_major} is installed; automatic downgrade to Node.js 22 is not safe."
fi
if (( current_node_major < 22 )); then
  if [[ "${PACKAGE_FAMILY}" = "deb" ]]; then
    nodesource_url="https://deb.nodesource.com/setup_22.x"
  else
    nodesource_url="https://rpm.nodesource.com/setup_22.x"
  fi
  curl -fsSL "${nodesource_url}" -o /tmp/html2pdf-nodesource.sh
  bash /tmp/html2pdf-nodesource.sh
  rm -f /tmp/html2pdf-nodesource.sh
  if [[ "${PACKAGE_FAMILY}" = "deb" ]]; then
    apt-get install -y --no-install-recommends nodejs
  else
    dnf install -y nodejs
  fi
fi
[[ "$(node --version | sed -E 's/^v([0-9]+).*/\1/')" = "22" ]] || die "Node.js 22 installation verification failed."

if ! command -v google-chrome-stable >/dev/null 2>&1; then
  if [[ "${PACKAGE_FAMILY}" = "deb" ]]; then
    [[ "$(dpkg --print-architecture)" = "amd64" ]] || die "Automatic Google Chrome installation requires amd64."
    curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/html2pdf-chrome.deb
    apt-get install -y /tmp/html2pdf-chrome.deb
    rm -f /tmp/html2pdf-chrome.deb
  else
    [[ "$(uname -m)" = "x86_64" ]] || die "Automatic Google Chrome RPM installation requires x86_64."
    curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm -o /tmp/html2pdf-chrome.rpm
    dnf install -y /tmp/html2pdf-chrome.rpm
    rm -f /tmp/html2pdf-chrome.rpm
  fi
fi
[[ "$(command -v google-chrome-stable)" = "/usr/bin/google-chrome-stable" ]] || die "Google Chrome path verification failed."

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --create-home --home-dir /home/pdf --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
install -d -o pdf -g pdf -m 0750 "${INSTALL_DIR}" "${INSTALL_DIR}/logs" "${INSTALL_DIR}/postman"

# Validate the release before touching the running application.
STAGING_DIR="$(mktemp -d /tmp/html2pdf-install.XXXXXX)"
install -m 0644 "${SCRIPT_DIR}/server.js" "${STAGING_DIR}/server.js"
install -m 0644 "${SCRIPT_DIR}/key-store.js" "${STAGING_DIR}/key-store.js"
install -m 0644 "${SCRIPT_DIR}/package.json" "${STAGING_DIR}/package.json"
install -m 0644 "${SCRIPT_DIR}/package-lock.json" "${STAGING_DIR}/package-lock.json"
node --check "${STAGING_DIR}/server.js"
node --check "${STAGING_DIR}/key-store.js"

if [[ ! -e "${INSTALL_DIR}/master-key.json" ]]; then
  master_key="$(openssl rand -hex 32)"
  GENERATED_MASTER_KEY="${master_key}"
  created_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
  temporary_json="$(mktemp "${INSTALL_DIR}/.master-key.json.XXXXXX")"
  printf '{\n  "key": "%s",\n  "created_at": "%s"\n}\n' \
    "${master_key}" "${created_at}" > "${temporary_json}"
  chmod 0600 "${temporary_json}"
  mv -- "${temporary_json}" "${INSTALL_DIR}/master-key.json"
fi
if [[ ! -e "${INSTALL_DIR}/apikeys.json" ]]; then
  api_key="${API_KEY:-$(openssl rand -hex 32)}"
  encoded_api_key="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "${api_key}")"
  temporary_json="$(mktemp "${INSTALL_DIR}/.apikeys.json.XXXXXX")"
  printf '[%s]\n' "${encoded_api_key}" > "${temporary_json}"
  chmod 0600 "${temporary_json}"
  mv -- "${temporary_json}" "${INSTALL_DIR}/apikeys.json"
  log "Generated initial API key: ${api_key}"
fi
if [[ ! -e "${INSTALL_DIR}/api-key-metadata.json" ]]; then
  temporary_json="$(mktemp "${INSTALL_DIR}/.api-key-metadata.json.XXXXXX")"
  printf '{}\n' > "${temporary_json}"
  chmod 0600 "${temporary_json}"
  mv -- "${temporary_json}" "${INSTALL_DIR}/api-key-metadata.json"
fi
if [[ ! -e "${INSTALL_DIR}/environment" ]]; then
  cat > "${INSTALL_DIR}/environment" <<'EOF'
PORT=8214
CHROME_PATH=/usr/bin/google-chrome-stable
API_KEYS_FILE=/home/pdf/server/apikeys.json
MASTER_KEY_FILE=/home/pdf/server/master-key.json
API_KEY_METADATA_FILE=/home/pdf/server/api-key-metadata.json
LOG_DIR=/home/pdf/server/logs
PDF_REQUEST_TIMEOUT_MS=60000
PDF_TIMEOUT_CLEANUP_MS=3000
BROWSER_MAX_REQUESTS=5000
BROWSER_MAX_UPTIME_SECONDS=21600
WATCHDOG_URL=http://127.0.0.1:8214/health
WATCHDOG_TIMEOUT_SECONDS=10
WATCHDOG_FAILURE_THRESHOLD=2
WATCHDOG_RESTART_COOLDOWN_SECONDS=60
EOF
fi

validate_json() {
  node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(process.argv[1], "utf8"));' "$1"
}
validate_json "${INSTALL_DIR}/master-key.json"
validate_json "${INSTALL_DIR}/apikeys.json"
validate_json "${INSTALL_DIR}/api-key-metadata.json"
node -e '
  const fs = require("fs");
  const master = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const keys = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const metadata = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  if (!master || typeof master.key !== "string" || !master.key) throw new Error("Invalid master-key.json");
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error("Invalid apikeys.json");
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") throw new Error("Invalid api-key-metadata.json");
' "${INSTALL_DIR}/master-key.json" "${INSTALL_DIR}/apikeys.json" "${INSTALL_DIR}/api-key-metadata.json"

# Only application artifacts are replaced; production state remains in place.
install -o pdf -g pdf -m 0644 "${STAGING_DIR}/server.js" "${INSTALL_DIR}/server.js"
install -o pdf -g pdf -m 0644 "${STAGING_DIR}/key-store.js" "${INSTALL_DIR}/key-store.js"
install -o pdf -g pdf -m 0644 "${STAGING_DIR}/package.json" "${INSTALL_DIR}/package.json"
install -o pdf -g pdf -m 0644 "${STAGING_DIR}/package-lock.json" "${INSTALL_DIR}/package-lock.json"
runuser -u pdf -- npm --prefix "${INSTALL_DIR}" ci --omit=dev --ignore-scripts

chown -R pdf:pdf "${INSTALL_DIR}"
chmod 0600 "${INSTALL_DIR}/master-key.json" "${INSTALL_DIR}/apikeys.json" "${INSTALL_DIR}/api-key-metadata.json"
chmod 0640 "${INSTALL_DIR}/environment"
node --check "${INSTALL_DIR}/server.js"
node --check "${INSTALL_DIR}/key-store.js"

if [[ -d "${SCRIPT_DIR}/postman" ]]; then
  find "${SCRIPT_DIR}/postman" -maxdepth 1 -type f -name '*.json' -exec \
    install -o pdf -g pdf -m 0644 {} "${INSTALL_DIR}/postman/" \;
fi

install -o root -g root -m 0644 "${SCRIPT_DIR}/html2pdf.service" "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable html2pdf.service
systemctl restart html2pdf.service

for _ in {1..30}; do
  if curl --silent --fail http://127.0.0.1:8214/health >/dev/null; then
    bash "${SCRIPT_DIR}/scripts/install-watchdog.sh"
    log "Installation complete; service is healthy."
    if [[ -n "${GENERATED_MASTER_KEY}" ]]; then
      printf '\nMaster key (save it now; it will not be shown again): %s\n' "${GENERATED_MASTER_KEY}"
    fi
    deployed_commit_temp="$(mktemp "${INSTALL_DIR}/.deployed-commit.XXXXXX")"
    printf '%s\n' "${INSTALL_COMMIT}" > "${deployed_commit_temp}"
    chown pdf:pdf "${deployed_commit_temp}"
    chmod 0600 "${deployed_commit_temp}"
    mv -f -- "${deployed_commit_temp}" "${INSTALL_DIR}/.deployed-commit"
    exit 0
  fi
  sleep 1
done
systemctl --no-pager --full status html2pdf.service || true
die "The service did not become healthy within 30 seconds."

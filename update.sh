#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="/home/pdf/server"
SERVICE="html2pdf.service"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ROOT="/home/pdf/server-backups"
BACKUP_DIR=""
CHANGES_STARTED=0
DEPENDENCIES_CHANGED=0

log() { printf '[html2pdf-update] %s\n' "$*"; }
die() { printf '[html2pdf-update] ERROR: %s\n' "$*" >&2; exit 1; }

validate_json() {
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1"
}

validate_key_files() {
  node -e '
    const fs = require("fs");
    const master = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const keys = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const metadataPath = process.argv[3];
    const metadata = fs.existsSync(metadataPath)
      ? JSON.parse(fs.readFileSync(metadataPath, "utf8"))
      : {};
    if (!master || typeof master.key !== "string" || !master.key) throw new Error("Invalid master-key.json");
    if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error("Invalid apikeys.json");
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") throw new Error("Invalid api-key-metadata.json");
  ' "${INSTALL_DIR}/master-key.json" "${INSTALL_DIR}/apikeys.json" "${INSTALL_DIR}/api-key-metadata.json"
}

restore_file() {
  local name="$1"
  if [[ -e "${BACKUP_DIR}/${name}" ]]; then
    cp -a -- "${BACKUP_DIR}/${name}" "${INSTALL_DIR}/${name}"
  elif [[ -e "${BACKUP_DIR}/.absent-${name}" ]]; then
    rm -f -- "${INSTALL_DIR}/${name}"
  fi
}

restore_postman_file() {
  local name="$1"
  if [[ -e "${BACKUP_DIR}/postman/${name}" ]]; then
    cp -a -- "${BACKUP_DIR}/postman/${name}" "${INSTALL_DIR}/postman/${name}"
  elif [[ -e "${BACKUP_DIR}/postman/.absent-${name}" ]]; then
    rm -f -- "${INSTALL_DIR}/postman/${name}"
  fi
}

rollback() {
  local exit_code=$?
  trap - ERR
  if (( CHANGES_STARTED == 0 )); then
    exit "${exit_code}"
  fi

  log "Update failed; rolling back from ${BACKUP_DIR}"
  for name in server.js key-store.js package.json package-lock.json; do
    restore_file "${name}"
  done
  for name in server-pdf.postman_collection.json server-pdf.local.postman_environment.json; do
    restore_postman_file "${name}"
  done
  if (( DEPENDENCIES_CHANGED == 1 )); then
    rm -rf -- "${INSTALL_DIR}/node_modules"
    if [[ -d "${BACKUP_DIR}/node_modules" ]]; then
      cp -a -- "${BACKUP_DIR}/node_modules" "${INSTALL_DIR}/node_modules"
    fi
  fi
  chown -R pdf:pdf "${INSTALL_DIR}"
  chmod 0600 "${INSTALL_DIR}/master-key.json" "${INSTALL_DIR}/apikeys.json"
  [[ ! -e "${INSTALL_DIR}/api-key-metadata.json" ]] || chmod 0600 "${INSTALL_DIR}/api-key-metadata.json"
  systemctl restart "${SERVICE}" || true
  log "Rollback completed. Backup retained at ${BACKUP_DIR}"
  exit "${exit_code}"
}
trap rollback ERR

[[ "${EUID}" -eq 0 ]] || die "Run as root: sudo ./update.sh"
exec 9>/run/lock/html2pdf-update.lock
flock -n 9 || die "Another server-pdf update is already running."
[[ -d "${SCRIPT_DIR}/.git" ]] || die "Run update.sh from the Git checkout root."
[[ -z "$(git -C "${SCRIPT_DIR}" status --porcelain --untracked-files=all)" ]] || die "Refusing deployment from a dirty Git checkout."
[[ -d "${INSTALL_DIR}" ]] || die "Existing installation not found at ${INSTALL_DIR}."
[[ -f "${INSTALL_DIR}/server.js" && -f "${INSTALL_DIR}/package.json" ]] || die "Existing application files are incomplete."
[[ -f /etc/systemd/system/html2pdf.service ]] || die "Systemd unit is missing."
systemctl is-active --quiet "${SERVICE}" || die "Service ${SERVICE} is not active."
id pdf >/dev/null 2>&1 || die "Linux user 'pdf' does not exist."

for file in server.js key-store.js; do
  [[ -f "${SCRIPT_DIR}/${file}" ]] || die "Release file missing: ${file}"
  node --check "${SCRIPT_DIR}/${file}"
done
for file in package.json package-lock.json; do
  validate_json "${SCRIPT_DIR}/${file}"
done
for file in "${SCRIPT_DIR}"/postman/*.json; do
  [[ -e "${file}" ]] || continue
  validate_json "${file}"
done

[[ -f "${INSTALL_DIR}/master-key.json" ]] || die "master-key.json is missing; run scripts/create-master-key.sh first."
validate_json "${INSTALL_DIR}/master-key.json"
validate_json "${INSTALL_DIR}/apikeys.json"
[[ ! -e "${INSTALL_DIR}/api-key-metadata.json" ]] || validate_json "${INSTALL_DIR}/api-key-metadata.json"
validate_key_files

if ! cmp -s "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/package.json" ||
   ! cmp -s "${SCRIPT_DIR}/package-lock.json" "${INSTALL_DIR}/package-lock.json"; then
  DEPENDENCIES_CHANGED=1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/${timestamp}"
install -d -o pdf -g pdf -m 0750 "${BACKUP_ROOT}"
mkdir -m 0750 "${BACKUP_DIR}"
chown pdf:pdf "${BACKUP_DIR}"
install -d -o pdf -g pdf -m 0750 "${BACKUP_DIR}/postman"
for name in server.js key-store.js package.json package-lock.json; do
  if [[ -e "${INSTALL_DIR}/${name}" ]]; then
    cp -a -- "${INSTALL_DIR}/${name}" "${BACKUP_DIR}/${name}"
  else
    : > "${BACKUP_DIR}/.absent-${name}"
  fi
done
for name in server-pdf.postman_collection.json server-pdf.local.postman_environment.json; do
  if [[ -e "${INSTALL_DIR}/postman/${name}" ]]; then
    cp -a -- "${INSTALL_DIR}/postman/${name}" "${BACKUP_DIR}/postman/${name}"
  else
    : > "${BACKUP_DIR}/postman/.absent-${name}"
  fi
done
if (( DEPENDENCIES_CHANGED == 1 )) && [[ -d "${INSTALL_DIR}/node_modules" ]]; then
  cp -a -- "${INSTALL_DIR}/node_modules" "${BACKUP_DIR}/node_modules"
fi
log "Backup created at ${BACKUP_DIR}"

CHANGES_STARTED=1
for name in server.js key-store.js package.json package-lock.json; do
  install -o pdf -g pdf -m 0644 "${SCRIPT_DIR}/${name}" "${INSTALL_DIR}/${name}"
done
install -d -o pdf -g pdf -m 0750 "${INSTALL_DIR}/postman"
for name in server-pdf.postman_collection.json server-pdf.local.postman_environment.json; do
  install -o pdf -g pdf -m 0644 "${SCRIPT_DIR}/postman/${name}" "${INSTALL_DIR}/postman/${name}"
done

if (( DEPENDENCIES_CHANGED == 1 )); then
  log "Dependencies changed; running npm ci --omit=dev"
  runuser -u pdf -- npm --prefix "${INSTALL_DIR}" ci --omit=dev --ignore-scripts
else
  log "Dependencies unchanged; skipping npm ci"
fi

node --check "${INSTALL_DIR}/server.js"
node --check "${INSTALL_DIR}/key-store.js"
validate_json "${INSTALL_DIR}/master-key.json"
validate_json "${INSTALL_DIR}/apikeys.json"
[[ ! -e "${INSTALL_DIR}/api-key-metadata.json" ]] || validate_json "${INSTALL_DIR}/api-key-metadata.json"
validate_key_files
chown -R pdf:pdf "${INSTALL_DIR}"
chmod 0600 "${INSTALL_DIR}/master-key.json" "${INSTALL_DIR}/apikeys.json"
[[ ! -e "${INSTALL_DIR}/api-key-metadata.json" ]] || chmod 0600 "${INSTALL_DIR}/api-key-metadata.json"

systemctl restart "${SERVICE}"
healthy=0
for _ in {1..30}; do
  if curl --silent --fail http://127.0.0.1:8214/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
(( healthy == 1 )) || false

trap - ERR
log "Update completed successfully. Backup retained at ${BACKUP_DIR}"

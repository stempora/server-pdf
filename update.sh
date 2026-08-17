#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="/home/pdf/server"
BACKUP_ROOT="/home/pdf/server-backups"
MARKER_FILE="${INSTALL_DIR}/.deployed-commit"
SERVICE="html2pdf.service"
BACKUP_DIR=""
OLD_COMMIT=""
NEW_COMMIT=""
DEPENDENCIES_CHANGED=0
ROLLBACK_READY=0

log() { printf '[html2pdf-update] %s\n' "$*"; }
die() { printf '[html2pdf-update] ERROR: %s\n' "$*" >&2; exit 1; }
git_safe() { git -c safe.directory="${INSTALL_DIR}" "$@"; }

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

write_deployed_commit() {
  local commit="$1"
  local temporary_file
  temporary_file="$(mktemp "${INSTALL_DIR}/.deployed-commit.XXXXXX")"
  printf '%s\n' "${commit}" > "${temporary_file}"
  chown pdf:pdf "${temporary_file}"
  chmod 0600 "${temporary_file}"
  mv -f -- "${temporary_file}" "${MARKER_FILE}"
}

wait_for_health() {
  local attempt
  for attempt in {1..30}; do
    if curl --silent --fail http://127.0.0.1:8214/health >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  local exit_code=$?
  trap - ERR
  if (( ROLLBACK_READY == 0 )); then
    exit "${exit_code}"
  fi

  log "Update failed; restoring commit ${OLD_COMMIT}"
  if [[ "$(pwd -P)" != "/home/pdf/server" || ! -d .git || ! -d "${BACKUP_DIR}" ]]; then
    log "CRITICAL: rollback safety checks failed; git reset was not executed."
    exit "${exit_code}"
  fi
  if ! git_safe cat-file -e "${OLD_COMMIT}^{commit}" 2>/dev/null; then
    log "CRITICAL: rollback commit is invalid; git reset was not executed."
    exit "${exit_code}"
  fi
  if [[ -n "$(git_safe status --porcelain --untracked-files=no)" ]]; then
    log "CRITICAL: tracked files changed during update; git reset was not executed."
    exit "${exit_code}"
  fi
  git_safe reset --hard "${OLD_COMMIT}"

  if (( DEPENDENCIES_CHANGED == 1 )); then
    rm -rf -- "${INSTALL_DIR}/node_modules"
    if [[ -d "${BACKUP_DIR}/node_modules" ]]; then
      cp -a -- "${BACKUP_DIR}/node_modules" "${INSTALL_DIR}/node_modules"
    fi
  fi

  chown -R pdf:pdf "${INSTALL_DIR}"
  chmod 0600 "${INSTALL_DIR}/master-key.json" "${INSTALL_DIR}/apikeys.json"
  [[ ! -e "${INSTALL_DIR}/api-key-metadata.json" ]] || chmod 0600 "${INSTALL_DIR}/api-key-metadata.json"
  write_deployed_commit "${OLD_COMMIT}"

  if systemctl restart "${SERVICE}" && wait_for_health; then
    log "Rollback completed; repository and service are back at ${OLD_COMMIT}."
    log "Retry with: git pull --ff-only && sudo ./update.sh"
  else
    log "CRITICAL: files were restored to ${OLD_COMMIT}, but the old service failed its health check."
  fi
  log "Backup retained at ${BACKUP_DIR}"
  exit "${exit_code}"
}
trap rollback ERR

[[ "${EUID}" -eq 0 ]] || die "Run as root: sudo ./update.sh"
[[ "$(pwd -P)" == "/home/pdf/server" ]] || die "Run update.sh exclusively from /home/pdf/server."
[[ -d .git ]] || die "/home/pdf/server is not a Git repository."
exec 9>/run/lock/html2pdf-update.lock
flock -n 9 || die "Another server-pdf update is already running."
[[ -f server.js && -f key-store.js && -f package.json && -f package-lock.json ]] || die "Application files are incomplete."
[[ -d node_modules ]] || die "Existing node_modules directory is missing."
[[ -f /etc/systemd/system/html2pdf.service ]] || die "Systemd unit is missing."
systemctl is-active --quiet "${SERVICE}" || die "Service ${SERVICE} is not active."
id pdf >/dev/null 2>&1 || die "Linux user 'pdf' does not exist."
[[ -z "$(git_safe status --porcelain --untracked-files=all)" ]] || die "Refusing update from a dirty repository."

NEW_COMMIT="$(git_safe rev-parse --verify HEAD^{commit})" || die "HEAD is not a valid commit."

if [[ -f "${MARKER_FILE}" ]]; then
  OLD_COMMIT="$(tr -d '[:space:]' < "${MARKER_FILE}")"
elif [[ -n "${DEPLOYED_COMMIT:-}" ]]; then
  OLD_COMMIT="${DEPLOYED_COMMIT}"
elif git_safe rev-parse --verify --quiet ORIG_HEAD^{commit} >/dev/null; then
  OLD_COMMIT="$(git_safe rev-parse --verify ORIG_HEAD^{commit})"
else
  die "No safe previous commit found. Re-run with: sudo DEPLOYED_COMMIT=SHA ./update.sh"
fi

[[ "${OLD_COMMIT}" =~ ^[0-9a-fA-F]{7,64}$ ]] || die "OLD_COMMIT has an invalid format."
git_safe cat-file -e "${OLD_COMMIT}^{commit}" 2>/dev/null || die "OLD_COMMIT is not a valid commit: ${OLD_COMMIT}"
OLD_COMMIT="$(git_safe rev-parse --verify "${OLD_COMMIT}^{commit}")"
git_safe merge-base --is-ancestor "${OLD_COMMIT}" "${NEW_COMMIT}" || die "OLD_COMMIT is not an ancestor of NEW_COMMIT."

if [[ "${OLD_COMMIT}" = "${NEW_COMMIT}" ]]; then
  log "Nothing to update; ${NEW_COMMIT} is already deployed."
  exit 0
fi

if git_safe diff --quiet "${OLD_COMMIT}" "${NEW_COMMIT}" -- package.json package-lock.json; then
  DEPENDENCIES_CHANGED=0
else
  DEPENDENCIES_CHANGED=1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/${timestamp}"
install -d -o pdf -g pdf -m 0750 "${BACKUP_ROOT}"
mkdir -m 0750 "${BACKUP_DIR}"
chown pdf:pdf "${BACKUP_DIR}"
printf '%s\n' "${OLD_COMMIT}" > "${BACKUP_DIR}/OLD_COMMIT"
printf '%s\n' "${NEW_COMMIT}" > "${BACKUP_DIR}/NEW_COMMIT"
printf 'service=%s\nwas_active=true\ndependencies_changed=%s\n' \
  "${SERVICE}" "${DEPENDENCIES_CHANGED}" > "${BACKUP_DIR}/deployment-state"
chown pdf:pdf "${BACKUP_DIR}/OLD_COMMIT" "${BACKUP_DIR}/NEW_COMMIT" "${BACKUP_DIR}/deployment-state"
chmod 0640 "${BACKUP_DIR}/OLD_COMMIT" "${BACKUP_DIR}/NEW_COMMIT" "${BACKUP_DIR}/deployment-state"
if (( DEPENDENCIES_CHANGED == 1 )) && [[ -d node_modules ]]; then
  cp -a -- node_modules "${BACKUP_DIR}/node_modules"
fi
log "Backup created at ${BACKUP_DIR}"
ROLLBACK_READY=1

node --check server.js
node --check key-store.js
validate_json package.json
validate_json package-lock.json
for file in postman/*.json; do
  [[ -e "${file}" ]] || continue
  validate_json "${file}"
done
validate_json master-key.json
validate_json apikeys.json
[[ ! -e api-key-metadata.json ]] || validate_json api-key-metadata.json
validate_key_files

if (( DEPENDENCIES_CHANGED == 1 )); then
  log "Dependencies changed; running npm ci --omit=dev --ignore-scripts"
  runuser -u pdf -- npm ci --omit=dev --ignore-scripts
else
  log "Dependencies unchanged; skipping npm ci"
fi

chown -R pdf:pdf "${INSTALL_DIR}"
chmod 0600 master-key.json apikeys.json
[[ ! -e api-key-metadata.json ]] || chmod 0600 api-key-metadata.json
systemctl restart "${SERVICE}"
wait_for_health
write_deployed_commit "${NEW_COMMIT}"

trap - ERR
log "Update completed successfully at ${NEW_COMMIT}."
log "Backup retained at ${BACKUP_DIR}"

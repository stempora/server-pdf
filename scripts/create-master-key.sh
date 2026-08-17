#!/usr/bin/env bash
set -Eeuo pipefail

MASTER_KEY_FILE="/home/pdf/server/master-key.json"

[[ "${EUID}" -eq 0 ]] || { echo "Run as root: sudo ./scripts/create-master-key.sh" >&2; exit 1; }
id pdf >/dev/null 2>&1 || { echo "Linux user 'pdf' does not exist." >&2; exit 1; }
[[ -d /home/pdf/server ]] || { echo "/home/pdf/server does not exist." >&2; exit 1; }

if [[ -e "${MASTER_KEY_FILE}" ]]; then
  echo "Master key already exists; no changes made."
  exit 0
fi

master_key="$(openssl rand -hex 32)"
created_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
temporary_file="$(mktemp /home/pdf/server/.master-key.json.XXXXXX)"
trap 'rm -f -- "${temporary_file}"' EXIT

printf '{\n  "key": "%s",\n  "created_at": "%s"\n}\n' \
  "${master_key}" "${created_at}" > "${temporary_file}"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${temporary_file}"
chown pdf:pdf "${temporary_file}"
chmod 0600 "${temporary_file}"
if ! ln -- "${temporary_file}" "${MASTER_KEY_FILE}"; then
  echo "Master key appeared concurrently; no changes made." >&2
  exit 1
fi
rm -f -- "${temporary_file}"
trap - EXIT

printf 'Master key created. Save it now; it will not be shown again:\n%s\n' "${master_key}"

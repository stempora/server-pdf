#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="/home/pdf/server"
SYSTEMD_DIR="/etc/systemd/system"

die() { printf '[html2pdf-watchdog] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "Run as root (sudo ./scripts/install-watchdog.sh)."
[[ "$(pwd -P)" == "${INSTALL_DIR}" && -d .git ]] || die "Run from ${INSTALL_DIR}."

bash -n scripts/watchdog.sh
bash -n scripts/install-watchdog.sh
[[ -f systemd/html2pdf-watchdog.service ]] || die "Watchdog service unit is missing."
[[ -f systemd/html2pdf-watchdog.timer ]] || die "Watchdog timer unit is missing."

chmod 0755 scripts/watchdog.sh
install -o root -g root -m 0644 systemd/html2pdf-watchdog.service "${SYSTEMD_DIR}/html2pdf-watchdog.service"
install -o root -g root -m 0644 systemd/html2pdf-watchdog.timer "${SYSTEMD_DIR}/html2pdf-watchdog.timer"

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "${SYSTEMD_DIR}/html2pdf-watchdog.service" "${SYSTEMD_DIR}/html2pdf-watchdog.timer"
fi

systemctl daemon-reload
systemctl enable --now html2pdf-watchdog.timer
systemctl --no-pager status html2pdf-watchdog.timer

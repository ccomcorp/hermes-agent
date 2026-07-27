#!/usr/bin/env bash
# Wait for Hermes Desktop to fully exit, then repackage the app.asar (Phase 2).
# Phase 1 (vite build) already ran; this only needs the file lock released.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

echo "[repack] waiting for Hermes Desktop to close (frees app.asar lock)..."
for i in $(seq 1 600); do   # up to ~20 min
  running=$(powershell.exe -NoProfile -Command \
    "(@(Get-Process Hermes -ErrorAction SilentlyContinue)).Count" 2>/dev/null | tr -d '\r')
  if [ "${running:-0}" = "0" ]; then
    echo "[repack] Desktop closed. Packaging..."
    # electron-builder --dir only; Phase 1 dist/ is already fresh.
    npm run builder -- --dir 2>&1 | tail -20
    code=${PIPESTATUS[0]}
    if [ "$code" = "0" ]; then
      echo "[repack] DONE — app.asar repacked. Relaunch Hermes Desktop."
      ls -la --time-style=full-iso release/win-unpacked/resources/app.asar | awk '{print "[repack] app.asar:", $6, $7}'
    else
      echo "[repack] FAILED exit=$code — see output above."
    fi
    exit $code
  fi
  sleep 2
done
echo "[repack] TIMEOUT — Desktop never closed. Re-run this script after closing it."
exit 1

#!/usr/bin/env bash
# Entry point for the hourly cloud routine: install, find or fetch a browser, run one check.
# Results land in runs/outbox/*.json for the routine to save to the Registration Monitor page.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"
mkdir -p runs/outbox
rm -f runs/outbox/*.json

npm ci --no-audit --no-fund --loglevel=error

if [[ -z "${CHROME_PATH:-}" ]]; then
    for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
            export CHROME_PATH="$(command -v "$candidate")"
            break
        fi
    done
fi

if [[ -z "${CHROME_PATH:-}" ]]; then
    npx --yes playwright@1.63.0 install --with-deps chromium \
        || npx --yes playwright@1.63.0 install chromium
fi

node monitor.js "$@"

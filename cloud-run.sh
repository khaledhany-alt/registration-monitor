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

# Cloud images often ship Playwright browsers already; use one before downloading.
if [[ -z "${CHROME_PATH:-}" ]]; then
    for dir in "${PLAYWRIGHT_BROWSERS_PATH:-}" /opt/pw-browsers "$HOME/.cache/ms-playwright"; do
        [[ -n "$dir" && -d "$dir" ]] || continue
        for name in chrome headless_shell; do
            found="$(find "$dir" -type f -name "$name" -path '*chrome-linux*' -perm -u+x 2>/dev/null | sort -r | head -n 1)"
            if [[ -n "$found" ]]; then
                export CHROME_PATH="$found"
                break 3
            fi
        done
    done
fi

if [[ -z "${CHROME_PATH:-}" ]]; then
    npx --yes playwright@1.63.0 install --with-deps chromium \
        || npx --yes playwright@1.63.0 install chromium
fi

echo "Browser: ${CHROME_PATH:-bundled Playwright Chromium}"
node monitor.js "$@"

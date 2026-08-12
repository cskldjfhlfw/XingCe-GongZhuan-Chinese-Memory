#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=/opt/shiyi
RELEASE_ID="${1:-}"
ARCHIVE="/tmp/shiyi-web-${RELEASE_ID}.tar.gz"
RELEASE_DIR="${APP_ROOT}/releases/${RELEASE_ID}"
PREVIOUS_TARGET="$(readlink -f "${APP_ROOT}/current" 2>/dev/null || true)"

[[ "$RELEASE_ID" =~ ^[0-9a-f]{40}$ ]]
test -f "$ARCHIVE"
mkdir -p "${APP_ROOT}/releases"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$ARCHIVE" -C "$RELEASE_DIR"
test -f "${RELEASE_DIR}/index.html"
ln -sfn "$RELEASE_DIR" "${APP_ROOT}/current"
rm -f "$ARCHIVE"

if ! docker compose -f "${APP_ROOT}/compose.yaml" up -d --force-recreate shiyi-web; then
  if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
    ln -sfn "$PREVIOUS_TARGET" "${APP_ROOT}/current"
    docker compose -f "${APP_ROOT}/compose.yaml" up -d --force-recreate shiyi-web
  fi
  exit 1
fi

for attempt in {1..20}; do
  if curl -fsS --max-time 3 http://127.0.0.1:17843/ >/dev/null; then
    find "${APP_ROOT}/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
      | sort -nr | tail -n +6 | cut -d' ' -f2- | xargs -r rm -rf
    exit 0
  fi
  sleep 2
done

if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
  ln -sfn "$PREVIOUS_TARGET" "${APP_ROOT}/current"
  docker compose -f "${APP_ROOT}/compose.yaml" up -d --force-recreate shiyi-web
fi
exit 1

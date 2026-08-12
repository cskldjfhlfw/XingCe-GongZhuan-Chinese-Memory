#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  release_id="${BASH_REMATCH[1]}"
  archive="/tmp/shiyi-web-${release_id}.tar.gz"
  umask 077
  cat > "$archive"
  exec /usr/local/sbin/shiyi-activate "$release_id"
fi

echo 'This key may only deploy a Shiyi release.' >&2
exit 1

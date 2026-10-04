#!/usr/bin/env bash
# Install only the player, using the versioned upstream Pi installer in this checkout.
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
  echo "Usage: sudo bash scripts/genesis-pi-setup.sh https://signage.your-domain.com" >&2
  echo "Use an origin URL only (no credentials, query, fragment or path)." >&2
  exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
echo 'Installing Genesis Guild Raspberry Pi player. The management server runs in Docker.'
export GENESIS_PLAYER_PATH=/player/genesis.html
exec bash "$SCRIPT_DIR/raspberry-pi-setup.sh" --player-only "${1%/}"

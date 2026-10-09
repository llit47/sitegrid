#!/bin/bash
set -euo pipefail
# Deliver this bootstrap through an authenticated channel with the pinned bundle.
exec python3 -u "$(dirname -- "$(readlink -f -- "$0")")/install_debian.py" "$@"

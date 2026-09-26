#!/usr/bin/env bash
set -euo pipefail

# Resolve symlinks so the script can be linked into PATH.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

# --import takes a module specifier, so pass the resolver as a file URL (raw paths break on #, ?, %).
RESOLVER_URL="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$SCRIPT_DIR/packages/coding-agent/src/experimental/source-resolver.ts")"
exec node --import "$RESOLVER_URL" "$SCRIPT_DIR/packages/coding-agent/src/experimental/vt420/main.ts" "$@"

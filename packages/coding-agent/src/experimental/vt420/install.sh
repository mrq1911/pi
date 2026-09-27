#!/usr/bin/env bash
# Install or update pi-vt420 from the checkout this script lives in, and make it the default pi.
# An npm-installed pi stays reachable as pi-classic. Linked as pi-vt420-update.
set -euo pipefail

ROOT="$(git -C "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" rev-parse --show-toplevel)"
BIN="${PI_VT420_BIN:-$HOME/.local/bin}"
cd "$ROOT"

if [[ "${1:-}" != "--no-pull" ]]; then
	before="$(git rev-parse HEAD)"
	git pull --ff-only --quiet
	after="$(git rev-parse HEAD)"
	if [[ "$before" != "$after" ]]; then git log --oneline "$before..$after" | head -20; fi
fi

# third-party dependencies, only when the lockfile changed since the last install
stamp="node_modules/.pi-vt420-lockfile"
if [[ ! -f "$stamp" ]] || ! cmp -s package-lock.json "$stamp"; then
	npm ci --ignore-scripts --no-audit --no-fund
	cp package-lock.json "$stamp"
fi

# the model catalog is generated rather than checked in; offline, the last one stays
if ! npm run --silent hydrate:model-data; then
	if [[ ! -d packages/ai/src/providers/data ]]; then
		echo "pi-vt420: the model catalog is missing and could not be fetched" >&2
		exit 1
	fi
	echo "pi-vt420: kept the existing model catalog" >&2
fi

mkdir -p "$BIN"
# the npm-installed pi: whatever pi pointed at before, or npm's global root, or the one next to $BIN
classic=""
if [[ -L "$BIN/pi" && "$(readlink -f "$BIN/pi")" != "$ROOT/pi-vt420.sh" ]]; then classic="$(readlink -f "$BIN/pi")"; fi
for root in "$(npm root -g)" "$(dirname "$BIN")/lib/node_modules"; do
	[[ -z "$classic" && -f "$root/@earendil-works/pi-coding-agent/dist/bundle/cli.js" ]] &&
		classic="$root/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
done
if [[ -n "$classic" ]]; then ln -sfn "$classic" "$BIN/pi-classic"; fi
ln -sfn "$ROOT/pi-vt420.sh" "$BIN/pi"
ln -sfn "$ROOT/pi-vt420.sh" "$BIN/pi-vt420"
ln -sfn "$ROOT/packages/coding-agent/src/experimental/vt420/install.sh" "$BIN/pi-vt420-update"
echo "pi starts pi-vt420 from $ROOT at $(git log -1 --format='%h %s')"

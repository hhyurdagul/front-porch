#!/usr/bin/env bash
# Export this app as a standalone repository for publication (committed files only, one fresh commit).
# Usage: bash scripts/export-public.sh <empty-output-dir>   Nothing is pushed; the owner publishes.
set -euo pipefail
out=${1:?Usage: export-public.sh <empty-output-dir>}
[[ ! -e $out || -z $(ls -A "$out") ]] || { echo "Output directory must be empty" >&2; exit 2; }
app_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
prefix=$(git -C "$app_dir" rev-parse --show-prefix)
mkdir -p "$out"
# Run from the repository root: from a subdirectory, git archive filters the tree by that path and exports nothing.
root=$(git -C "$app_dir" rev-parse --show-toplevel)
git -C "$root" archive --format=tar "HEAD:${prefix%/}" | tar -x -C "$out"
[[ -f $out/package.json ]] || { echo "Export is empty" >&2; exit 1; }
# Refuse to export anything that looks like a credential.
if grep -rIl -E 'AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[0-9A-Za-z]{20,}' "$out"; then
  echo "Possible credential in export; aborting" >&2; exit 1
fi
git -C "$out" init -q -b main
git -C "$out" add -A
git -C "$out" -c user.name="Front Porch" -c user.email="frontporch@users.noreply.github.com" \
  commit -q -m "Front Porch: Qloo Agentic Hackathon 2026 entry"
echo "Exported $(git -C "$out" ls-files | wc -l) files to $out"

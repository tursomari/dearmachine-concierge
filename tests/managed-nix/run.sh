#!/usr/bin/env bash
# Source-only container: no repository, home, socket, or profile mounts.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
engine=${CONTAINER_ENGINE:-podman}
context=$(mktemp -d "${MANAGED_TEST_TMPDIR:-/var/tmp}/dearmachine-managed-test.XXXXXX")
cleanup() {
  python3 - "$context" <<'PY_CLEANUP'
import os, shutil, sys
root = sys.argv[1]
for directory, dirs, files in os.walk(root, followlinks=False):
    os.chmod(directory, 0o700)
shutil.rmtree(root)
PY_CLEANUP
}
trap cleanup EXIT
cd "$root"
node_binary=$(nix develop --option eval-cache false -c sh -c 'command -v node')
node_package=$(dirname "$(dirname "$(readlink -f "$node_binary")")")
zsh_binary=$(nix develop --option eval-cache false -c sh -c 'command -v zsh')
zsh_package=$(dirname "$(dirname "$(readlink -f "$zsh_binary")")")
test -f packages/product-adapter/dist/managed-nix.mjs || { echo 'Run pnpm build in the pinned Nix shell first.' >&2; exit 1; }
mkdir -p "$context/store" "$context/packages/product-adapter/dist" "$context/packages/app/dist" "$context/tests/managed-nix"
if [[ -z "${DEARMACHINE_TEST_BINARY:-}" ]]; then
  echo 'Set DEARMACHINE_TEST_BINARY to a built native CLI; no installed host CLI is used.' >&2
  exit 1
fi
native_package=$(dirname "$(dirname "$(readlink -f "$DEARMACHINE_TEST_BINARY")")")
case "$native_package" in /nix/store/*) ;; *) echo 'Supply the production Nix package binary so its runtime closure can be copied.' >&2; exit 1;; esac
cp "$DEARMACHINE_TEST_BINARY" "$context/dearmachine"
while IFS= read -r path; do cp -a "$path" "$context/store/"; done < <(nix-store --query --requisites "$node_package" "$native_package" "$zsh_package" | sort -u)
cp packages/product-adapter/package.json "$context/packages/product-adapter/"
cp packages/app/dist/*.mjs "$context/packages/app/dist/"
cp packages/product-adapter/dist/*.mjs "$context/packages/product-adapter/dist/"
cp tests/managed-nix/lifecycle.mjs "$context/tests/managed-nix/"
cp tests/managed-nix/Dockerfile "$context/Dockerfile"
image="localhost/dearmachine-managed-test:$$"
"$engine" build --network=none --build-arg "NODE_PACKAGE=$node_package" --build-arg "ZSH_PACKAGE=$zsh_package" -t "$image" "$context"
"$engine" run --rm --network=none "$image"

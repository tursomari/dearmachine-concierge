#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'INSTALLER QSE CONTAINER FAILURE: %s\n' "$*" >&2
  exit 1
}

required_value() {
  qse_name=$1
  qse_value=${!qse_name:-}
  test -n "$qse_value" && ! printf '%s' "$qse_value" | grep -q '[[:cntrl:]]' || \
    fail "$qse_name is missing or unsafe"
}

for qse_name in QSE_RECEIVER_ID QSE_RECEIVER_ADDRESS QSE_SENDER_ADDRESS QSE_RUN_ID; do
  required_value "$qse_name"
done

umbrella=/workspace/machtiani
runtime=/run/machtiani-installer-qse
shared_secret=$runtime/secrets/shared
backend_secret=$runtime/secrets/backend
agentmail_secret=$runtime/secrets/agentmail
for qse_secret in "$shared_secret" "$backend_secret" "$agentmail_secret"; do
  test -f "$qse_secret" && test ! -L "$qse_secret" && test -s "$qse_secret" || \
    fail 'a private runtime credential file is missing'
  test "$(stat -c '%a' "$qse_secret")" = 600 || fail 'a runtime credential file is not mode 0600'
done

umask 077
export HOME=/home/installer
export XDG_STATE_HOME=$HOME/.local/state
export XDG_DATA_HOME=$HOME/.local/share
export PATH=$HOME/.local/bin:$HOME/.nix-profile/bin:/root/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin
mkdir -p "$HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME" "$HOME/.config/dearmachine"

git config --global user.name 'Machtiani Installer QSE'
git config --global user.email 'installer-qse@example.invalid'
git config --global init.defaultBranch main

# Reconstruct fresh local origins and clone the exact recursive gitlinks.
fixture_root=$(mktemp -d /run/machtiani-qse-git/fixture.XXXXXX)
umbrella=$(python3 /workspace/machtiani/machtiani-installer/tests/e2e/git-fixture.py \
  restore /workspace/machtiani/.qse-git "$fixture_root/repositories")

cp "$agentmail_secret" "$HOME/.config/dearmachine/agentmail-api-key"
chmod 0600 "$HOME/.config/dearmachine/agentmail-api-key"
node /workspace/machtiani/machtiani-installer/tests/e2e/prepare-model.mjs
selection=$runtime/selection.json
reasoning=$(cat "$runtime/reasoning-effort")
reasoning_args=()
if test "$reasoning" != default; then
  reasoning_args=(--reasoning-effort "$reasoning")
fi
rm -f -- "$shared_secret" "$backend_secret" "$agentmail_secret"

git -C "$umbrella" status --porcelain=v2 --untracked-files=all --ignore-submodules=none > "$runtime/source.before"
node /workspace/machtiani/machtiani-installer/packages/app/dist/headless-bin.mjs \
  --source-root "$umbrella" --selection-file "$selection" \
  --existing-inbox-id "$QSE_RECEIVER_ID" "${reasoning_args[@]}" \
  > "$runtime/result.json" 2> "$runtime/installer.stderr"
chmod 0600 "$runtime/result.json" "$runtime/installer.stderr"

python3 - "$runtime/result.json" "$QSE_RECEIVER_ADDRESS" <<'PY'
from pathlib import Path
import json
import sys

result = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if result != {"inboxAddress": sys.argv[2]}:
    raise SystemExit("headless installer returned the wrong inbox identity")
PY

dearmachine status > "$runtime/dearmachine.status"
(cd "$HOME/.dearmachine/entrypoint/main" && \
  DEARMACHINE_BACKENDS='["forge"]' agent-manager backend health forge) > "$runtime/backend.status"
grep -Eq '^(DearMachine is running([ .(]|$)|Dear Machine: running$)' "$runtime/dearmachine.status" || fail 'Dear Machine is not running'
grep -Eq '(^|[[:space:]])result=ok([[:space:]]|$)' "$runtime/backend.status" || fail 'Forge backend health failed'
git -C "$umbrella" status --porcelain=v2 --untracked-files=all --ignore-submodules=none > "$runtime/source.status"
python3 - "$runtime/source.before" "$runtime/source.status" <<'PY'
from pathlib import Path
import sys

if Path(sys.argv[1]).read_bytes() != Path(sys.argv[2]).read_bytes():
    raise SystemExit("product installation changed the source snapshot")
PY

touch "$runtime/ready"
chmod 0600 "$runtime/ready" "$runtime/dearmachine.status" "$runtime/backend.status" "$runtime/source.status"
exec sleep infinity

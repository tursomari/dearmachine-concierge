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
openrouter_secret=$runtime/secrets/openrouter
agentmail_secret=$runtime/secrets/agentmail
for qse_secret in "$openrouter_secret" "$agentmail_secret"; do
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

initialize_repository() {
  qse_repo=$1
  shift
  git -C "$qse_repo" init --quiet --initial-branch=main
  git -C "$qse_repo" add -- "$@"
  git -C "$qse_repo" commit --quiet -m 'test: seed source-only QSE snapshot'
}

initialize_repository "$umbrella/machtiani-harness" \
  .dockerignore .gitignore .gitmodules .machtiani AGENTS.md BENCHING.md README.md ROADMAP.md TESTING.md \
  agent docs flake.lock flake.nix issues machtiani_pier_adapter scripts tests third_party
git -C "$umbrella/machtiani-harness" add -f -- plans
git -C "$umbrella/machtiani-harness" commit --quiet --amend --no-edit
harness_origin=$(mktemp -d /tmp/machtiani-qse-harness-origin.XXXXXX)/origin.git
git init --quiet --bare --initial-branch=main "$harness_origin"
git -C "$umbrella/machtiani-harness" remote add origin "file://$harness_origin"
git -C "$umbrella/machtiani-harness" push --quiet --set-upstream origin main

initialize_repository "$umbrella/dearmachine" \
  .gitattributes .gitignore LICENSE README.md ROADMAP.md TODO.md contrib dearmachine deploy docs flake.lock flake.nix scripts tests

initialize_repository "$umbrella/machtiani-installer" \
  .gitignore LICENSE LICENSES README.md THIRD_PARTY_NOTICES.md assets flake.lock flake.nix package.json packages patches \
  pnpm-lock.yaml pnpm-workspace.yaml scripts tests tsconfig.json vitest.config.ts

initialize_repository "$umbrella" \
  .gitignore .gitmodules INSTALL.md LICENSE README.md docs scripts tests

IFS= read -r openrouter_key < "$openrouter_secret"
IFS= read -r agentmail_key < "$agentmail_secret"
test -n "$openrouter_key" && test -n "$agentmail_key" || fail 'a runtime credential is empty'
test "$(wc -l < "$openrouter_secret")" -eq 1 && test "$(wc -l < "$agentmail_secret")" -eq 1 || \
  fail 'runtime credentials must each contain exactly one line'

printf 'OPENROUTER_API_KEY=%s\n' "$openrouter_key" > "$HOME/.config/dearmachine/backends.env"
printf '%s\n' "$agentmail_key" > "$HOME/.config/dearmachine/agentmail-api-key"
chmod 0600 "$HOME/.config/dearmachine/backends.env" "$HOME/.config/dearmachine/agentmail-api-key"

# Forge 2.13.21 imports environment credentials into its private store only
# when direct mode starts. Closed stdin makes that migration fail safely before
# an agent turn; all output remains inside this disposable QSE runtime.
forge_migration_stdout=$runtime/forge-migration.stdout
forge_migration_stderr=$runtime/forge-migration.stderr
OPENROUTER_API_KEY=$openrouter_key forge </dev/null > "$forge_migration_stdout" 2> "$forge_migration_stderr" || true
chmod 0600 "$forge_migration_stdout" "$forge_migration_stderr"
test -f "$HOME/.forge/.credentials.json" && test "$(stat -c '%a' "$HOME/.forge/.credentials.json")" = 600 || \
  fail 'Forge did not create a private disposable credential store'
forge config set model open_router z-ai/glm-5.3-flash > "$forge_migration_stdout" 2> "$forge_migration_stderr" || \
  fail 'Forge rejected the pinned OpenRouter model'
forge config set reasoning-effort high > "$forge_migration_stdout" 2> "$forge_migration_stderr" || \
  fail 'Forge rejected high reasoning effort'

selection=$runtime/selection.json
QSE_SELECTION_PATH=$selection python3 - <<'PY'
from pathlib import Path
import json
import os

selection = {
    "provider": "openrouter",
    "model": "z-ai/glm-5.3-flash",
    "transport": "agentmail",
    "authorizedSender": os.environ["QSE_SENDER_ADDRESS"],
    "detectedBackends": ["forge"],
    "backend": {
        "name": "Forge",
        "id": "forge",
        "executable": "/usr/local/bin/forge",
        "status": "ready",
        "summary": "functional probe passed",
    },
}
path = Path(os.environ["QSE_SELECTION_PATH"])
path.write_text(json.dumps(selection, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
path.chmod(0o600)
PY

rm -f -- "$openrouter_secret" "$agentmail_secret"
unset openrouter_key agentmail_key

git -C "$umbrella" status --porcelain=v2 --untracked-files=all --ignore-submodules=none > "$runtime/source.before"
node "$umbrella/machtiani-installer/packages/app/dist/headless-bin.mjs" \
  --source-root "$umbrella" --selection-file "$selection" \
  --existing-inbox-id "$QSE_RECEIVER_ID" --reasoning-effort high \
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
grep -Fq 'DearMachine is running' "$runtime/dearmachine.status" || fail 'Dear Machine is not running'
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

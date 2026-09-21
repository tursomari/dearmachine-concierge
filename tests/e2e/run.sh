#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'MACHTIANI INSTALLER IXE/QSE FAILURE: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'usage: tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani [--self-test]' \
    '' \
    'The live form creates and deletes exactly two disposable AgentMail inboxes.'
}

umbrella_root=
self_test=false
while test "$#" -gt 0; do
  case "$1" in
    --umbrella-root)
      test "$#" -ge 2 || { usage >&2; exit 2; }
      umbrella_root=$2
      shift 2
      ;;
    --self-test)
      self_test=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

test -n "$umbrella_root" && test "${umbrella_root#/}" != "$umbrella_root" || fail '--umbrella-root must be absolute'
umbrella_root=$(realpath "$umbrella_root")
for qse_component in machtiani-harness dearmachine; do
  test -d "$umbrella_root/$qse_component" || fail "umbrella root lacks $qse_component"
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
installer_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
dockerfile=$script_dir/Dockerfile
installer_flake=$installer_root/flake.nix
transaction_lib=$umbrella_root/tests/e2e-installation-procedure/lib/txn.sh
agentmail_lib=$umbrella_root/tests/e2e-installation-procedure/lib/agentmail.sh
secrets_lib=$umbrella_root/tests/e2e-installation-procedure/lib/secrets.sh
helper_source=$umbrella_root/tests/e2e-installation-procedure/agentmail-helper
for qse_path in "$transaction_lib" "$agentmail_lib" "$secrets_lib" "$helper_source/main.go"; do
  test -e "$qse_path" || fail "required umbrella test support is missing: $qse_path"
done

dockerfile_line() {
  dockerfile_pattern=$1
  dockerfile_description=$2
  dockerfile_match=$(grep -nF -- "$dockerfile_pattern" "$dockerfile" | sed -n '1p')
  test -n "$dockerfile_match" || fail "QSE Dockerfile lacks $dockerfile_description"
  printf '%s\n' "${dockerfile_match%%:*}"
}

dependency_copy_line=$(dockerfile_line 'COPY machtiani-installer/flake.nix' 'the dependency-manifest cache boundary')
dependency_install_line=$(dockerfile_line 'pnpm --dir /workspace/machtiani/machtiani-installer install' 'the dependency installation step')
source_copy_line=$(dockerfile_line 'COPY . /workspace/machtiani' 'the complete source copy')
source_test_line=$(dockerfile_line 'pnpm --dir /workspace/machtiani/machtiani-installer test' 'the source test step')
test "$dependency_copy_line" -lt "$dependency_install_line" && \
  test "$dependency_install_line" -lt "$source_copy_line" && \
  test "$source_copy_line" -lt "$source_test_line" || \
  fail 'QSE Dockerfile must cache dependencies before copying and testing changing source'
grep -F -- '--network-concurrency=1' "$dockerfile" >/dev/null || \
  fail 'QSE Dockerfile must bound pnpm download concurrency for memory safety'
grep -F -- 'id=machtiani-installer-qse-pnpm-v11,target=/root/.local/share/pnpm/store' "$dockerfile" >/dev/null || \
  fail 'QSE Dockerfile must persist the pnpm content-addressable store'
grep -F -- '--store-dir=/root/.local/share/pnpm/store' "$dockerfile" >/dev/null || \
  fail 'QSE dependency install must use the persistent pnpm store'
grep -F -- 'pnpm config set network-concurrency 1' "$installer_flake" >/dev/null || \
  fail 'Nix dependency fetch must serialize large provider-runtime downloads'
grep -F -- 'pnpm config set child-concurrency 1' "$installer_flake" >/dev/null || \
  fail 'Nix dependency fetch must bound child process concurrency'
grep -F -- 'src = packageSource;' "$installer_flake" >/dev/null || \
  fail 'installer package source must exclude development artifacts before the Nix build'
grep -F -- 'packageSource = pkgs.lib.cleanSourceWith {' "$installer_flake" >/dev/null || \
  fail 'installer package source must use an explicit source filter'
grep -F -- '"node_modules"' "$installer_flake" >/dev/null || \
  fail 'installer package source filter must exclude node_modules'
if grep -F -- 'src = self;' "$installer_flake" >/dev/null; then
  fail 'installer package source must not expose path-flake development artifacts to the Nix build'
fi

qse_agentmail_secrets_path() {
  qse_agentmail_root=$1
  qse_agentmail_path=${AGENTMAIL_SECRETS_PATH:-$qse_agentmail_root/.secrets}
  case "$qse_agentmail_path" in
    /*) printf '%s\n' "$qse_agentmail_path" ;;
    *) return 1 ;;
  esac
}
agentmail_secrets_path=$(qse_agentmail_secrets_path "$umbrella_root") || \
  fail 'AGENTMAIL_SECRETS_PATH must be absolute'

lock_file=${TMPDIR:-/var/tmp}/machtiani-installer-qse-$(id -u).lock
umask 077
if test ! -e "$lock_file" && test ! -L "$lock_file"; then
  (set -C; : > "$lock_file") 2>/dev/null || true
fi
python3 - "$lock_file" <<'PY'
from pathlib import Path
import os
import stat
import sys

metadata = Path(sys.argv[1]).lstat()
if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
    raise SystemExit("QSE lock must be a regular non-symlink file")
if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
    raise SystemExit("QSE lock has unsafe ownership or mode")
PY
exec 9<> "$lock_file"
flock -n 9 || fail 'another installer IXE/QSE holds the private lock'

# shellcheck source=/dev/null
source "$transaction_lib"
# shellcheck source=/dev/null
source "$agentmail_lib"
declare -F agentmail_discover_stable_inbox_address >/dev/null || fail 'shared stable-inbox discovery helper is missing'
# shellcheck source=/dev/null
source "$secrets_lib"

txn_init
TXN_CLEANUP_ENABLED=0
export TXN_CLEANUP_ENABLED
run_root=$TXN_RUNTIME_ROOT
context_dir=$run_root/context
helper_path=$run_root/agentmail-helper
baseline_snapshot=$run_root/agentmail-baseline.json
final_snapshot=$run_root/agentmail-final.json
host_client_snapshot=$run_root/host-client.json
source_baseline=$run_root/source-status
image_name=machtiani-installer-qse:local
run_id=$(python3 - <<'PY'
import secrets
print(secrets.token_hex(6))
PY
)
container_name=machtiani-installer-qse-$run_id
container_id=
container_cidfile=$run_root/container.cid
container_label=to.agentmail.machtiani.installer-qse
baseline_ready=false
run_complete=false
cleanup_active=false

mkdir "$context_dir"
chmod 0700 "$context_dir"
git -C "$umbrella_root" status --porcelain=v2 --untracked-files=all --ignore-submodules=none > "$source_baseline"
chmod 0600 "$source_baseline"

cleanup() {
  cleanup_status=$?
  if test "$cleanup_active" = true; then
    exit "$cleanup_status"
  fi
  cleanup_active=true
  trap - EXIT HUP INT TERM
  cleanup_safe=true

  if test -z "$container_id" && test -s "$container_cidfile"; then
    container_id=$(txn_reconcile_container_from_cidfile "$container_name" 2>/dev/null) || cleanup_safe=false
  fi
  if test -n "$container_id"; then
    if test "${TXN_KEEP_RUNTIME:-0}" = 1; then
      docker logs "$container_id" > "$run_root/container.log" 2>&1 || true
      chmod 0600 "$run_root/container.log"
      retained_runtime=$run_root/container-runtime
      mkdir "$retained_runtime"
      chmod 0700 "$retained_runtime"
      docker cp "$container_id:/run/machtiani-installer-qse/." "$retained_runtime" 2>/dev/null || true
      mkdir "$retained_runtime/installer-state"
      docker cp "$container_id:/home/installer/.local/state/machtiani-installer/." \
        "$retained_runtime/installer-state" 2>/dev/null || true
      chmod -R go-rwx "$retained_runtime"
    fi
    inspected_label=$(docker inspect --format "{{ index .Config.Labels \"$container_label\" }}" "$container_id" 2>/dev/null) || cleanup_safe=false
    inspected_name=$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null) || cleanup_safe=false
    if test "$cleanup_safe" = true && test "$inspected_label" = "$run_id" && test "$inspected_name" = "/$container_name"; then
      docker rm --force "$container_id" >/dev/null 2>&1 || cleanup_safe=false
    else
      printf 'INCONCLUSIVE CLEANUP: container identity could not be proven.\n' >&2
      cleanup_safe=false
    fi
  fi

  if test -f "$host_client_snapshot" && ! agentmail_assert_host_client_unchanged "$host_client_snapshot"; then
    printf 'INCONCLUSIVE CLEANUP: permanent host client identity changed; refusing remote cleanup.\n' >&2
    cleanup_safe=false
  fi

  if test "$cleanup_safe" = true && test -s "$TXN_JOURNAL"; then
    txn_cleanup_all || cleanup_safe=false
  fi
  if test "$cleanup_safe" = true && test "$baseline_ready" = true; then
    agentmail_wait_for_baseline "$baseline_snapshot" "$final_snapshot" "$stable_address" || cleanup_safe=false
  fi
  if ! git -C "$umbrella_root" status --porcelain=v2 --untracked-files=all --ignore-submodules=none | cmp -s - "$source_baseline"; then
    printf 'QSE source checkout changed unexpectedly.\n' >&2
    cleanup_safe=false
  fi
  if test "$cleanup_safe" != true; then
    cleanup_status=1
  fi
  if test "${TXN_KEEP_RUNTIME:-0}" != 1 && test -d "$run_root" && test ! -L "$run_root"; then
    rm -rf -- "$run_root"
  fi
  if test "$cleanup_status" -eq 0 && test "$run_complete" = true; then
    if test "$self_test" = true; then
      printf 'Machtiani Installer uncredentialed IXE/QSE self-test passed.\n'
    else
      printf 'Machtiani Installer containerized IXE and live email QSE passed; disposable resources were removed.\n'
    fi
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf '==> Creating a source-only installer IXE/QSE context...\n'
git -C "$umbrella_root" archive HEAD | tar -x -C "$context_dir"
mkdir -p "$context_dir/machtiani-harness" "$context_dir/dearmachine" "$context_dir/machtiani-installer"
git -C "$umbrella_root/machtiani-harness" archive "$(git -C "$umbrella_root" rev-parse HEAD:machtiani-harness)" | tar -x -C "$context_dir/machtiani-harness"
git -C "$umbrella_root/dearmachine" archive "$(git -C "$umbrella_root" rev-parse HEAD:dearmachine)" | tar -x -C "$context_dir/dearmachine"
git -C "$umbrella_root/machtiani-installer" archive "$(git -C "$umbrella_root" rev-parse HEAD:machtiani-installer)" | tar -x -C "$context_dir/machtiani-installer"

# Export objects from umbrella HEAD and its recursive pins, never component HEADs.
python3 "$script_dir/git-fixture.py" export "$umbrella_root" "$context_dir/.qse-git"

forbidden=$(find "$context_dir" \( -name .git -o -name .ssh -o -name .secrets -o -name '.env*' \
  -o -name .forge -o -name .credentials.json \) -print -quit)
test -z "$forbidden" || fail "source context contains forbidden state: $forbidden"
test -x "$context_dir/machtiani-installer/tests/e2e/container-run.sh" || fail 'source context lacks the executable QSE entry point'

if test "$self_test" = true; then
  test "$(AGENTMAIL_SECRETS_PATH=/private/agentmail.env qse_agentmail_secrets_path /source)" = /private/agentmail.env || \
    fail 'AgentMail credential path override is not honored'
  test "$(unset AGENTMAIL_SECRETS_PATH; qse_agentmail_secrets_path /source)" = /source/.secrets || \
    fail 'AgentMail credential path default is not umbrella-local'
  if AGENTMAIL_SECRETS_PATH=relative/path qse_agentmail_secrets_path /source >/dev/null 2>&1; then
    fail 'AgentMail credential path accepted a relative override'
  fi
  python3 "$script_dir/git-fixture-test.py"
  mkdir "$run_root/git-home"
  HOME="$run_root/git-home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$run_root/git-home/.gitconfig" \
    python3 "$script_dir/git-fixture.py" restore "$context_dir/.qse-git" "$run_root/git-preflight"
  (unset TXN_RUNTIME_ROOT TXN_JOURNAL; txn_self_test)
  run_complete=true
  exit 0
fi

for qse_command in docker go; do
  command -v "$qse_command" >/dev/null 2>&1 || fail "$qse_command is required"
done

printf '==> Building the source-only installer IXE image...\n'
docker build --progress plain --file "$context_dir/machtiani-installer/tests/e2e/Dockerfile" \
  --tag "$image_name" "$context_dir"
test "$(docker run --rm --entrypoint /usr/local/bin/forge "$image_name" --version)" = 'forge 2.13.21' || \
  fail 'IXE image has the wrong Forge version'
docker run --rm --entrypoint /bin/sh "$image_name" -eu -c '
  bad=$(find /workspace/machtiani \( -name .git -o -name .ssh -o -name .secrets -o -name ".env*" \
    -o -name .forge -o -name .credentials.json \) -print -quit)
  test -z "$bad"
' || fail 'IXE image contains forbidden host or credential state'

printf '==> Checking the local origins and recursive pins without credentials...\n'
docker run --rm --network=none --tmpfs /tmp:exec,size=2g --env HOME=/tmp/qse-preflight-home \
  --entrypoint /bin/sh "$image_name" -ec '
    mkdir -p "$HOME"
    python3 /workspace/machtiani/machtiani-installer/tests/e2e/git-fixture.py \
      restore /workspace/machtiani/.qse-git /tmp/qse-preflight
  '

printf '==> Loading approved credentials into the private host transaction...\n'
secrets_load "$agentmail_secrets_path"
secrets_get AGENTMAIL_API_KEY agentmail_api_key
openrouter_path=${OPENROUTER_KEY_PATH:-$HOME/.secrets/openrouter/work-api-key.txt}
python3 - "$openrouter_path" <<'PY'
from pathlib import Path
import os
import stat
import sys

path = Path(sys.argv[1])
metadata = path.lstat()
if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid():
    raise SystemExit("OpenRouter credential source must be an owned regular non-symlink file")
lines = path.read_bytes().splitlines()
if len(lines) != 1 or not lines[0] or b"\0" in lines[0]:
    raise SystemExit("OpenRouter credential source must contain exactly one nonempty line")
PY
openrouter_api_key=$(sed -n '1p' "$openrouter_path")
export AGENTMAIL_API_KEY=$agentmail_api_key
TXN_AGENTMAIL_HELPER=$helper_path
export TXN_AGENTMAIL_HELPER

(cd "$helper_source" && GOPROXY=off GOFLAGS=-mod=mod go build -o "$helper_path" .)
chmod 0700 "$helper_path"

printf '==> Protecting the permanent AgentMail inbox and client identity...\n'
stable_address=$(agentmail_discover_host_client_address)
if test -n "$stable_address"; then
  agentmail_snapshot_host_client "$host_client_snapshot" "$stable_address"
else
  stable_address=$(agentmail_discover_stable_inbox_address)
fi
agentmail_snapshot "$baseline_snapshot" "$stable_address"
baseline_ready=true
stable_id=$(agentmail_snapshot_stable_id "$baseline_snapshot")
AGENTMAIL_MUTATION_FORBIDDEN_ID=$stable_id
AGENTMAIL_MUTATION_FORBIDDEN_ADDRESS=$stable_address
export AGENTMAIL_MUTATION_FORBIDDEN_ID AGENTMAIL_MUTATION_FORBIDDEN_ADDRESS

run_agentmail_helper() {
  env -u AGENTMAIL_BASE_URL -u AGENTMAIL_CUSTOM_HEADERS "$helper_path" "$@"
}

provision_inbox() {
  provision_role=$1
  provision_output=$2
  provision_client=machtiani-installer-qse-$run_id-$provision_role
  provision_display="Machtiani Installer QSE $run_id $provision_role"
  provision_intent=$(python3 - "$provision_client" "$provision_display" "$run_id" "$provision_role" <<'PY'
import json
import sys
print(json.dumps({"client_id": sys.argv[1], "display_name": sys.argv[2], "run_id": sys.argv[3], "role": sys.argv[4]}, sort_keys=True, separators=(",", ":")))
PY
)
  txn_record intent inbox-create "$provision_intent"
  provision_intent_key=$TXN_LAST_RESOURCE_KEY
  provision_response=$run_root/inbox-$provision_role.json
  run_agentmail_helper create-inbox --client-id "$provision_client" --display-name "$provision_display" \
    --metadata-run-id "$run_id" --metadata-role "$provision_role" > "$provision_response"
  chmod 0600 "$provision_response"
  provision_identity=$(python3 - "$provision_response" "$provision_client" "$provision_display" "$run_id" "$provision_role" "$stable_id" <<'PY'
import json
import sys
row = json.load(open(sys.argv[1], encoding="utf-8"))
expected = {"machtiani_ipe_run": sys.argv[4], "machtiani_ipe_role": sys.argv[5]}
if row.get("client_id") != sys.argv[2] or row.get("display_name") != sys.argv[3] or row.get("metadata") != expected:
    raise SystemExit("created inbox does not match its run-unique intent")
if not row.get("inbox_id") or not row.get("email") or row.get("inbox_id") == sys.argv[6]:
    raise SystemExit("created inbox has an unsafe identity")
print(json.dumps(row, sort_keys=True, separators=(",", ":")))
PY
)
  txn_record create inbox "$provision_identity"
  provision_key=$TXN_LAST_RESOURCE_KEY
  txn_mark_done "$provision_key"
  txn_mark_done "$provision_intent_key"
  printf -v "$provision_output" '%s' "$provision_identity"
}

record_allow() {
  allow_scope_id=$1
  allow_direction=$2
  allow_entry=$3
  allow_identity=$(python3 - "$allow_scope_id" "$allow_direction" "$allow_entry" <<'PY'
import json
import sys
print(json.dumps({"scope": "inbox", "scope_id": sys.argv[1], "direction": sys.argv[2], "type": "allow", "entry": sys.argv[3]}, sort_keys=True, separators=(",", ":")))
PY
)
  txn_record create allowlist-entry "$allow_identity"
}

create_allow() {
  create_scope_id=$1
  create_direction=$2
  create_entry=$3
  existing_allow=$run_root/allow-before-$create_direction.json
  run_agentmail_helper lists --scope inbox --scope-id "$create_scope_id" --direction "$create_direction" --type allow > "$existing_allow"
  python3 - "$existing_allow" "$create_entry" <<'PY'
import json
import sys
rows = json.load(open(sys.argv[1], encoding="utf-8"))["entries"]
if any(row.get("entry") == sys.argv[2] for row in rows):
    raise SystemExit("refusing to replace a pre-existing allowlist entry")
PY
  record_allow "$create_scope_id" "$create_direction" "$create_entry"
  run_agentmail_helper lists-create --scope inbox --scope-id "$create_scope_id" \
    --direction "$create_direction" --type allow --entry "$create_entry" >/dev/null
}

printf '==> Provisioning exactly two disposable inboxes...\n'
provision_inbox receiver receiver_identity
provision_inbox sender sender_identity
receiver_id=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["inbox_id"])' <<< "$receiver_identity")
receiver_address=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["email"])' <<< "$receiver_identity")
sender_id=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["inbox_id"])' <<< "$sender_identity")
sender_address=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["email"])' <<< "$sender_identity")

for pair_direction in receive send reply; do
  record_allow "$receiver_id" "$pair_direction" "$sender_address"
done
create_allow "$sender_id" send "$receiver_address"
create_allow "$sender_id" reply "$receiver_address"

printf '%s\n' "$openrouter_api_key" > "$run_root/openrouter.key"
printf '%s\n' "$agentmail_api_key" > "$run_root/agentmail.key"
chmod 0600 "$run_root/openrouter.key" "$run_root/agentmail.key"

container_intent=$(python3 - "$container_name" "$container_cidfile" "$container_label" "$run_id" <<'PY'
import json
import sys
print(json.dumps({"container_name": sys.argv[1], "cidfile": sys.argv[2], "label_name": sys.argv[3], "label_value": sys.argv[4]}, sort_keys=True, separators=(",", ":")))
PY
)
txn_record intent container-create "$container_intent"
docker create --tmpfs /run/machtiani-qse-git:exec,size=2g --name "$container_name" --cidfile "$container_cidfile" --label "$container_label=$run_id" \
  --env QSE_RECEIVER_ID="$receiver_id" --env QSE_RECEIVER_ADDRESS="$receiver_address" \
  --env QSE_SENDER_ADDRESS="$sender_address" --env QSE_RUN_ID="$run_id" "$image_name" >/dev/null
chmod 0600 "$container_cidfile"
container_id=$(txn_reconcile_container_from_cidfile "$container_name")
docker cp "$run_root/openrouter.key" "$container_id:/run/machtiani-installer-qse/secrets/openrouter" >/dev/null
docker cp "$run_root/agentmail.key" "$container_id:/run/machtiani-installer-qse/secrets/agentmail" >/dev/null
docker start "$container_id" >/dev/null

printf '==> Running the guarded native installation in the sparse container...\n'
install_deadline=$(( $(date +%s) + 3600 ))
while ! docker exec "$container_id" test -f /run/machtiani-installer-qse/ready 2>/dev/null; do
  test "$(date +%s)" -lt "$install_deadline" || fail 'native product installation exceeded one hour'
  test "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true || fail 'QSE container exited during product installation'
  sleep 2
done

for artifact in result.json installer.stderr dearmachine.status backend.status source.status; do
  docker cp "$container_id:/run/machtiani-installer-qse/$artifact" "$run_root/$artifact" >/dev/null
  chmod 0600 "$run_root/$artifact"
done
docker cp "$container_id:/home/installer/.local/state/machtiani-installer/product-installation.json" "$run_root/product-installation.json" >/dev/null
docker cp "$container_id:/home/installer/.config/dearmachine/machtiani/config.toml" "$run_root/machtiani-config.toml" >/dev/null
docker cp "$container_id:/home/installer/.dearmachine/log/dearmachine.log" "$run_root/dearmachine.log" >/dev/null
chmod 0600 "$run_root/product-installation.json" "$run_root/machtiani-config.toml" "$run_root/dearmachine.log"

QSE_SCAN_OPENROUTER=$openrouter_api_key QSE_SCAN_AGENTMAIL=$agentmail_api_key python3 - \
  "$run_root/result.json" "$run_root/installer.stderr" "$run_root/product-installation.json" \
  "$run_root/machtiani-config.toml" "$run_root/dearmachine.log" <<'PY'
from pathlib import Path
import os
import sys

secrets = [os.environ["QSE_SCAN_OPENROUTER"].encode(), os.environ["QSE_SCAN_AGENTMAIL"].encode()]
for raw_path in sys.argv[1:]:
    data = Path(raw_path).read_bytes()
    if any(secret in data for secret in secrets):
        raise SystemExit("credential material appeared in a retained QSE artifact")
PY

printf '==> Sending a real test email through the installed native client...\n'
nonce=$(python3 - <<'PY'
import secrets
print(secrets.token_hex(8))
PY
)
marker=MACHTIANI_INSTALLER_QSE_OK_$nonce
subject="Machtiani Installer QSE $run_id"
send_result=$run_root/send.json
run_agentmail_helper send --inbox-id "$sender_id" --to "$receiver_address" --subject "$subject" \
  --text "Reply with exactly $marker and no other text." --idempotency "machtiani-installer-qse-$run_id" > "$send_result"
chmod 0600 "$send_result"
thread_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])' < "$send_result")

reply_found=false
reply_deadline=$(( $(date +%s) + 1200 ))
while test "$(date +%s)" -lt "$reply_deadline"; do
  sender_messages=$run_root/sender-messages.json
  run_agentmail_helper list-messages --inbox-id "$sender_id" > "$sender_messages"
  reply_message_id=$(python3 - "$sender_messages" "$thread_id" "$receiver_address" <<'PY'
from email.utils import parseaddr
import json
import sys

messages = json.load(open(sys.argv[1], encoding="utf-8"))["messages"]
thread_id, receiver = sys.argv[2:]
matches = [row for row in messages if row.get("thread_id") == thread_id
           and parseaddr(row.get("from", ""))[1].casefold() == receiver.casefold()]
if len(matches) > 1:
    raise SystemExit("live exchange created duplicate replies")
print(matches[0]["message_id"] if matches else "")
PY
  ) || fail 'AgentMail reply observation became ambiguous'
  if test -n "$reply_message_id"; then
    reply=$run_root/reply.json
    run_agentmail_helper get-message --inbox-id "$sender_id" --id "$reply_message_id" > "$reply"
    chmod 0600 "$reply"
    if python3 - "$reply" "$thread_id" "$receiver_address" "$marker" <<'PY'
from email.utils import parseaddr
import json
import sys

row = json.load(open(sys.argv[1], encoding="utf-8"))
thread_id, receiver, marker = sys.argv[2:]
valid = (row.get("thread_id") == thread_id
         and parseaddr(row.get("from", ""))[1].casefold() == receiver.casefold()
         and marker in (row.get("text") or ""))
raise SystemExit(0 if valid else 1)
PY
    then
      reply_found=true
      break
    fi
  fi
  sleep 5
done
test "$reply_found" = true || fail 'the installed client did not deliver the expected live reply within 20 minutes'

docker exec -i "$container_id" python3 - <<'PY'
from pathlib import Path
import sqlite3

databases = list(Path("/home/installer/.dearmachine/pairs").glob("*/state/dearmachine.db"))
if len(databases) != 1:
    raise SystemExit("expected exactly one Dear Machine pair database")
connection = sqlite3.connect(f"file:{databases[0]}?mode=ro", uri=True)
try:
    processed = connection.execute("SELECT count(*) FROM processed_messages").fetchone()[0]
    sessions = connection.execute("SELECT count(*) FROM thread_sessions").fetchone()[0]
finally:
    connection.close()
if processed < 1 or sessions < 1:
    raise SystemExit("live reply lacks processed-message or backend-session evidence")
PY

run_complete=true

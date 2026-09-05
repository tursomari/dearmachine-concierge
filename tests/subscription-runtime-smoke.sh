#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/machtiani-subscription-smoke-test.XXXXXXXX")
trap 'rm -rf -- "$TEST_ROOT"' EXIT
BIN=$TEST_ROOT/bin
CAPTURE=$TEST_ROOT/capture
mkdir -p "$BIN" "$CAPTURE"

cat >"$BIN/machtiani-model-host" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == --profile ]]; then
  read -r request
  printf '%s\n' "{\"v\":1,\"id\":\"status\",\"result\":{\"authenticated\":${SMOKE_AUTHENTICATED:-false},\"method\":\"subscription\"}}"
  exit
fi
printf '%s\n' "$*" >"$SMOKE_CAPTURE/login-args"
profile=${4:?profile argument is missing}
cp "$profile" "$SMOKE_CAPTURE/profile.json"
printf 'Authentication completed.\n'
EOF

cat >"$BIN/machtiani" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$SMOKE_CAPTURE/machtiani-args"
cp "$MACHTIANI_CONFIG" "$SMOKE_CAPTURE/config.toml"
if [[ $1 == verify ]]; then
  printf '%s\n' '{"version":1,"status":"ok","roles":[{"role":"planner"},{"role":"shell-agent"},{"role":"answer"},{"role":"file-discovery"}]}'
fi
EOF
chmod 0700 "$BIN/machtiani" "$BIN/machtiani-model-host"

SMOKE_CAPTURE=$CAPTURE \
SMOKE_AUTHENTICATED=false \
MACHTIANI_BIN=$BIN/machtiani \
MACHTIANI_MODEL_HOST_BIN=$BIN/machtiani-model-host \
MACHTIANI_SUBSCRIPTION_SMOKE_CONFIRM=yes \
CODEX_HOME=$TEST_ROOT/provider-owned-codex \
  "$PROJECT_ROOT/scripts/subscription-runtime-smoke" openai-codex gpt-test device_code

grep -F 'auth login --profile ' "$CAPTURE/login-args" >/dev/null
grep -F -- '--mode device_code' "$CAPTURE/login-args" >/dev/null
[[ $(grep -c '^verify --json$' "$CAPTURE/machtiani-args") == 2 ]]
grep -F "command = \"$BIN/machtiani-model-host\"" "$CAPTURE/config.toml" >/dev/null
grep -F 'cache_control = { type = "ephemeral" }' "$CAPTURE/config.toml" >/dev/null
grep -F '"runtimeProfile": "'"$TEST_ROOT"'/provider-owned-codex"' "$CAPTURE/profile.json" >/dev/null
if grep -Ei 'access[_-]?token|refresh[_-]?token|oauth[_-]?token|authorization[[:space:]]*[:=]|api[_-]?key[[:space:]]*[:=]' "$CAPTURE/config.toml" "$CAPTURE/profile.json" >/dev/null; then
  echo 'focused subscription IXE copied credential-shaped material' >&2
  exit 1
fi

EXISTING=$TEST_ROOT/existing-installer-state
CLAUDE_CAPTURE=$CAPTURE/claude
mkdir -p "$EXISTING" "$CLAUDE_CAPTURE"
cat >"$EXISTING/model-profile.json" <<EOF
{"version":1,"driver":"anthropic-claude-agent-sdk","provider":"anthropic-claude","authMethod":"subscription","model":"claude-test","runtimeProfile":"$TEST_ROOT/provider-owned-claude"}
EOF
cat >"$EXISTING/config.toml" <<EOF
default_model = "dearmachine"
[providers.dearmachine-host]
transport = "model-host"
profile = "$EXISTING/model-profile.json"
command = "$BIN/machtiani-model-host"
[models.dearmachine]
provider = "dearmachine-host"
model = "claude-test"
EOF
chmod 0600 "$EXISTING/model-profile.json" "$EXISTING/config.toml"
cp "$EXISTING/model-profile.json" "$EXISTING/model-profile.before"
cp "$EXISTING/config.toml" "$EXISTING/config.before"

SMOKE_CAPTURE=$CLAUDE_CAPTURE \
SMOKE_AUTHENTICATED=true \
MACHTIANI_BIN=$BIN/machtiani \
MACHTIANI_MODEL_HOST_BIN=$BIN/machtiani-model-host \
MACHTIANI_SUBSCRIPTION_SMOKE_CONFIRM=yes \
MACHTIANI_MODEL_PROFILE=$EXISTING/model-profile.json \
MACHTIANI_CONFIG=$EXISTING/config.toml \
  "$PROJECT_ROOT/scripts/subscription-runtime-smoke" anthropic-claude claude-test browser

cmp "$EXISTING/model-profile.before" "$EXISTING/model-profile.json"
cmp "$EXISTING/config.before" "$EXISTING/config.toml"
[[ $(grep -c '^verify --json$' "$CLAUDE_CAPTURE/machtiani-args") == 2 ]]
[[ ! -e $CLAUDE_CAPTURE/login-args ]]

printf 'subscription runtime smoke harness passed\n'

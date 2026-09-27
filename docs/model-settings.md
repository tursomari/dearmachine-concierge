# Shared model selection

Concierge `/model` manages Default and optional complete-profile overrides for
Concierge, Machtiani planner, Machiani shell-agent, and Machtiani sync. Changing
Default preserves overrides. Set all replaces Default and removes every override.
Use Default removes a single override. Provider-default reasoning means the field
is absent; a component override never borrows reasoning or credentials from Default.

The private `~/.config/machtiani/model-profile.json` remains a version 1 model-host
profile. Its root provider/model/reasoning and authentication references are Default.
An optional `selectionVersion: 1` extension enables `overrides`, whose allowed keys
are `concierge`, `planner`, `shell-agent`, and `sync`. Each override is a complete
version 1 profile without nested selection metadata. No credentials are embedded.
The existing private-file checks and atomic rename protect persistence.

Legacy profiles remain readable. Before creating a compatibility assistant snapshot,
Concierge imports an existing `~/.config/dearmachine/assistant-model.json` as an
explicit Concierge override. Without that legacy file, Concierge inherits Default.
An assistant-only installation seeds Default from its assistant profile. Migration
is idempotent, retains old credential/runtime references and leaves the legacy
assistant file available; once migrated, the shared profile is authoritative.
Malformed or unknown shared schemas are retained and reported, never silently reset.
A damaged legacy Concierge profile can be explicitly replaced through the picker
without changing Default; cancelling retains the damaged file for repair.

The installer-generated private Machtiani config uses model-host aliases:

| Alias | Model-host selector | Selection |
| --- | --- | --- |
| `dearmachine` | `@machtiani/planner` | planner override, then Default |
| `dearmachine-shell-agent` | `@machtiani/shell-agent` | shell-agent override, then Default |
| `dearmachine-sync` | `@machtiani/sync` | sync override, then Default |

These selectors are internal routing values, never upstream model IDs. Model-host
loads the selected full profile per request and removes the selector before calling
the provider. Generated config contains no copied reasoning setting that could
mask a later profile change. The DSH adapter similarly reloads Concierge's effective
profile per request, keeping its conversation and tool history.

Saving a selection upgrades recognized legacy installer-generated model blocks
before the atomic profile commit. Selectors also work with old version 1 profiles,
so an interruption before the profile write preserves effective legacy behavior.
Unrelated models are retained. Customized roles/providers/parameters and reserved
alias collisions are refused rather than overwritten; retain that configuration
and reconcile its model-host routing before changing shared models. A plain legacy
profile migration does not rewrite customized harness configuration.

Explicit Machtiani CLI aliases still override generated role defaults; model-host
literal model and reasoning arguments retain precedence. Dear Machine selects sync's
alias explicitly with both `--model` and `--answer-model`, because sync consumes the
answer runtime. Its resolver reads the shared sync override/Default and falls back
to the legacy private configuration's answer/default alias. The model-host alias
carries provider, model, reasoning and authentication together, without secrets in
CLI arguments. Existing installations without a private config retain native fallback.

The separate backend section reads configured IDs from Dear Machine's device config,
not executables found on PATH. It never changes backend settings or launches a probe.
Codex, Forge and OMP adapters defer model choice to their own configuration. Claude's
adapter passes a model from its launch environment, which can differ from Concierge's;
the UI explains its actual precedence instead of claiming to know that environment.
Custom backends point to their command definitions. Unknown models remain unknown.
`/model` has no verification, activity or usage dashboard; custom endpoint selection
stores validated settings without a live compatibility probe. Initial installation
retains its existing custom-provider compatibility check.

The extension and generated selectors require the coordinated updated model-host
runtime. This is an upgrade migration, not a downgrade converter for older runtimes.

## OpenAI subscription runtime state

Machtiani's bundled Codex runtime uses `~/.config/machtiani/codex` by default,
separate from the standalone Codex CLI's `~/.codex`. Sign in once for Machtiani;
its installer, concierge, and model components reuse that private profile.
An ambient `CODEX_HOME` does not select the bundled runtime's profile.
`MACHTIANI_CODEX_HOME` may explicitly select another private Machtiani profile.
Do not point it at a standalone CLI profile maintained by a different version.

Existing selections retain their saved runtime path until reconfigured. If an
older selection shared the default standalone profile and startup fails, use
`/model` to reconfigure OpenAI. This selects the private Machtiani profile and
requires a separate sign-in; it does not copy credentials or remove host state.

ChatGPT model discovery uses the bundled Codex app-server's `model/list`, not
the standalone `codex` command on PATH or a hardcoded model list in Concierge.
The provider's catalog can depend on the bundled runtime version as well as
the signed-in account. A fresh catalog can therefore still omit a newly released
model when the bundled runtime is older. Updating standalone Codex does not
update this integration: upgrade the coordinated Dear Machine release that
contains the newer runtime, then reopen `/model`. Do not copy another Codex
profile or edit model-cache files to force a model into the menu.

# Standard installation boundary

Status: launcher-contract foundation. This document does not claim that a
portable release bundle or a verified Nix-free installation already exists.

The intended public entrypoint is a small curl bootstrap followed by
`dearmachine`. Software acquisition and configuration are separate:

- **Standard installation** uses the complete prebuilt release, including the
  native client, Agent Manager, Machtiani, installer/concierge, shared model
  host, and their runtime dependencies. Nix must not be needed on the target.
- **Install with Nix** explicitly chooses Nix-managed acquisition. The agent
  must still obtain permission before installing Nix itself.
- Both paths use the same configuration wizard, provider/model selection,
  private credentials, backend setup, verification, and concierge lifecycle.
  Backend agents remain separately selected prerequisites; acquisition of a
  product bundle is not permission to install every possible backend.

## Launcher contract

A release launcher sets `MACHTIANI_DISTRIBUTION` to an absolute path to a small
`distribution.json` file in the release root. Its version-1 schema is:

```json
{
  "version": 1,
  "sourceRoot": "source",
  "binaries": {
    "dearmachine": "bin/dearmachine",
    "machtiani": "bin/machtiani",
    "modelHost": "bin/machtiani-model-host",
    "agentManager": "bin/agent-manager"
  }
}
```

These paths are relative to that release, not to the current working directory.
Every binary must exist and be executable. Paths and symlinks may not escape
the release. An invalid explicit manifest fails closed; it never triggers a
silent Nix fallback. Without a distribution manifest, existing Nix entrypoints
keep their current route and do not offer unavailable prebuilt products.

When a valid distribution is supplied, the launcher offers Standard by default
and Nix as an explicit alternative. Escape returns to installation consent;
local exit remains available while the menu is pending. The chosen method and
validated product paths are included in the agent's runtime context, separate
from the system prompt and from the shared model profile.

The source snapshot contains the canonical documentation and source at the
release revisions, without Git history, repository administration, or host
state. `bootstrap-source-revisions.json` records the umbrella revision under
the `.` key. The documentation reference can resolve this metadata only when
`.git` is absent; malformed Git metadata cannot be hidden by a release file.

## Remaining acceptance work

1. Package and verify a complete portable Linux x86-64 runtime. Reusing a Nix
   build on the producer is acceptable; requiring Nix or `/nix/store` on the
   target is not. Do not equate a relocated launcher with a relocated runtime.
2. Add the checksum-verified, local-server-testable curl acquisition path with
   safe activation and no overwrite of unrelated installations or credentials.
3. Route interactive stage documentation and headless product acquisition by
   the selected method. Standard must never invoke Nix to install products or
   their required runtime tools. It must use the supplied model-host path.
4. Exercise install-to-concierge and native child processes in a disposable
   container without `/nix`, followed by a human IXE before the live QSE.

No domain deployment or pushing is part of this local implementation work.

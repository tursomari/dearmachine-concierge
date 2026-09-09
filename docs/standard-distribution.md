# Standard installation boundary

Status: Standard launcher and supplied-product configuration routing are
implemented. The paired umbrella owns the portable runtime and checksum-pinned
curl bootstrap. Its no-Nix container gate covers acquisition, product and
provider-runtime entrypoints, child execution, Git LFS, and offline cache reuse.
This is not yet a verified install-to-live-email release; the human IXE and
subsequent live QSE remain required.

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

## Configuration boundary

Standard stage guidance skips Nix acquisition and uses the supplied model-host
and product paths. The headless product adapter does the same, fingerprints the
source snapshot before and after installation, and records the distribution in
its resume journal. A different distribution or installation method cannot
silently resume that journal. Existing Nix checkout entrypoints retain their
previous route.

## Remaining acceptance work

1. Complete Nix selection from a portable snapshot. The current Nix acquisition
   route assumes a Git checkout and the managed Machtiani install requires its
   origin/default-branch metadata. A source-only release cannot satisfy that
   contract. Do not describe the portable bundle's Nix choice as verified or
   silently initialize Git in the snapshot to bypass it.
2. Exercise Standard install-to-concierge and live email in a disposable
   container without `/nix`, through a human IXE before the live QSE. Starting
   the wizard or passing runtime help checks is not installation success.

No domain deployment or pushing is part of this local implementation work.

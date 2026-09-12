# Installer and concierge credential boundary

Secure input is only the entry boundary. Prompt instructions and terminal
redaction do not prevent a tool from reading a saved key into model context or
the private DSH trajectory. Every installer, concierge and task profile therefore
loads the credential policy as a required runtime plugin.

The policy owns private, in-process inspection of the shared model profile's
credential reference, Dear Machine's backend environment store, supported email
credential files, and inherited credential environment variables. It never
returns those values. It refreshes before and after tool execution so a newly
saved key is covered immediately, and retains earlier values for the lifetime
of that session to protect old copies following rotation.

- Direct file tools cannot open known credential files, including symlink and
  hardlink aliases. Ordinary product settings remain available.
- Before tool-result publication, the policy inspects the complete result,
  including structured values, presentation metadata, errors and additional
  context. A match blocks the entire result, not just its displayed text.
  This is before DSH records the result or supplies it to the next model turn.
- A second check rejects credential-bearing model input before provider I/O.
- Missing optional stores are normal; unreadable, malformed or unsafe existing
  stores fail closed with a non-secret error. The local lifecycle controls do
  not need the model and remain available.
- DSH background-job output is disabled because it can enter the session outside
  the synchronous tool-result boundary. Native Dear Machine supervisor ownership
  is separate and unchanged; `/quit` still does not stop the daemon.

The policy recognizes saved values, common encodings, and split output. A
blocked result directs the agent back to the typed secure helper and its
non-secret receipt. It must not retry credential inspection another way.

## Scope and limits

This enforces credential handling at the supported harness tool/model boundary;
it is not an operating-system sandbox for arbitrary programs. Installer commands
still run as the installing user so maintained backend helpers can consume keys
without exposing them to the model. It does not promise protection against
malicious same-user programs, arbitrary re-encoding/exfiltration, unknown
credential stores outside the listed references, or provider/account compromise.
Such isolation needs a separate execution/credential broker, not more prompt text.

This protection is not retroactive. If an older session exposed a key, rotate it
and restrict or remove affected evidence separately. Never copy old trajectories
into a new session as recovery context. The credential-free regression and its
trajectory checks are documented in [TESTING.md](../TESTING.md).

## Explicit credential changes

The existing helper accepts `--use-existing` and `--replace`. With neither,
backend-provider and email requests retain the original behavior: use an
available credential or open masked entry when absent. `--use-existing` fails
without prompting if no credential exists. `--replace` always opens masked
entry; cancellation preserves the saved value. Replacement changes the shared
reference for all its consumers, and the masked prompt explains that effect.

`machtiani-provider <exact-provider-alias> --use-existing` connects an existing
global, direct-HTTP Machtiani provider to the saved environment variable using
`machtiani config provider set --global --api-key-env`. `--replace` saves the
new credential and makes the same connection. The helper checks the provider
before requesting a key, preserves other providers and model choices, and
returns only a non-secret reference. Model-host providers require their own
profile configuration and are rejected before mutation. The absolute helper
invocations are supplied in Concierge's runtime context.

The runtime must load the referenced environment file. A systemd service's
`EnvironmentFile` does not imply that an interactive terminal has the same
variables. A resident supervisor can also retain the old environment after key
rotation; restarting only its child need not reload the file. Configuration success is not authentication verification. These
operations do not modify service configuration, restart a client, or send a
provider request. Verify authentication through the actual component runtime
and use native lifecycle commands when the requested work includes restarting.
If saving succeeds but connecting Machtiani fails, the receipt reports that
partial result; retry with `--use-existing` instead of entering the key again.

`/model` changes the Concierge assistant only. Machtiani's model roles and
backend agents are separate configuration targets.

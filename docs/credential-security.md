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

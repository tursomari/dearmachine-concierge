import { EndpointAbsentError, type DaemonCommand, type DaemonControl, type DaemonStatus } from './concierge-control.ts'

export const conciergeInterruptHint = 'Use /quit to leave. Press Ctrl+C again within 2 seconds to exit the interface only. A committed operation is not undone; inspect dearmachine status.'

export const localHelp = `Local commands (no model or provider required):
/help — Show this help.
/up — Start Dear Machine and confirm it is running; never install or enable persistence.
/down — Stop Dear Machine and cancel pending automatic restarts.
/restart — Restart Dear Machine and confirm it is running.
/status — Inspect current state without changing it.
/quit — Close the interface, leaving the daemon in its current state.
/detach — Release the attached log stream and close the interface, leaving Dear Machine up.
Both exit commands first establish independent ownership if attached; failed handoff keeps this interface open.
To stop Dear Machine before leaving, use /down first.
Ctrl+C cancels interface work; press it again within 2 seconds to exit the interface only.
At an idle prompt, use /quit. Ordinary input or expiry disarms the second press.
A committed lifecycle operation is not undone by cancellation; inspect dearmachine status.

Native fallback CLI commands:
dearmachine --help — Local CLI help.
dearmachine status — Inspect installation, supervisor, daemon, and persistence.
dearmachine up — Start Dear Machine.
dearmachine down — Stop Dear Machine.
dearmachine restart — Restart Dear Machine.
Native command availability depends on the installed CLI version.
If persistence is enabled, login or reboot may start Dear Machine again.
/systemd — Ask about using systemd; /systemd on|off|status records an explicit choice or probes availability.
/persistence — Ask separately about reboot startup including lingering; /persistence on|off|status.
dearmachine systemd on|off|status — Choose service use only; never silently switch a resident owner.
dearmachine persistence on — Explicitly approve reboot startup AND loginctl enable-linger.
dearmachine persistence off — Disable service startup; retain account-wide lingering.
Inspect: systemctl --user status dearmachine-concierge.service; systemctl --user is-enabled dearmachine-concierge.service; loginctl show-user --property=Linger.
Disable account-wide lingering only if other services do not need it: loginctl disable-linger.`

export function formatDaemonStatus(status: DaemonStatus): string {
  return `Installation: ${status.installation}. Supervisor: ${status.supervisor}. Daemon: ${status.daemon}. Persistence: ${status.persistence}.` +
    (status.retryInMs === undefined ? '' : ` Retry in ${status.retryInMs} ms.`) +
    // Exit diagnostics can contain private process output; leave their inspection to the native CLI.
    (status.lastExit === undefined ? '' : ' A last-exit diagnostic is available through dearmachine status.')
}

/** The scriptable command and slash-command paths share this result validation. */
export async function executeDaemonCommand(control: DaemonControl, command: DaemonCommand): Promise<{ code: 0 | 1; message: string }> {
  try {
    let status: DaemonStatus
    try { status = await control.request('status') } catch (error) {
      if (command !== 'up' || !(error instanceof EndpointAbsentError) || !control.bootstrapUp) throw error
      status = await control.bootstrapUp()
    }
    if (command === 'status') {
      return { code: ['failed', 'unreachable'].includes(status.supervisor) || status.daemon === 'unknown' || ['partial', 'unreadable'].includes(status.installation) ? 1 : 0, message: formatDaemonStatus(status) }
    }
    if (status.installation !== 'installed') {
      return { code: 1, message: 'No verified installation is available. Use the installer for an absent installation; inspect existing state with dearmachine status before recovery. No change was requested.' }
    }
    const confirmed = (state: DaemonStatus) => state.installation === 'installed' && (command === 'down'
      ? state.supervisor === 'stopped' && state.daemon === 'stopped'
      : state.supervisor === 'running' && state.daemon === 'running')
    if (command !== 'restart' && confirmed(status)) return { code: 0, message: `Already ${status.daemon}. ${formatDaemonStatus(status)}` }
    status = await control.request(command)
    return confirmed(status)
      ? { code: 0, message: formatDaemonStatus(status) }
      : { code: 1, message: `Operation not confirmed. ${formatDaemonStatus(status)} Run dearmachine status before retrying.` }
  } catch {
    return { code: 1, message: `Supervisor control failed. ${command === 'status' ? 'Daemon state is unknown.' : 'The operation may have completed; do not retry blindly.'} Run dearmachine status and dearmachine --help for recovery.` }
  }
}

export class ConciergeShell {
  private closed = false
  private operations: Promise<void> = Promise.resolve()
  constructor(private readonly ports: {
    control: DaemonControl
    say(message: string): void
    /** Must confirm ownership transfer without stopping or restarting the daemon. */
    ensureIndependent(): Promise<void>
    unsubscribe(): Promise<void>
    close(): Promise<void>
    converse?(text: string): Promise<void>
    chooseSupervision?(kind: 'systemd' | 'persistence', choice: 'on' | 'off' | 'status'): Promise<string>
  }) {}

  async submit(input: string): Promise<void> {
    if (this.closed) return
    const text = input.trim()
    if (text === '') return
    if (text === '/help') { this.ports.say(localHelp); return }
    if (text === '/systemd' || text === '/persistence') {
      this.ports.say(text === '/systemd'
        ? 'Use the systemd user manager for Dear Machine? This configures a service but does not enable reboot persistence. Answer /systemd on or /systemd off; inspect availability with /systemd status.'
        : 'Enable Dear Machine after reboot, including account-wide loginctl enable-linger so the user manager survives logout? This is separate from service use. Answer /persistence on or /persistence off; inspect /persistence status.')
      return
    }
    const consent = /^\/(systemd|persistence) (on|off|status)$/u.exec(text)
    if (consent !== null) {
      const operation = this.operations.then(async () => {
        if (this.closed) return
        try {
          if (!this.ports.chooseSupervision) throw new Error('unavailable')
          this.ports.say(await this.ports.chooseSupervision(consent[1] as 'systemd' | 'persistence', consent[2] as 'on' | 'off' | 'status'))
        } catch { this.ports.say('Supervision choice was not confirmed. Inspect dearmachine systemd status and dearmachine persistence status. No lifecycle change is implied. Use /help.') }
      })
      this.operations = operation.catch(() => {})
      await operation
      return
    }
    if (['/up', '/down', '/restart', '/status', '/quit', '/detach'].includes(text)) {
      const operation = this.operations.then(async () => {
        if (this.closed) return
        if (text === '/up' || text === '/down' || text === '/restart' || text === '/status') {
          const result = await executeDaemonCommand(this.ports.control, text.slice(1) as DaemonCommand)
          this.ports.say(result.message)
          return
        }
        try {
          await this.ports.ensureIndependent()
          await this.ports.unsubscribe()
          await this.ports.close()
          this.closed = true
        } catch {
          this.ports.say('The interface stays open because independent ownership or interface cleanup could not be confirmed. No daemon stop was requested. Use /help or dearmachine status for recovery.')
        }
      })
      this.operations = operation.catch(() => {})
      await operation
      return
    }
    if (text.startsWith('/')) { this.ports.say('Unknown local command or arguments. Use /help.'); return }
    if (this.ports.converse === undefined) {
      this.ports.say('This increment provides local management commands. Use /help; conversational management is not connected yet.')
      return
    }
    try { await this.ports.converse(text) } catch {
      if (!this.closed) this.ports.say('The provider is unavailable. Use /help for local controls and fallback CLI commands.')
    }
  }
}

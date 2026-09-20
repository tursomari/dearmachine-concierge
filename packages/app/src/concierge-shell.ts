import { EndpointAbsentError, type DaemonCommand, type DaemonControl, type DaemonStatus } from './concierge-control.ts'
import type { UpdateRequest } from './concierge-update.ts'

export const conciergeInterruptHint = 'Use /quit to leave. Press Ctrl+C again within 2 seconds to exit the interface only. A committed operation is not undone; inspect dearmachine status.'

export const conciergeWelcome = 'Tell me what you need in plain language—for example, “What inbox is configured?”, “Check Dear Machine”, or “Stop Dear Machine”.\n\nUse /quit to leave this conversation; it does not stop Dear Machine. Use /help for local controls.'
export const backgroundExitHint = 'Dear Machine is running in the background under its supervisor. You can use /quit to leave this conversation and keep it running. Reboot startup is a separate persistence setting.'

const linuxHelp = [
  '## Local concierge commands',
  '',
  'These commands work without a model or provider.',
  '',
  '`/help` — Show this help.',
  '`/model` — Choose the assistant provider, model, and reasoning level.',
  '`/update` — Check for an update and ask before installing it.',
  '`/uninstall` — Show the terminal command for confirmed permanent removal.',
  '`/status` — Inspect Dear Machine without changing it.',
  '`/up` — Start Dear Machine and confirm it is running; never install or enable persistence.',
  '`/down` — Stop Dear Machine and cancel pending automatic restarts.',
  '`/restart` — Restart Dear Machine and confirm it is running.',
  '`/quit` — Close the concierge without changing Dear Machine’s state.',
  '`/detach` — Close an attached interface while leaving Dear Machine running.',
  '',
  'To stop Dear Machine before leaving, use `/down` first.',
  '`/quit` and `/detach` are equivalent when Dear Machine is already independently supervised.',
  'Ctrl+C cancels current interface work. Press it again within 2 seconds to exit.',
  'Cancellation does not undo a committed lifecycle operation; inspect `/status` afterward.',
  '',
  '## Service and persistence choices',
  '',
  '`/systemd` — Explain systemd service ownership.',
  '`/systemd on|off|status` — Choose service use or inspect its availability.',
  '`/persistence` — Explain managed startup after logout or reboot.',
  '`/persistence on|off|status` — Choose or inspect managed startup.',
  '',
  'Service use and reboot persistence are separate choices.',
  'Enabling persistence also explicitly enables account-wide user lingering.',
  '',
  '## Native fallback CLI commands',
  '',
  '`dearmachine --help` — Show local CLI help.',
  '`dearmachine status` — Inspect runtime, recovery, and managed startup.',
  '`dearmachine up` — Start Dear Machine.',
  '`dearmachine down` — Stop Dear Machine.',
  '`dearmachine restart` — Restart Dear Machine.',
  '`dearmachine systemd on|off|status` — Choose or inspect native service use.',
  '`dearmachine persistence on` — Enable managed startup and user lingering.',
  '`dearmachine persistence off` — Disable managed startup but retain lingering.',
  '',
  'Native command availability depends on the installed CLI version.',
  '',
  '## Manual systemd inspection and recovery',
  '',
  '`systemctl --user status \\`',
  '  `dearmachine-concierge.service` — Inspect service runtime status.',
  '`systemctl --user is-enabled \\`',
  '  `dearmachine-concierge.service` — Inspect whether login startup is enabled.',
  '`loginctl show-user --property=Linger` — Inspect account-wide lingering.',
  '`loginctl disable-linger` — Disable lingering only if no other service needs it.',
].join('\n')

export function localHelpForPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return linuxHelp.slice(0, linuxHelp.indexOf('## Service and persistence choices')) + [
    '## Startup after sign-in', '',
    '`/persistence` — Explain automatic startup after signing in.',
    '`/persistence on|off|status` — Choose or inspect startup after signing in.', '',
    'Dear Machine can start when you sign in, including after a reboot. It does not run before sign-in.',
    'Disabling startup preserves the currently running client. Use `/down` to stop it.', '',
    '## Native fallback CLI commands', '',
    '`dearmachine up`, `dearmachine down`, `dearmachine restart`, `dearmachine status` — Manage the client.',
    '`dearmachine persistence on|off|status` — Choose or inspect startup after sign-in.',
  ].join('\n')
  if (platform !== 'darwin') return linuxHelp
  return linuxHelp.slice(0, linuxHelp.indexOf('## Service and persistence choices')) + [
    '## Service and persistence choices', '',
    '`/launchd` — Explain macOS service management.',
    '`/launchd on|off|status` — Choose service use or inspect its availability.',
    '`/persistence` — Explain automatic startup at login.',
    '`/persistence on|off|status` — Choose or inspect startup at login.', '',
    'Service use and startup at login are separate choices.',
    'Startup at login includes the next login after a reboot. It does not run before login or after logout.', '',
    '## Native fallback CLI commands', '',
    '`dearmachine --help` — Show native CLI help.',
    '`dearmachine up`, `dearmachine down`, `dearmachine restart`, `dearmachine status` — Manage the client.',
    '`dearmachine launchd on|off|status` — Choose or inspect macOS service use.',
    '`dearmachine persistence on|off|status` — Choose or inspect startup at login.', '',
    'To switch service ownership, stop the client with `/down` first. Enabling service use does not start it.',
    'Disabling startup at login preserves the currently running client. Disable persistence before disabling service use.',
  ].join('\n')
}
export const localHelp = localHelpForPlatform()

export function formatDaemonStatus(status: DaemonStatus): string {
  const recovery = {
    running: 'active — retries if Dear Machine exits unexpectedly',
    starting: 'active — waiting for startup readiness',
    'backing-off': 'active — waiting to retry',
    stopping: 'inactive — stop in progress',
    stopped: 'inactive until started again',
    failed: 'paused — consecutive-failure limit reached',
    unreachable: 'not verified — no responding native supervisor',
  }[status.supervisor]
  const chat = status.supervisor === 'running' && status.daemon === 'running'
    ? 'leaves Dear Machine running'
    : status.supervisor === 'stopped' ? 'leaves Dear Machine stopped'
      : 'cannot verify — inspect dearmachine status'
  // The legacy socket persistence flag cannot distinguish observed startup
  // configuration from saved permission. Never use it to infer these fields.
  return `Installation: ${status.installation}\nDear Machine: ${status.daemon}\nSupervisor: ${status.supervisor}\nCrash recovery: ${recovery}\n` +
    `Closing this chat: ${chat}\nAfter account logout: not verified — session/service lifetime not assessed\n` +
    'Managed startup at login: cannot verify\nManaged startup after reboot (before login): cannot verify\n' +
    'Reason: detailed native status unavailable; run dearmachine status\n' +
    (status.retryInMs === undefined ? '' : `Next retry: ${Math.ceil(status.retryInMs / 1000)} seconds.\n`) +
    // Exit diagnostics can contain private process output; leave their inspection to the native CLI.
    (status.lastExit === undefined ? '' : ' A last-exit diagnostic is available through dearmachine status.')
}

export async function readDaemonStatusReport(control: DaemonControl, status: DaemonStatus): Promise<string> {
  try {
    if (control.readStatusReport) return `Installation: ${status.installation}\n${await control.readStatusReport()}`
  } catch { /* Missing/older native CLI must not disable local management. */ }
  return formatDaemonStatus(status)
}

/** The scriptable command and slash-command paths share this result validation. */
export async function executeDaemonCommand(control: DaemonControl, command: DaemonCommand, progress?: (text: string) => void): Promise<{ code: 0 | 1; message: string }> {
  try {
    let status: DaemonStatus
    let bootstrapped = false
    try { status = await control.request('status') } catch (error) {
      if (command !== 'up' || !(error instanceof EndpointAbsentError) || !control.bootstrapUp) throw error
      status = await control.bootstrapUp(progress)
      bootstrapped = true
    }
    if (command === 'status') {
      return { code: ['failed', 'unreachable'].includes(status.supervisor) || status.daemon === 'unknown' || ['partial', 'unreadable'].includes(status.installation) ? 1 : 0, message: await readDaemonStatusReport(control, status) }
    }
    if (status.installation !== 'installed') {
      return { code: 1, message: 'No verified installation is available. Use the installer for an absent installation; inspect existing state with dearmachine status before recovery. No change was requested.' }
    }
    const confirmed = (state: DaemonStatus) => state.installation === 'installed' && (command === 'down'
      ? state.supervisor === 'stopped' && state.daemon === 'stopped'
      : state.supervisor === 'running' && state.daemon === 'running')
    if (command !== 'restart' && confirmed(status)) return { code: 0, message: `${bootstrapped ? '' : `Already ${status.daemon}. `}${await readDaemonStatusReport(control, status)}` }
    if (bootstrapped) return { code: 1, message: `Operation not confirmed. ${formatDaemonStatus(status)} Run dearmachine status before retrying.` }
    try { status = await control.request(command) } catch (error) {
      // Native inspection can confirm a stopped installation even when its
      // socket is absent. Only an explicit up may bootstrap that owner.
      if (command !== 'up' || !(error instanceof EndpointAbsentError) || !control.bootstrapUp) throw error
      status = await control.bootstrapUp(progress)
    }
    return confirmed(status)
      ? { code: 0, message: await readDaemonStatusReport(control, status) }
      : { code: 1, message: `Operation not confirmed. ${formatDaemonStatus(status)} Run dearmachine status before retrying.` }
  } catch {
    return { code: 1, message: `Supervisor control failed. ${command === 'status' ? 'Daemon state is unknown.' : 'The operation may have completed; do not retry blindly.'} Run dearmachine status and dearmachine --help for recovery.` }
  }
}

export class ConciergeShell {
  private closed = false
  private operations: Promise<void> = Promise.resolve()
  private changingModel = false
  private updatePending = false
  constructor(private readonly ports: {
    control: DaemonControl
    say(message: string): void
    /** Must confirm ownership transfer without stopping or restarting the daemon. */
    ensureIndependent(): Promise<void>
    unsubscribe(): Promise<void>
    close(): Promise<void>
    converse?(text: string): Promise<void>
    changeModel?(): Promise<void>
    update?(request: UpdateRequest): Promise<void>
    platform?: NodeJS.Platform
    chooseSupervision?(kind: 'systemd' | 'launchd' | 'persistence', choice: 'on' | 'off' | 'status'): Promise<string>
  }) {}

  async requestUpdate(request: UpdateRequest): Promise<void> {
    if (this.closed) return
    if (this.updatePending) {
      this.ports.say('An update check or installation is already in progress. The existing request will provide the authoritative result.')
      return
    }
    if (!this.ports.update) {
      this.ports.say('Managed updates are unavailable in this interface. Use the absolute installed dearmachine update --check command.')
      return
    }
    this.updatePending = true
    const operation = this.operations.then(async () => {
      if (this.closed) return
      await this.ports.update!(request)
    }).finally(() => { this.updatePending = false })
    this.operations = operation.catch(() => {})
    try { await operation } catch {
      if (!this.closed) this.ports.say('The update flow could not complete. You can keep using this concierge; inspect dearmachine update --check before retrying.')
    }
  }

  async submit(input: string): Promise<void> {
    if (this.closed) return
    const text = input.trim()
    if (text === '') return
    if (text === '/help') { this.ports.say(localHelpForPlatform(this.ports.platform)); return }
    if (text === '/uninstall') {
      this.ports.say('To permanently remove DearMachine, run `dearmachine uninstall` in another terminal. That command shows the deletion paths and requires explicit confirmation. It stops DearMachine and closes its concierge sessions, then deletes owned binaries, configuration, credentials, databases, memory, logs and caches. Independent backends, personal Machtiani data, external projects and remote accounts are preserved. Nothing has been changed by /uninstall.')
      return
    }
    if (text === '/model') {
      if (this.changingModel) { this.ports.say('The model picker is already open. Press Escape to go back or cancel.'); return }
      if (!this.ports.changeModel) { this.ports.say('Model selection is unavailable in this interface.'); return }
      this.changingModel = true
      try { await this.ports.changeModel() }
      catch { if (!this.closed) this.ports.say('The model change did not complete. Use /model to try again.'); }
      finally { this.changingModel = false }
      return
    }
    if (text === '/update') { await this.requestUpdate('install'); return }
    const windows = (this.ports.platform ?? process.platform) === 'win32'
    const mac = (this.ports.platform ?? process.platform) === 'darwin'
    const service = mac ? 'launchd' : 'systemd'
    if (text === '/systemd' || text.startsWith('/systemd ') || text === '/launchd' || text.startsWith('/launchd ')) {
      if (windows) { this.ports.say('Use /persistence on|off|status to manage startup after Windows sign-in.'); return }
      if (!text.startsWith(`/${service}`)) {
        this.ports.say(`Use /${service} on this operating system. No service change was requested.`)
        return
      }
    }
    if (text === `/${service}` || text === '/persistence') {
      if (windows) { this.ports.say('Start Dear Machine automatically when you sign in, including after a reboot? It will not run before sign-in. Answer /persistence on or /persistence off; inspect /persistence status.'); return }
      this.ports.say(mac
        ? (text === '/launchd'
          ? 'Use macOS service management for Dear Machine? This does not enable startup at login. Stop the client with /down before switching. Answer /launchd on or /launchd off; inspect /launchd status.'
          : 'Start Dear Machine automatically when you log in, including after a reboot? It will stop at logout and will not run before login. Answer /persistence on or /persistence off; inspect /persistence status.')
        : (text === '/systemd'
          ? 'Use the systemd user manager for Dear Machine? This configures a service but does not enable reboot persistence. Answer /systemd on or /systemd off; inspect availability with /systemd status.'
          : 'Enable Dear Machine after reboot, including account-wide loginctl enable-linger so the user manager survives logout? This is separate from service use. Answer /persistence on or /persistence off; inspect /persistence status.'))
      return
    }
    const consent = /^\/(systemd|launchd|persistence) (on|off|status)$/u.exec(text)
    if (consent !== null) {
      const operation = this.operations.then(async () => {
        if (this.closed) return
        try {
          if (!this.ports.chooseSupervision) throw new Error('unavailable')
          this.ports.say(await this.ports.chooseSupervision(consent[1] as 'systemd' | 'launchd' | 'persistence', consent[2] as 'on' | 'off' | 'status'))
        } catch { this.ports.say(`Supervision choice was not confirmed. Inspect dearmachine ${service} status and dearmachine persistence status. No lifecycle change is implied. Use /help.`) }
      })
      this.operations = operation.catch(() => {})
      await operation
      return
    }
    if (['/up', '/down', '/restart', '/status', '/quit', '/detach'].includes(text)) {
      const operation = this.operations.then(async () => {
        if (this.closed) return
        if (text === '/up' || text === '/down' || text === '/restart' || text === '/status') {
          const result = await executeDaemonCommand(this.ports.control, text.slice(1) as DaemonCommand, this.ports.say)
          this.ports.say(result.message)
          if (result.code === 0 && (text === '/up' || text === '/restart')) this.ports.say(backgroundExitHint)
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
    if (this.changingModel) { this.ports.say('Finish or cancel the model picker before continuing the conversation.'); return }
    if (this.ports.converse === undefined) {
      this.ports.say('This increment provides local management commands. Use /help; conversational management is not connected yet.')
      return
    }
    try { await this.ports.converse(text) } catch {
      if (!this.closed) this.ports.say('The provider is unavailable. Use /help for local controls and fallback CLI commands.')
    }
  }
}

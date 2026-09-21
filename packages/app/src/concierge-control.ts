import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { isAbsolute, join } from 'node:path'

export type DaemonCommand = 'status' | 'up' | 'down' | 'restart'
export type InstallationState = 'absent' | 'installed' | 'partial' | 'unreadable'
export interface DaemonStatus {
  installation: InstallationState
  supervisor: 'starting' | 'running' | 'backing-off' | 'stopping' | 'stopped' | 'failed' | 'unreachable'
  daemon: 'running' | 'stopped' | 'unknown'
  persistence: 'enabled' | 'disabled' | 'unknown'
  retryInMs?: number
  lastExit?: string
}
export interface DaemonControl {
  /** Mutations return confirmed observations, never just an acknowledgement. */
  request(command: DaemonCommand): Promise<DaemonStatus>
  bootstrapUp?(progress?: (text: string) => void): Promise<DaemonStatus>
  /** Read-only native presentation; never substitutes for lifecycle confirmation. */
  readStatusReport?(): Promise<string>
}

function isStatus(value: unknown): value is DaemonStatus {
  if (value === null || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return typeof state.installation === 'string' && typeof state.supervisor === 'string' &&
    typeof state.daemon === 'string' && typeof state.persistence === 'string' &&
    ['absent', 'installed', 'partial', 'unreadable'].includes(String(state.installation)) &&
    ['starting', 'running', 'backing-off', 'stopping', 'stopped', 'failed', 'unreachable'].includes(String(state.supervisor)) &&
    ['running', 'stopped', 'unknown'].includes(String(state.daemon)) &&
    ['enabled', 'disabled', 'unknown'].includes(String(state.persistence)) &&
    (state.retryInMs === undefined || (typeof state.retryInMs === 'number' && Number.isSafeInteger(state.retryInMs) && state.retryInMs >= 0)) &&
    (state.lastExit === undefined || typeof state.lastExit === 'string')
}

/** Native Linux contract: HOME is required; never fall back to XDG or passwd. */
export function resolveSupervisorSocket(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.DEARMACHINE_SUPERVISOR_SOCKET
  if (override) {
    if (!isAbsolute(override)) throw new Error('The supervisor control socket path must be absolute.')
    return override
  }
  const home = process.platform === 'win32' ? environment.USERPROFILE : environment.HOME
  if (!home || !isAbsolute(home)) throw new Error('An absolute HOME is required to locate the concierge control endpoint.')
  if (process.platform === 'win32') {
    const hash = createHash('sha256').update(join(home, '.dearmachine').toLowerCase()).digest('hex').slice(0, 32)
    return `\\\\.\\pipe\\dearmachine-${hash}`
  }
  return join(home, '.dearmachine', 'run', 'supervisor.sock')
}

/** Only the current account's default endpoint may use native CLI fallbacks. */
function usesNativeSupervisor(environment: NodeJS.ProcessEnv): boolean {
  const home = process.platform === 'win32' ? environment.USERPROFILE : environment.HOME
  if (!home || !isAbsolute(home)) return false
  return resolveSupervisorSocket(environment) === resolveSupervisorSocket({ ...environment, DEARMACHINE_SUPERVISOR_SOCKET: undefined })
}

export class EndpointAbsentError extends Error {
  constructor() { super('Supervisor endpoint absent. Run dearmachine status for recovery.') }
}

/** Socket-only control: never launches a process or retries a mutation. */
export class SocketDaemonControl implements DaemonControl {
  constructor(private readonly socketPath: string = resolveSupervisorSocket(), private readonly timeoutMs = 5_000) {
    if (!isAbsolute(socketPath)) throw new Error('The supervisor control socket path must be absolute.')
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The control timeout must be positive.')
  }

  request(command: DaemonCommand): Promise<DaemonStatus> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      let response = Buffer.alloc(0)
      let settled = false
      const finish = (status?: DaemonStatus, absent = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (status !== undefined) resolve(status)
        else if (absent) reject(new EndpointAbsentError())
        else reject(new Error(`Supervisor control unavailable or returned an invalid response. ${command === 'status' ? '' : 'The operation may have completed; do not retry blindly. '}Run dearmachine status and dearmachine --help for recovery.`))
      }
      // A total deadline, rather than an idle timeout, also bounds trickled responses.
      const timer = setTimeout(() => finish(), this.timeoutMs)
      socket.once('connect', () => socket.write(JSON.stringify({ version: 1, command }) + '\n'))
      socket.on('data', chunk => {
        response = Buffer.concat([response, chunk])
        if (response.length > 65_536) { finish(); return }
        const newline = response.indexOf(10)
        if (newline === -1) return
        try {
          const reply = JSON.parse(response.subarray(0, newline).toString('utf8')) as Record<string, unknown>
          finish(reply.version === 1 && reply.ok === true && isStatus(reply.status) ? reply.status : undefined)
        } catch { finish() }
      })
      socket.once('error', (error: NodeJS.ErrnoException) => finish(undefined, error.code === 'ENOENT' || error.code === 'ECONNREFUSED'))
      socket.once('end', () => finish())
      socket.once('close', () => finish())
    })
  }
}

/** Policy only. Capability means a usable user manager, not a systemctl executable. */
export function selectSupervision(options: {
  usableUserManager: boolean
  consent: { useSystemd: boolean; enablePersistence: boolean }
}): { owner: 'supervisor-lite' | 'systemd'; enablePersistence: boolean } {
  const systemd = options.usableUserManager && options.consent.useSystemd
  return { owner: systemd ? 'systemd' : 'supervisor-lite', enablePersistence: systemd && options.consent.enablePersistence }
}

/** Only an explicit up may cross this bootstrap boundary. Go owns all processes. */
export class BootstrapDaemonControl implements DaemonControl {
  private starting: Promise<DaemonStatus> | undefined
  readonly readStatusReport?: () => Promise<string>
  constructor(private readonly socket: DaemonControl, private readonly bootstrap: () => Promise<void>,
    private readonly timeoutMs = 20_000, private readonly progress: (text: string) => void = () => {},
    readStatusReport?: () => Promise<string>, private readonly inspectStatus?: () => Promise<DaemonStatus>) {
    if (readStatusReport !== undefined) this.readStatusReport = readStatusReport
  }
  request(command: DaemonCommand): Promise<DaemonStatus> {
    if (command === 'status' && this.inspectStatus !== undefined) return this.inspectStatus()
    return this.socket.request(command)
  }
  bootstrapUp(progress?: (text: string) => void): Promise<DaemonStatus> {
    if (this.starting !== undefined) return this.starting
    ;(progress ?? this.progress)('Bootstrapping the native supervisor. Daemon startup is not yet confirmed; use /status to inspect progress.')
    this.starting = this.waitForBootstrap().finally(() => { this.starting = undefined })
    return this.starting
  }
  private async waitForBootstrap(): Promise<DaemonStatus> {
    // A failing starter may have lost the singleton race; socket observations win.
    void this.bootstrap().catch(() => {})
    const deadline = Date.now() + this.timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<DaemonStatus> => {
      while (Date.now() < deadline) {
        try {
          const state = await this.socket.request('status')
          if (!['starting', 'unreachable'].includes(state.supervisor)) return state
        } catch (error) { if (!(error instanceof EndpointAbsentError)) throw error }
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
      }
      throw new Error('Bootstrap timed out; inspect dearmachine status.')
    }
    try {
      return await Promise.race([poll(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Bootstrap timed out; inspect dearmachine status.')), this.timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
}

export function nativeBootstrap(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!usesNativeSupervisor(environment)) {
    return Promise.reject(new Error('Bootstrap requires the native HOME socket. Start a custom owner explicitly.'))
  }
  const binary = environment.DEARMACHINE_NATIVE_BIN || 'dearmachine'
  if (!isAbsolute(binary) && (binary.includes('/') || binary.includes('\\'))) return Promise.reject(new Error('Invalid native executable.'))
  return new Promise((resolve, reject) => {
    execFile(binary, ['up', '--bootstrap'], { env: environment, timeout: 20_000, maxBuffer: 65_536, windowsHide: true },
      error => { if (error) reject(new Error('Native bootstrap failed; inspect dearmachine status.')); else resolve() })
  })
}

export function defaultConciergeControl(environment: NodeJS.ProcessEnv = process.env, progress?: (text: string) => void): DaemonControl {
  const native = environment.DEARMACHINE_NATIVE_BIN
  const canInspectNative = native && isAbsolute(native) && usesNativeSupervisor(environment)
  return new BootstrapDaemonControl(new SocketDaemonControl(resolveSupervisorSocket(environment)), () => nativeBootstrap(environment), 20_000, progress,
    () => nativeStatusReport(environment), canInspectNative ? () => nativeStatus(environment) : undefined)
}

/** Read installation and runtime independently, including when no supervisor is running. */
export function nativeStatus(environment: NodeJS.ProcessEnv = process.env): Promise<DaemonStatus> {
  const binary = environment.DEARMACHINE_NATIVE_BIN
  if (!binary || !isAbsolute(binary) || !usesNativeSupervisor(environment)) {
    return Promise.reject(new Error('Native status requires an explicit native executable and HOME socket.'))
  }
  return new Promise((resolve, reject) => {
    // Allow the native command's five-second socket observation to finish.
    execFile(binary, ['status', '--json'], { env: environment, timeout: 7_000, maxBuffer: 65_536, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          try {
            const reply = JSON.parse(stdout) as Record<string, unknown>
            if (reply.version === 1 && reply.ok === true && isStatus(reply.status)) { resolve(reply.status); return }
          } catch { /* Fail closed without exposing subprocess output. */ }
        }
        reject(new Error('Native installation and runtime status unavailable.'))
      })
  })
}

/** Keep native lifecycle wording, but exclude pairs and potentially private exit diagnostics. */
export function summarizeNativeStatusReport(output: string): string {
  const labels = ['Dear Machine:', 'Supervisor:', 'Crash recovery:', 'Next retry:', 'Closing this chat:',
    'After account logout:', 'Managed startup at login:', 'Managed startup after reboot (before login):',
    'Reason:', 'Scope:']
  const fields = new Map<string, string>()
  for (const line of output.split('\n')) {
    const text = line.trim()
    const label = labels.find(prefix => text.startsWith(prefix))
    if (label === undefined) continue
    if (fields.has(label) || text.length === label.length || /[\x00-\x1f\x7f]/u.test(text)) {
      throw new Error('Invalid native lifecycle report.')
    }
    if (label === 'Next retry:' && !/^Next retry: \d+ seconds$/u.test(text)) throw new Error('Invalid native retry interval.')
    fields.set(label, text)
  }
  if (labels.some(label => label !== 'Next retry:' && !fields.has(label))) throw new Error('Native lifecycle report unavailable.')
  return labels.filter(label => fields.has(label)).map(label => fields.get(label)!).join('\n')
}

export function nativeStatusReport(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  // Require the launcher's explicit native binary: a PATH lookup could recurse
  // into the installer compatibility CLI instead of reaching the Go command.
  const binary = environment.DEARMACHINE_NATIVE_BIN
  if (!binary || !isAbsolute(binary)) return Promise.reject(new Error('Native status executable unavailable.'))
  if (!usesNativeSupervisor(environment)) {
    return Promise.reject(new Error('Native status requires the native HOME socket.'))
  }
  return new Promise((resolve, reject) => {
    execFile(binary, ['status'], { env: environment, timeout: 5_000, maxBuffer: 65_536, windowsHide: true },
      (error, stdout) => {
        if (error) { reject(new Error('Native lifecycle report unavailable.')); return }
        try { resolve(summarizeNativeStatusReport(stdout)) } catch { reject(new Error('Native lifecycle report unavailable.')) }
      })
  })
}

/** Explicit choices use the native consent store and runtime probes. No provider. */
export function nativeSupervisionChoice(kind: 'systemd' | 'launchd' | 'persistence', choice: 'on' | 'off' | 'status', environment = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(environment.DEARMACHINE_NATIVE_BIN || 'dearmachine', [kind, choice], { env: environment, timeout: 30_000, maxBuffer: 65_536 },
      (error, stdout) => { if (error) reject(new Error('Native supervision choice unconfirmed.')); else resolve(stdout.trim()) })
  })
}

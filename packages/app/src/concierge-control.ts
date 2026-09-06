import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'

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

/** Client half of the proposed supervisor-lite v1 contract. No native process is launched here. */
export class SocketDaemonControl implements DaemonControl {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 5_000) {
    if (!isAbsolute(socketPath)) throw new Error('The supervisor control socket path must be absolute.')
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The control timeout must be positive.')
  }

  request(command: DaemonCommand): Promise<DaemonStatus> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      let response = Buffer.alloc(0)
      let settled = false
      const finish = (status?: DaemonStatus) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (status !== undefined) resolve(status)
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
      socket.once('error', () => finish())
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

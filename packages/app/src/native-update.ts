import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

const revisionPattern = /^[a-f0-9]{40}$/u

export type UpdateCheckResult =
  | { state: 'current' | 'available'; current: string; available: string }
  | { state: 'unsupported' }
  | { state: 'failed' }

export type UpdateInstallResult =
  | { state: 'installed'; release: string }
  | { state: 'unsupported' }
  | { state: 'failed' }

interface NativeUpdateReply {
  version?: unknown
  operation?: unknown
  state?: unknown
  current?: unknown
  available?: unknown
  release?: unknown
}

function reply(stdout: string): NativeUpdateReply | undefined {
  if (Buffer.byteLength(stdout) > 65_536 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(stdout)) return undefined
  try {
    const value = JSON.parse(stdout) as NativeUpdateReply
    return typeof value === 'object' && value !== null && !Array.isArray(value) && value.version === 1 ? value : undefined
  } catch { return undefined }
}

function environmentReady(environment: NodeJS.ProcessEnv): environment is NodeJS.ProcessEnv & { HOME: string; DEARMACHINE_NATIVE_BIN: string } {
  return Boolean(environment.HOME && isAbsolute(environment.HOME) && environment.DEARMACHINE_NATIVE_BIN && isAbsolute(environment.DEARMACHINE_NATIVE_BIN))
}

/** The native launcher is the sole authority for update-channel selection. */
export class NativeUpdateControl {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  check(): Promise<UpdateCheckResult> {
    if (!environmentReady(this.environment)) return Promise.resolve({ state: 'failed' })
    const binary = this.environment.DEARMACHINE_NATIVE_BIN
    return new Promise(resolve => {
      execFile(binary, ['update', '--check', '--json'], {
        env: this.environment, timeout: 30_000, maxBuffer: 65_536, windowsHide: true, encoding: 'utf8',
      }, (_error, stdout) => {
        const value = reply(stdout)
        if (value?.operation === 'check' && value.state === 'unsupported') { resolve({ state: 'unsupported' }); return }
        if (value?.operation === 'check' && (value.state === 'current' || value.state === 'available') &&
          typeof value.current === 'string' && revisionPattern.test(value.current) &&
          typeof value.available === 'string' && revisionPattern.test(value.available)) {
          resolve({ state: value.state, current: value.current, available: value.available }); return
        }
        resolve({ state: 'failed' })
      })
    })
  }

  install(): Promise<UpdateInstallResult> {
    if (!environmentReady(this.environment)) return Promise.resolve({ state: 'failed' })
    const binary = this.environment.DEARMACHINE_NATIVE_BIN
    // Once activation starts, imposing a short process timeout could interrupt
    // rollback. The managed transaction owns completion and recovery.
    return new Promise(resolve => {
      execFile(binary, ['update', '--json'], {
        env: this.environment, maxBuffer: 65_536, windowsHide: true, encoding: 'utf8',
      }, (_error, stdout) => {
        const value = reply(stdout)
        if (value?.operation === 'install' && value.state === 'unsupported') { resolve({ state: 'unsupported' }); return }
        if (value?.operation === 'install' && value.state === 'installed' &&
          typeof value.release === 'string' && revisionPattern.test(value.release)) {
          resolve({ state: 'installed', release: value.release }); return
        }
        resolve({ state: 'failed' })
      })
    })
  }
}

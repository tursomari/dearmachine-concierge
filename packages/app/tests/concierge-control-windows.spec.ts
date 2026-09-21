import { execFile, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultConciergeControl, nativeBootstrap, nativeStatus, nativeStatusReport, resolveSupervisorSocket } from '../src/concierge-control.ts'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
beforeEach(() => { vi.resetAllMocks() })
const stopped = { installation: 'installed', supervisor: 'stopped', daemon: 'stopped', persistence: 'disabled' }
const report = `Dear Machine: stopped
Supervisor: stopped
Crash recovery: inactive until started again
Closing this chat: leaves Dear Machine stopped
After account logout: not verified — session/service lifetime not assessed
Managed startup at login: not configured
Managed startup after reboot (before login): not configured
Reason: Windows startup requires signing in
Scope: Dear Machine's managed service
`
function respond(output: string) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
    done(null, output, '')
    return {} as ChildProcess
  })
}

describe.runIf(process.platform === 'win32')('Windows native concierge endpoint', () => {
  const env = { USERPROFILE: join(tmpdir(), 'concierge user Ω'), HOME: '/unrelated/unix-home', DEARMACHINE_NATIVE_BIN: process.execPath }
  it.each([false, true])('observes native status through the default named pipe (explicit override=%s)', async explicit => {
    const endpoint = resolveSupervisorSocket(env)
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\dearmachine-[a-f0-9]{32}$/u)
    const environment = explicit ? { ...env, DEARMACHINE_SUPERVISOR_SOCKET: endpoint } : env
    respond(JSON.stringify({ version: 1, ok: true, status: stopped }))
    expect(await defaultConciergeControl(environment).request('status')).toEqual(stopped)
    expect(execFile).toHaveBeenCalledWith(env.DEARMACHINE_NATIVE_BIN, ['status', '--json'], expect.objectContaining({ env: environment }), expect.any(Function))
  })
  it('retains native Windows startup observations in the welcome and status report', async () => {
    respond(report)
    expect(await nativeStatusReport(env)).toContain('Managed startup at login: not configured')
    expect(execFile).toHaveBeenCalledWith(env.DEARMACHINE_NATIVE_BIN, ['status'], expect.any(Object), expect.any(Function))
  })
  it('allows an explicit native bootstrap for the default Windows owner', async () => {
    respond('')
    await nativeBootstrap(env)
    expect(execFile).toHaveBeenCalledExactlyOnceWith(env.DEARMACHINE_NATIVE_BIN, ['up', '--bootstrap'], expect.objectContaining({ env }), expect.any(Function))
  })
  it('refuses native fallbacks for a different named-pipe owner or missing USERPROFILE', async () => {
    for (const environment of [
      { ...env, DEARMACHINE_SUPERVISOR_SOCKET: '\\\\.\\pipe\\unrelated-concierge-test-owner' },
      { HOME: env.HOME, DEARMACHINE_NATIVE_BIN: env.DEARMACHINE_NATIVE_BIN },
    ]) {
      await expect(nativeStatus(environment)).rejects.toThrow()
      await expect(nativeStatusReport(environment)).rejects.toThrow()
      await expect(nativeBootstrap(environment)).rejects.toThrow()
    }
    expect(execFile).not.toHaveBeenCalled()
  })
})

import { execFile, type ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultConciergeControl, nativeStatus, nativeStatusReport, summarizeNativeStatusReport, type DaemonStatus } from '../src/concierge-control.ts'
import { ConciergeShell, executeDaemonCommand, formatDaemonStatus, readDaemonStatusReport } from '../src/concierge-shell.ts'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
const running: DaemonStatus = { installation: 'installed', daemon: 'running', supervisor: 'running', persistence: 'unknown' }
const report = `Dear Machine: running
Supervisor: running
Crash recovery: active — retries if Dear Machine exits unexpectedly

Closing this chat: leaves Dear Machine running
After account logout: not verified — session/service lifetime not assessed
Managed startup at login: cannot verify
Managed startup after reboot (before login): cannot verify
  Reason: systemd user manager unavailable
  Scope: Dear Machine's managed service; other startup mechanisms not inspected
`
beforeEach(() => { vi.resetAllMocks() })

describe('native lifecycle presentation', () => {
  it('preserves lifecycle wording and scope without exposing pair or exit diagnostics', () => {
    const result = summarizeNativeStatusReport(report + '\nLast exit: private diagnostic\nInbox: private@example.test\nAuthorized sender: sender@example.test\n')
    for (const field of report.split('\n').map(line => line.trim()).filter(Boolean)) expect(result).toContain(field)
    expect(result).not.toContain('private')
    expect(result).not.toContain('sender@example.test')
  })
  it('preserves independent login and reboot observations when a service is available', () => {
    const serviceReport = report.replace('at login: cannot verify', 'at login: enabled')
      .replace('(before login): cannot verify', '(before login): disabled')
      .replace('systemd user manager unavailable', 'service enabled; user lingering disabled')
    const result = summarizeNativeStatusReport(serviceReport)
    expect(result).toContain('at login: enabled')
    expect(result).toContain('(before login): disabled')
    expect(result).toContain('After account logout: not verified')
  })
  it('retains the native retry countdown without the private exit diagnostic', () => {
    expect(summarizeNativeStatusReport(report + 'Next retry: 12 seconds\nLast exit: private error\n'))
      .toContain('Next retry: 12 seconds')
  })
  it.each([
    'Installation: installed. Supervisor: running. Daemon: running. Persistence: unknown.',
    report.replace('Crash recovery:', 'Old recovery:'),
    report + 'Dear Machine: stopped\n',
    report.replace('Supervisor: running', 'Supervisor: \x1b[31mrunning'),
  ])('rejects old, incomplete, ambiguous or terminal-control-bearing reports (%#)', value => {
    expect(() => summarizeNativeStatusReport(value)).toThrow()
  })
  it('uses only the explicit native binary with a bounded read-only status invocation', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      done(null, report, '')
      return {} as ChildProcess
    })
    const env = { HOME: '/fixture/home', DEARMACHINE_NATIVE_BIN: '/fixture/bin/dearmachine' }
    expect(await nativeStatusReport(env)).toBe(summarizeNativeStatusReport(report))
    expect(execFile).toHaveBeenCalledExactlyOnceWith(env.DEARMACHINE_NATIVE_BIN, ['status'],
      { env, timeout: 5_000, maxBuffer: 65_536, windowsHide: true }, expect.any(Function))
  })
  it.each([
    { HOME: '/fixture/home' },
    { HOME: '/fixture/home', DEARMACHINE_NATIVE_BIN: 'dearmachine' },
    { HOME: '/fixture/home', DEARMACHINE_NATIVE_BIN: '/fixture/bin/dearmachine', DEARMACHINE_SUPERVISOR_SOCKET: '/other/supervisor.sock' },
  ])('does not recurse through PATH or query a different owner (%#)', async env => {
    await expect(nativeStatusReport(env)).rejects.toThrow()
    expect(execFile).not.toHaveBeenCalled()
  })
  it('suppresses process errors and output on failed or timed-out native queries', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
      done(new Error('private failure'), report, 'private stderr')
      return {} as ChildProcess
    })
    await expect(nativeStatusReport({ HOME: '/fixture/home', DEARMACHINE_NATIVE_BIN: '/fixture/bin/dearmachine' }))
      .rejects.toThrow('Native lifecycle report unavailable.')
  })
})

describe('concierge status reporting', () => {
  it('shares native lifecycle presentation between the welcome banner and /status without a provider', async () => {
    const control = { request: vi.fn().mockResolvedValue(running), readStatusReport: vi.fn().mockResolvedValue(summarizeNativeStatusReport(report)) }
    const banner = await readDaemonStatusReport(control, running)
    const say = vi.fn()
    const converse = vi.fn()
    const shell = new ConciergeShell({ control, say, converse, ensureIndependent: async () => {}, unsubscribe: async () => {}, close: async () => {} })
    await shell.submit('/status')
    expect(say).toHaveBeenCalledExactlyOnceWith(banner)
    expect(control.request).toHaveBeenCalledExactlyOnceWith('status')
    expect(converse).not.toHaveBeenCalled()
    expect(banner).not.toContain('Persistence:')
  })
  it.each(['enabled', 'disabled', 'unknown'] as const)('never infers startup guarantees from legacy persistence=%s', async persistence => {
    const control = { request: vi.fn(), readStatusReport: vi.fn().mockRejectedValue(new Error('private failure')) }
    const result = await readDaemonStatusReport(control, { ...running, persistence })
    expect(result).toContain('Crash recovery: active')
    expect(result).toContain('Closing this chat: leaves Dear Machine running')
    expect(result).toContain('After account logout: not verified')
    expect(result).toContain('Managed startup at login: cannot verify')
    expect(result).toContain('Managed startup after reboot (before login): cannot verify')
    expect(result).toContain('detailed native status unavailable; run dearmachine status')
    expect(result).not.toContain('private failure')
    expect(result).not.toContain('Persistence:')
    expect(control.request).not.toHaveBeenCalled()
  })
  it.each([
    ['backing-off', 'active — waiting to retry'], ['failed', 'paused — consecutive-failure limit reached'],
    ['stopped', 'inactive until started again'], ['unreachable', 'not verified'],
  ] as const)('keeps fallback recovery honest for %s', (supervisor, expected) => {
    const result = formatDaemonStatus({ ...running, supervisor, daemon: 'stopped', lastExit: 'private failure' })
    expect(result).toContain(`Crash recovery: ${expected}`)
    expect(result).not.toContain('leaves Dear Machine running')
    expect(result).not.toContain('private failure')
  })
})


describe('independent native installation observation', () => {
  const env = { HOME: '/fixture/home', DEARMACHINE_NATIVE_BIN: '/fixture/bin/dearmachine' }
  function reply(value: unknown, error: Error | null = null) {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      done(error, JSON.stringify(value), 'private stderr')
      return {} as ChildProcess
    })
  }
  it.each(['installed', 'partial', 'unreadable'] as const)('observes %s without a supervisor socket', async installation => {
    const status = { ...running, installation, supervisor: 'stopped', daemon: 'stopped' }
    reply({ version: 1, ok: true, status })
    expect(await defaultConciergeControl(env).request('status')).toEqual(status)
    expect(execFile).toHaveBeenCalledExactlyOnceWith(env.DEARMACHINE_NATIVE_BIN, ['status', '--json'],
      { env, timeout: 7_000, maxBuffer: 65_536, windowsHide: true }, expect.any(Function))
  })
  it('preserves installed health when runtime observation is inconclusive', async () => {
    const status = { ...running, supervisor: 'unreachable', daemon: 'unknown' }
    reply({ version: 1, ok: true, status })
    expect(await nativeStatus(env)).toEqual(status)
  })
  it.each([
    { version: 2, ok: true, status: running },
    { version: 1, ok: false, status: running },
    { version: 1, ok: true, status: { ...running, installation: 'maybe' } },
    null,
  ])('rejects invalid native observations (%#)', async value => {
    reply(value)
    await expect(nativeStatus(env)).rejects.toThrow('status unavailable')
  })
  it('does not accept output from failed native queries', async () => {
    reply({ version: 1, ok: true, status: running }, new Error('private failure'))
    await expect(nativeStatus(env)).rejects.toThrow('Native installation and runtime status unavailable.')
  })
  it.each(['up', 'down', 'restart'] as const)('never substitutes read-only observations for %s', async command => {
    await expect(defaultConciergeControl(env).request(command)).rejects.toThrow()
    expect(execFile).not.toHaveBeenCalled()
  })
  it('keeps custom endpoint observations separate from native HOME', async () => {
    const custom = { ...env, DEARMACHINE_SUPERVISOR_SOCKET: '/fixture/custom.sock' }
    await expect(defaultConciergeControl(custom).request('status')).rejects.toThrow()
    await expect(nativeStatus(custom)).rejects.toThrow()
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe('external foreground or service ownership', () => {
  it('preserves native ownership and recovery guidance in the lifecycle summary', () => {
    const advice = 'Ownership: another foreground session or service\nRecovery: Inspect the existing process or service. To switch supervision, stop that owner, then run dearmachine up.'
    expect(summarizeNativeStatusReport(report + advice + '\n')).toContain(advice)
  })
  const external = { ...running, supervisor: 'unreachable' as const, daemon: 'unknown' as const, externalOwner: true }
  it('keeps the ownership explanation when the native text report fails', async () => {
    const control = { request: vi.fn(), readStatusReport: vi.fn().mockRejectedValue(new Error('private stderr')) }
    const result = await readDaemonStatusReport(control, external)
    expect(result).toContain('Ownership: another foreground session or service')
    expect(result).toContain('Inspect the existing process or service')
    expect(result).not.toContain('private stderr')
    expect(result).not.toContain('leaves Dear Machine stopped')
    expect(control.request).not.toHaveBeenCalled()
  })
  it.each(['up', 'down', 'restart'] as const)('explains %s refusal without a mutation or bootstrap attempt', async command => {
    const control = { request: vi.fn().mockResolvedValue(external), bootstrapUp: vi.fn() }
    const result = await executeDaemonCommand(control, command)
    expect(result.code).toBe(1)
    expect(result.message).toContain('Inspect the existing process or service')
    expect(control.request).toHaveBeenCalledExactlyOnceWith('status')
    expect(control.bootstrapUp).not.toHaveBeenCalled()
  })
  it('rejects malformed ownership observations without exposing their contents', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      done(null, JSON.stringify({ version: 1, ok: true, status: { ...external, externalOwner: 'private text' } }), '')
      return {} as ChildProcess
    })
    await expect(nativeStatus({ HOME: '/fixture/home', DEARMACHINE_NATIVE_BIN: '/fixture/dearmachine' }))
      .rejects.toThrow('Native installation and runtime status unavailable.')
  })
})

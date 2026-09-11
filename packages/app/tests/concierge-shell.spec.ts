import { describe, expect, it, vi } from 'vitest'
import { ConciergeShell, executeDaemonCommand, localHelp } from '../src/concierge-shell.ts'
import type { DaemonStatus } from '../src/concierge-control.ts'

const running: DaemonStatus = { installation: 'installed', supervisor: 'running', daemon: 'running', persistence: 'disabled' }
const stopped: DaemonStatus = { ...running, supervisor: 'stopped', daemon: 'stopped' }

it('opens /model locally, rejects duplicate pickers and keeps status and exit available', async () => {
  const { ports } = fixture()
  let finish!: () => void
  const changeModel = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const shell = new ConciergeShell({ ...ports, changeModel })
  const changing = shell.submit('/model')
  await shell.submit('/model')
  await shell.submit('wait for the picker')
  await shell.submit('/help')
  await shell.submit('/status')
  await shell.submit('/quit')
  expect(changeModel).toHaveBeenCalledOnce()
  expect(ports.converse).not.toHaveBeenCalled()
  expect(ports.close).toHaveBeenCalledOnce()
  expect(ports.control.request).toHaveBeenCalledExactlyOnceWith('status')
  finish(); await changing
})

it('explains safe interface exit after a confirmed local start', async () => {
  const control = { request: vi.fn().mockResolvedValueOnce(stopped).mockResolvedValue(running) }
  const say = vi.fn()
  const shell = new ConciergeShell({ control, say, ensureIndependent: async () => {}, unsubscribe: async () => {}, close: async () => {} })
  await shell.submit('/up')
  expect(say.mock.calls.flat().join(' ')).toContain('/quit')
  expect(say.mock.calls.flat().join(' ')).toContain('background')
})
function fixture(status = running) {
  const control = { request: vi.fn().mockResolvedValue(status) }
  const ports = { control, say: vi.fn(), ensureIndependent: vi.fn().mockResolvedValue(undefined), unsubscribe: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), converse: vi.fn().mockRejectedValue(new Error('provider offline')) }
  return { control, ports, shell: new ConciergeShell(ports) }
}
describe('local slash commands', () => {
  it('shows all fallback commands and lifetime effects without any provider or daemon request', async () => {
    const { control, ports, shell } = fixture()
    await shell.submit('/help')
    for (const command of ['--help', 'status', 'up', 'down', 'restart']) expect(localHelp).toContain(`dearmachine ${command}`)
    for (const command of ['/up', '/down', '/quit', '/detach', 'Ctrl+C']) expect(localHelp).toContain(command)
    expect(ports.say).toHaveBeenCalledWith(localHelp)
    expect(control.request).not.toHaveBeenCalled()
    expect(ports.converse).not.toHaveBeenCalled()
  })
  it.each(['/up', '/down'])('uses the deterministic CLI control boundary for %s', async text => {
    const desired = text === '/up' ? running : stopped
    const { control, ports, shell } = fixture()
    control.request.mockResolvedValueOnce(text === '/up' ? stopped : running).mockResolvedValue(desired)
    await shell.submit(text)
    expect(control.request.mock.calls).toEqual([['status'], [text.slice(1)]])
    expect(ports.say).toHaveBeenCalledWith(expect.stringContaining(`Dear Machine: ${desired.daemon}`))
    expect(ports.converse).not.toHaveBeenCalled()
  })
  it.each(['up', 'down'] as const)('treats already %s as a successful no-op', async command => {
    const { control } = fixture(command === 'up' ? running : stopped)
    expect((await executeDaemonCommand(control, command)).code).toBe(0)
    expect(control.request).toHaveBeenCalledExactlyOnceWith('status')
  })
  it('stops even when the child is stopped but a retry is pending', async () => {
    const { control } = fixture({ ...stopped, supervisor: 'backing-off', retryInMs: 100 })
    control.request.mockResolvedValueOnce({ ...stopped, supervisor: 'backing-off' }).mockResolvedValue(stopped)
    expect((await executeDaemonCommand(control, 'down')).code).toBe(0)
    expect(control.request).toHaveBeenLastCalledWith('down')
  })
  it.each(['absent', 'partial', 'unreadable'] as const)('does not mutate %s installations', async installation => {
    const { control } = fixture({ ...stopped, installation })
    const result = await executeDaemonCommand(control, 'up')
    expect(result.code).toBe(1)
    expect(result.message).toContain('install')
    expect(control.request).toHaveBeenCalledExactlyOnceWith('status')
  })
  it.each(['up', 'down', 'restart'] as const)('does not report an unconfirmed %s as successful', async command => {
    const { control } = fixture({ ...running, supervisor: 'starting', daemon: 'unknown' })
    expect((await executeDaemonCommand(control, command)).code).toBe(1)
  })
  it('distinguishes stopped status from unreachable status', async () => {
    const { control } = fixture(stopped)
    expect((await executeDaemonCommand(control, 'status')).code).toBe(0)
    control.request.mockRejectedValue(new Error('endpoint unavailable'))
    expect(await executeDaemonCommand(control, 'status')).toMatchObject({ code: 1, message: expect.stringContaining('dearmachine status') })
  })
  it.each(['/quit', '/detach'])('hands off ownership and closes only the interface for %s', async text => {
    const { control, ports, shell } = fixture()
    const order: string[] = []
    ports.ensureIndependent.mockImplementation(async () => { order.push('handoff') })
    ports.unsubscribe.mockImplementation(async () => { order.push('unsubscribe') })
    ports.close.mockImplementation(async () => { order.push('close') })
    await shell.submit(text)
    await shell.submit(text)
    expect(order).toEqual(['handoff', 'unsubscribe', 'close'])
    expect(control.request).not.toHaveBeenCalled()
    expect(ports.converse).not.toHaveBeenCalled()
  })
  it.each(['ensureIndependent', 'unsubscribe'] as const)('stays open after failed %s', async method => {
    const { control, ports, shell } = fixture()
    ports[method].mockRejectedValue(new Error('failed'))
    await shell.submit('/detach')
    expect(ports.close).not.toHaveBeenCalled()
    expect(ports.say).toHaveBeenCalledWith(expect.stringContaining('stays open'))
    expect(control.request).not.toHaveBeenCalled()
  })
  it('handles unknown slash commands and trailing arguments locally', async () => {
    const { control, ports, shell } = fixture()
    await shell.submit('/unknown')
    await shell.submit('/up --create')
    expect(control.request).not.toHaveBeenCalled()
    expect(ports.converse).not.toHaveBeenCalled()
    expect(ports.say).toHaveBeenLastCalledWith(expect.stringContaining('/help'))
  })
  it('retains local controls after a provider failure', async () => {
    const { ports, shell } = fixture()
    await shell.submit('hello')
    expect(ports.say).toHaveBeenCalledWith(expect.stringContaining('/help'))
    await shell.submit('/help')
    expect(ports.converse).toHaveBeenCalledTimes(1)
    expect(ports.say).toHaveBeenLastCalledWith(localHelp)
  })
  it('keeps local help responsive while a provider request is pending', async () => {
    const { ports, shell } = fixture()
    let complete!: () => void
    ports.converse.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    const pending = shell.submit('hello')
    await shell.submit('/help')
    expect(ports.say).toHaveBeenLastCalledWith(localHelp)
    complete()
    await pending
  })
  it('serializes mutations and waits for a pending operation before exiting', async () => {
    const { control, ports, shell } = fixture(stopped)
    let complete!: (status: DaemonStatus) => void
    control.request.mockImplementation(async command => command === 'status' ? stopped : new Promise<DaemonStatus>(resolve => { complete = resolve }))
    const start = shell.submit('/up')
    await vi.waitFor(() => expect(control.request).toHaveBeenCalledWith('up'))
    const exit = shell.submit('/quit')
    expect(ports.close).not.toHaveBeenCalled()
    await shell.submit('/help')
    complete(running)
    await Promise.all([start, exit])
    expect(ports.close).toHaveBeenCalledOnce()
  })
})

it.each(['restart', 'status'] as const)('handles /%s locally through the control dispatcher', async command => {
  const request = vi.fn().mockResolvedValue({ installation: 'installed', supervisor: 'running', daemon: 'running', persistence: 'unknown' })
  const say = vi.fn()
  const converse = vi.fn()
  const shell = new ConciergeShell({ control: { request }, say, converse, ensureIndependent: async () => {}, unsubscribe: async () => {}, close: async () => {} })
  await shell.submit(`/${command}`)
  expect(request.mock.calls.map(call => call[0])).toEqual(command === 'status' ? ['status'] : ['status', 'restart'])
  expect(say).toHaveBeenCalledWith(expect.stringContaining('Dear Machine: running'))
  expect(converse).not.toHaveBeenCalled()
  expect(localHelp).toContain(`/${command}`)
})

import { describe, it, expect, vi } from 'vitest'
import { BootstrapDaemonControl, EndpointAbsentError, type DaemonCommand, type DaemonControl, type DaemonStatus } from '../src/concierge-control.ts'
import { executeDaemonCommand } from '../src/concierge-shell.ts'

const running: DaemonStatus = { installation: 'installed', supervisor: 'running', daemon: 'running', persistence: 'unknown' }
describe('native bootstrap', () => {
  it('joins concurrent up requests, reports progress and observes readiness', async () => {
    let ready = false
    const request = vi.fn(async () => { if (!ready) throw new EndpointAbsentError(); return running })
    const bootstrap = vi.fn(async () => { ready = true })
    const progress = vi.fn()
    const control = new BootstrapDaemonControl({ request }, bootstrap, 100, progress)
    const results = await Promise.all([executeDaemonCommand(control, 'up'), executeDaemonCommand(control, 'up')])
    expect(results.map(r => r.code)).toEqual([0, 0])
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('Bootstrapping'))
  })
  it.each(['status', 'down', 'restart'] as const)('does not bootstrap %s', async command => {
    const bootstrap = vi.fn()
    const control = new BootstrapDaemonControl({ request: async () => { throw new EndpointAbsentError() } }, bootstrap, 30)
    expect((await executeDaemonCommand(control, command)).code).toBe(1)
    expect(bootstrap).not.toHaveBeenCalled()
  })
  it('does not bootstrap after an ambiguous protocol error', async () => {
    const bootstrap = vi.fn()
    const control = new BootstrapDaemonControl({ request: async () => { throw new Error('unconfirmed') } }, bootstrap, 30)
    expect((await executeDaemonCommand(control, 'up')).code).toBe(1)
    expect(bootstrap).not.toHaveBeenCalled()
  })
  it('joins a competing bootstrap even when native up fails', async () => {
    let reads = 0
    const request: DaemonControl['request'] = async () => { if (++reads < 3) throw new EndpointAbsentError(); return running }
    const control = new BootstrapDaemonControl({ request }, async () => { throw new Error('other starter') }, 300)
    expect((await executeDaemonCommand(control, 'up')).code).toBe(0)
  })
  it('bounds a hung bootstrap and never claims a running daemon', async () => {
    const control = new BootstrapDaemonControl({ request: async () => { throw new EndpointAbsentError() } }, () => new Promise(() => {}), 30)
    expect((await executeDaemonCommand(control, 'up')).code).toBe(1)
  })
})

it.each(['backing-off', 'failed', 'stopped'] as const)('does not retry a completed bootstrap observed as %s', async supervisor => {
  let available = false
  const request = vi.fn(async (_command: DaemonCommand) => {
    if (!available) throw new EndpointAbsentError()
    return { ...running, supervisor, daemon: 'stopped' as const }
  })
  const control = new BootstrapDaemonControl({ request }, async () => { available = true }, 100)
  const result = await executeDaemonCommand(control, 'up')
  expect(result.code).toBe(1)
  expect(request.mock.calls.every(args => args.length === 1 && args[0] === 'status')).toBe(true)
})

it('bootstraps explicit up after native inspection confirms an installed stopped client', async () => {
  const stopped: DaemonStatus = { ...running, supervisor: 'stopped', daemon: 'stopped' }
  let available = false
  const socket = { request: vi.fn(async () => {
    if (!available) throw new EndpointAbsentError()
    return running
  }) }
  const bootstrap = vi.fn(async () => { available = true })
  const control = new BootstrapDaemonControl(socket, bootstrap, 100, undefined, undefined, async () => stopped)
  expect((await executeDaemonCommand(control, 'status')).code).toBe(0)
  expect((await executeDaemonCommand(control, 'down')).code).toBe(0)
  expect(bootstrap).not.toHaveBeenCalled()
  expect(socket.request).not.toHaveBeenCalled()
  expect((await executeDaemonCommand(control, 'up')).code).toBe(0)
  expect(bootstrap).toHaveBeenCalledTimes(1)
})

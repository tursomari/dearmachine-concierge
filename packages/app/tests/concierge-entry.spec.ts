import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { entryHelp, inspectInstallation, parseInvocation, runConciergeEntry, type InstallerInvocation } from '../src/concierge-entry.ts'
import type { DaemonControl, DaemonStatus } from '../src/concierge-control.ts'

const stopped: DaemonStatus = { installation: 'installed', supervisor: 'stopped', daemon: 'stopped', persistence: 'disabled' }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'concierge-entry-'))
  roots.push(home)
  const control: DaemonControl = { request: vi.fn().mockResolvedValue(stopped) }
  return { home, control }
}

describe('installation diagnosis', () => {
  it('detects an absent installation without calling a daemon or reading credentials', async () => {
    const { home, control } = await fixture()
    expect(await inspectInstallation(home, control)).toEqual({ installation: 'absent' })
    expect(control.request).not.toHaveBeenCalled()
  })
  it('allows DearMachine setup when only standalone Machtiani exists', async () => {
    const { home, control } = await fixture()
    await mkdir(join(home, '.machtiani'))
    await mkdir(join(home, '.config/machtiani'), { recursive: true })
    expect(await inspectInstallation(home, control)).toEqual({ installation: 'absent' })
    expect(control.request).not.toHaveBeenCalled()
  })
  it('distinguishes an installed but stopped daemon from absence', async () => {
    const { home, control } = await fixture()
    await mkdir(join(home, '.dearmachine'))
    expect(await inspectInstallation(home, control)).toEqual({ installation: 'installed', status: stopped })
    expect(control.request).toHaveBeenCalledExactlyOnceWith('status')
  })
  it.each(['.dearmachine'])('preserves partial %s state when control is unavailable', async directory => {
    const { home, control } = await fixture()
    await mkdir(join(home, directory))
    vi.mocked(control.request).mockRejectedValue(new Error('offline'))
    expect(await inspectInstallation(home, control)).toMatchObject({ installation: 'partial', guidance: expect.stringContaining('dearmachine status') })
  })
  it('does not trust an absent report over existing installation artifacts', async () => {
    const { home, control } = await fixture()
    await mkdir(join(home, '.dearmachine'))
    vi.mocked(control.request).mockResolvedValue({ ...stopped, installation: 'absent' })
    expect(await inspectInstallation(home, control)).toMatchObject({ installation: 'partial' })
  })
  it('diagnoses unreadable state instead of installing over it', async () => {
    const { home, control } = await fixture()
    const inspect = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(await inspectInstallation(home, control, inspect)).toMatchObject({ installation: 'unreadable' })
    expect(control.request).not.toHaveBeenCalled()
  })
})

describe('provider-free entry routing', () => {
  function ports() {
    return {
      interactive: true, inspect: vi.fn().mockResolvedValue({ installation: 'installed', status: stopped }),
      install: vi.fn().mockResolvedValue(undefined), manage: vi.fn().mockResolvedValue(undefined), write: vi.fn(),
    }
  }
  it('prints help on non-TTY entry without detection, installation, or management', async () => {
    const p = ports()
    p.interactive = false
    await runConciergeEntry(p)
    expect(p.write).toHaveBeenCalledWith(expect.stringContaining('dearmachine --help'))
    expect(p.inspect).not.toHaveBeenCalled()
    expect(p.install).not.toHaveBeenCalled()
    expect(p.manage).not.toHaveBeenCalled()
  })
  it('routes installed-but-stopped state to management without starting the daemon', async () => {
    const p = ports()
    await runConciergeEntry(p)
    expect(p.manage).toHaveBeenCalledWith({ installation: 'installed', status: stopped })
    expect(p.install).not.toHaveBeenCalled()
  })
  it('runs the existing installer on absence and hands off only after observed installation', async () => {
    const p = ports()
    p.inspect.mockResolvedValueOnce({ installation: 'absent' })
    await runConciergeEntry(p)
    expect(p.install).toHaveBeenCalledOnce()
    expect(p.manage).toHaveBeenCalledWith({ installation: 'installed', status: stopped })
  })
  it('does not claim installation after declining or exiting setup', async () => {
    const p = ports()
    p.inspect.mockResolvedValue({ installation: 'absent' })
    await runConciergeEntry(p)
    expect(p.manage).not.toHaveBeenCalled()
  })
  it.each(['partial', 'unreadable'])('opens recovery controls for %s state without installing', async installation => {
    const p = ports()
    p.inspect.mockResolvedValue({ installation, guidance: 'Inspect existing state' })
    await runConciergeEntry(p)
    expect(p.install).not.toHaveBeenCalled()
    expect(p.manage).toHaveBeenCalledWith({ installation, guidance: 'Inspect existing state' })
  })
})

describe('installer invocation split', () => {
  it('presents dearmachine as the unified public entry point', () => {
    expect(entryHelp).toMatch(/^Usage: dearmachine/m)
    expect(entryHelp).toContain('machtiani-installer remains available as a compatibility alias.')
  })

  const cases: [readonly string[], InstallerInvocation][] = [
    [[], { mode: 'concierge' }], [['--concierge'], { mode: 'concierge' }],
    [['--help'], { mode: 'help' }], [['--mock'], { mode: 'mock' }],
    [['--source-root', '/fixture'], { mode: 'concierge', sourceRoot: '/fixture' }],
    [['--install', '--source-root', '/fixture'], { mode: 'install', sourceRoot: '/fixture' }],
    [['--concierge', '--source-root', '/fixture'], { mode: 'concierge', sourceRoot: '/fixture' }],
    ...(['status', 'up', 'down', 'restart'] as const).map(command => [[command], { mode: 'control', command }] as [string[], InstallerInvocation]),
  ]
  it.each(cases)('parses %j without loading an installer agent', (args, expected) => {
    expect(parseInvocation(args)).toEqual(expected)
  })
  it.each([['--wat'], ['up', '--create'], ['--install'], ['--source-root', ''], ['--concierge', '--source-root', ''], ['--help', 'up']])('rejects unsupported arguments %j', (...args) => {
    expect(() => parseInvocation(args)).toThrow('Usage:')
  })
})

it('accepts the native source-root environment through the existing concierge mode', () => {
  expect(parseInvocation(['--concierge'], { DEARMACHINE_SOURCE_ROOT: '/fixture/source' })).toEqual({ mode: 'concierge', sourceRoot: '/fixture/source' })
  expect(parseInvocation(['--concierge', '--source-root', '/explicit'], { DEARMACHINE_SOURCE_ROOT: '/fixture/source' })).toEqual({ mode: 'concierge', sourceRoot: '/explicit' })
  expect(parseInvocation(['--help'], { DEARMACHINE_SOURCE_ROOT: 'invalid' })).toEqual({ mode: 'help' })
  expect(() => parseInvocation(['--concierge'], { DEARMACHINE_SOURCE_ROOT: 'relative' })).toThrow('absolute')
})

it('rejects a relative explicit concierge source root before setup', () => {
  expect(() => parseInvocation(['--concierge', '--source-root', 'relative'])).toThrow('absolute')
})

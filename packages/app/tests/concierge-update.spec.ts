import { describe, expect, it, vi } from 'vitest'
import { NaturalUpdateRouter, runConciergeUpdate } from '../src/concierge-update.ts'

const old = 'a'.repeat(40)
const next = 'b'.repeat(40)

function fixture(choices: string[] = []) {
  const messages: string[] = []
  const tui = {
    choose: vi.fn(async () => choices.shift() ?? 'not-now'),
    addAssistant: vi.fn((message: string) => { messages.push(message) }),
    setProgress: vi.fn(),
  }
  const updater = { check: vi.fn(), install: vi.fn() }
  const relaunch = vi.fn(async () => {})
  const close = vi.fn(async () => {})
  return { messages, tui, updater, relaunch, close }
}

describe('concierge update consent flow', () => {
  it.each(['current', 'unsupported', 'failed'] as const)('reports %s and remains usable without installation', async state => {
    const f = fixture()
    f.updater.check.mockResolvedValue(state === 'current' ? { state, current: old, available: old } : { state })
    await runConciergeUpdate({ ...f, request: 'startup' })
    expect(f.updater.install).not.toHaveBeenCalled()
    expect(f.tui.choose).not.toHaveBeenCalled()
    expect(f.messages.join(' ')).toMatch(state === 'failed' ? /keep using/u : new RegExp(state, 'u'))
  })

  it('reports availability for a natural-language check without treating it as install consent', async () => {
    const f = fixture()
    f.updater.check.mockResolvedValue({ state: 'available', current: old, available: next })
    await runConciergeUpdate({ ...f, request: 'check' })
    expect(f.tui.choose).not.toHaveBeenCalled()
    expect(f.updater.install).not.toHaveBeenCalled()
    expect(f.messages.join(' ')).toContain(next)
  })

  it('defaults to decline and permits continued use', async () => {
    const f = fixture(['not-now'])
    f.updater.check.mockResolvedValue({ state: 'available', current: old, available: next })
    await runConciergeUpdate({ ...f, request: 'install' })
    expect(f.tui.choose).toHaveBeenCalledWith(expect.stringContaining('Install this update'), expect.any(Array), 'not-now')
    expect(f.updater.install).not.toHaveBeenCalled()
    expect(f.messages.join(' ')).toContain('keep using')
  })

  it('continues after a failed accepted installation and retains rollback guidance', async () => {
    const f = fixture(['install'])
    f.updater.check.mockResolvedValue({ state: 'available', current: old, available: next })
    f.updater.install.mockResolvedValue({ state: 'failed' })
    await runConciergeUpdate({ ...f, request: 'install' })
    expect(f.relaunch).not.toHaveBeenCalled()
    expect(f.close).not.toHaveBeenCalled()
    expect(f.messages.join(' ')).toContain('--recover')
    expect(f.messages.join(' ')).toContain('keep using')
  })

  it('reports the activated release and requests a clean relaunch only after two explicit choices', async () => {
    const f = fixture(['install', 'relaunch'])
    f.updater.check.mockResolvedValue({ state: 'available', current: old, available: next })
    f.updater.install.mockResolvedValue({ state: 'installed', release: next })
    await runConciergeUpdate({ ...f, request: 'startup' })
    expect(f.updater.install).toHaveBeenCalledOnce()
    expect(f.messages.join(' ')).toContain(next)
    expect(f.relaunch).toHaveBeenCalledOnce()
    expect(f.close).not.toHaveBeenCalled()
  })
})

it('routes model interpretation only after its turn and coalesces duplicate requests to one strongest action', () => {
  const router = new NaturalUpdateRouter()
  expect(router.accept({ type: 'local-action', action: 'check-update' })).toBeUndefined()
  expect(router.accept({ type: 'local-action', action: 'install-update' })).toBeUndefined()
  expect(router.accept({ type: 'local-action', action: 'check-update' })).toBeUndefined()
  expect(router.accept({ type: 'turn-end', outcome: 'completed' })).toBe('install')
  expect(router.accept({ type: 'turn-end', outcome: 'completed' })).toBeUndefined()
})

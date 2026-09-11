import { execFile, type ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeUpdateControl } from '../src/native-update.ts'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
const old = 'a'.repeat(40)
const next = 'b'.repeat(40)

function complete(error: Error | null, value: unknown): void {
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
    done(error, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`, 'private diagnostic')
    return {} as ChildProcess
  })
}

beforeEach(() => vi.resetAllMocks())

describe('absolute native update control', () => {
  const env = { HOME: '/fixture/home', DEARMACHINE_NATIVE_BIN: '/fixture/bin/dearmachine' }

  it.each(['current', 'available'] as const)('parses a stable %s check result', async state => {
    complete(null, { version: 1, operation: 'check', state, current: old, available: state === 'current' ? old : next })
    await expect(new NativeUpdateControl(env).check()).resolves.toEqual({ state, current: old, available: state === 'current' ? old : next })
    expect(execFile).toHaveBeenCalledExactlyOnceWith(env.DEARMACHINE_NATIVE_BIN, ['update', '--check', '--json'],
      { env, timeout: 30_000, maxBuffer: 65_536, windowsHide: true, encoding: 'utf8' }, expect.any(Function))
  })

  it('distinguishes an unsupported channel from a failed or malformed check', async () => {
    complete(null, { version: 1, operation: 'check', state: 'unsupported' })
    await expect(new NativeUpdateControl(env).check()).resolves.toEqual({ state: 'unsupported' })
    complete(new Error('private failure'), { version: 1, operation: 'check', state: 'failed' })
    await expect(new NativeUpdateControl(env).check()).resolves.toEqual({ state: 'failed' })
    complete(null, { version: 1, operation: 'check', state: 'available', current: 'invalid', available: next })
    await expect(new NativeUpdateControl(env).check()).resolves.toEqual({ state: 'failed' })
  })

  it('installs without an unsafe process timeout and validates release identity', async () => {
    complete(null, { version: 1, operation: 'install', state: 'installed', release: next })
    await expect(new NativeUpdateControl(env).install()).resolves.toEqual({ state: 'installed', release: next })
    expect(execFile).toHaveBeenCalledExactlyOnceWith(env.DEARMACHINE_NATIVE_BIN, ['update', '--json'],
      { env, maxBuffer: 65_536, windowsHide: true, encoding: 'utf8' }, expect.any(Function))
  })

  it.each([
    { HOME: '/fixture/home' },
    { HOME: '/fixture/home', DEARMACHINE_NATIVE_BIN: 'dearmachine' },
    { HOME: 'relative', DEARMACHINE_NATIVE_BIN: '/fixture/bin/dearmachine' },
  ])('never falls back to PATH for an invalid launch environment (%#)', async invalid => {
    await expect(new NativeUpdateControl(invalid).check()).resolves.toEqual({ state: 'failed' })
    expect(execFile).not.toHaveBeenCalled()
  })
})

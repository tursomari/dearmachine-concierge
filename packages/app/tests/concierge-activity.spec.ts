import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConciergeActivityIndicator } from '../src/concierge-activity.ts'

afterEach(() => { vi.useRealTimers() })

describe('concierge activity indicator', () => {
  it('tracks waiting, private tokens, visible tokens, pauses, and idle state', () => {
    vi.useFakeTimers()
    const setProgress = vi.fn()
    const activity = new ConciergeActivityIndicator({ setProgress }, 200)

    activity.status('running')
    expect(setProgress).toHaveBeenLastCalledWith('processing', 'slow')

    activity.event({ type: 'assistant-stream', channel: 'internal' })
    expect(setProgress).toHaveBeenLastCalledWith('processing', 'medium')
    vi.advanceTimersByTime(200)
    expect(setProgress).toHaveBeenLastCalledWith('processing', 'slow')

    activity.event({ type: 'assistant-stream', channel: 'visible' })
    expect(setProgress).toHaveBeenLastCalledWith('processing', 'fast')
    activity.event({ type: 'tool-start', id: 'tool-1', name: 'read', detail: 'file' })
    expect(setProgress).toHaveBeenLastCalledWith('processing', 'slow')

    activity.event({ type: 'turn-end', outcome: 'completed' })
    expect(setProgress).toHaveBeenLastCalledWith(undefined)
    activity.event({ type: 'assistant-stream', channel: 'visible' })
    expect(setProgress).toHaveBeenLastCalledWith(undefined)
  })
})

// Sign-in owns the footer while the enclosing installer turn can still change state.
it.each(['running', 'idle', 'turn-end', 'disposed'] as const)(
  'restores the current activity after a trusted interaction (%s)', async state => {
    vi.useFakeTimers()
    const setProgress = vi.fn()
    const activity = new ConciergeActivityIndicator({ setProgress }, 200)
    activity.status('running')
    activity.event({ type: 'assistant-stream', channel: 'visible' })
    let finish!: () => void
    const result = activity.duringInteraction(() => new Promise<void>(resolve => { finish = resolve }))
    setProgress.mockClear()
    vi.advanceTimersByTime(500)
    activity.event({ type: 'tool-end', id: 'login', failed: false })
    if (state === 'idle') activity.status('idle')
    if (state === 'turn-end') activity.event({ type: 'turn-end', outcome: 'completed' })
    if (state === 'disposed') activity.dispose()
    expect(setProgress).not.toHaveBeenCalled()
    finish()
    await result
    if (state === 'running') expect(setProgress).toHaveBeenLastCalledWith('processing', 'slow')
    else expect(setProgress).toHaveBeenLastCalledWith(undefined)
    activity.status('idle')
    vi.advanceTimersByTime(500)
    expect(setProgress).toHaveBeenLastCalledWith(undefined)
  },
)

it('restores running activity when an interaction fails', async () => {
  const setProgress = vi.fn()
  const activity = new ConciergeActivityIndicator({ setProgress })
  activity.status('running')
  await expect(activity.duringInteraction(async () => { throw new Error('cancelled') })).rejects.toThrow('cancelled')
  expect(setProgress).toHaveBeenLastCalledWith('processing', 'slow')
  activity.dispose()
})

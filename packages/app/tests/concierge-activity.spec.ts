import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConciergeActivityIndicator } from '../src/concierge-activity.ts'

afterEach(() => { vi.useRealTimers() })

describe('concierge activity indicator', () => {
  it('tracks waiting, private tokens, visible tokens, pauses, and idle state', () => {
    vi.useFakeTimers()
    const setProgress = vi.fn()
    const activity = new ConciergeActivityIndicator({ setProgress }, 200)

    activity.status('running')
    expect(setProgress).toHaveBeenLastCalledWith('Preparing…', 'slow')

    activity.event({ type: 'assistant-stream', channel: 'internal' })
    expect(setProgress).toHaveBeenLastCalledWith('Working through…', 'medium')
    vi.advanceTimersByTime(200)
    expect(setProgress).toHaveBeenLastCalledWith('Preparing…', 'slow')

    activity.event({ type: 'assistant-stream', channel: 'visible' })
    expect(setProgress).toHaveBeenLastCalledWith('Responding…', 'fast')
    activity.event({ type: 'tool-start', id: 'tool-1', name: 'read', detail: 'file' })
    expect(setProgress).toHaveBeenLastCalledWith('Preparing…', 'slow')

    activity.event({ type: 'turn-end', outcome: 'completed' })
    expect(setProgress).toHaveBeenLastCalledWith(undefined)
    activity.event({ type: 'assistant-stream', channel: 'visible' })
    expect(setProgress).toHaveBeenLastCalledWith(undefined)
  })
})

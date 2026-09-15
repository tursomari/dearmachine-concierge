import type { InstallerAgentEvent, InstallerAgentStatus } from '@dearmachine/machtiani-installer-dsh-adapter'
import type { InstallerProgressSpeed } from '@dearmachine/machtiani-installer-tui'

interface ConciergeActivityTui {
  setProgress(message: string | undefined, speed?: InstallerProgressSpeed): void
}

const PREPARING = ['Preparing…', 'slow'] as const
const WORKING_THROUGH = ['Working through…', 'medium'] as const
const RESPONDING = ['Responding…', 'fast'] as const

/** Translate private stream activity into a transient, content-free status. */
export class ConciergeActivityIndicator {
  private running = false
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly tui: ConciergeActivityTui,
    private readonly activityHoldMs = 200,
  ) {}

  status(status: InstallerAgentStatus): void {
    this.clearFallback()
    this.running = status === 'running'
    if (this.running) this.tui.setProgress(...PREPARING)
    else this.tui.setProgress(undefined)
  }

  event(event: InstallerAgentEvent): void {
    if (!this.running) return
    if (event.type === 'turn-end') {
      this.status('idle')
      return
    }
    if (event.type === 'assistant-stream') {
      const [message, speed] = event.channel === 'visible' ? RESPONDING : WORKING_THROUGH
      this.tui.setProgress(message, speed)
      this.clearFallback()
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = undefined
        if (this.running) this.tui.setProgress(...PREPARING)
      }, this.activityHoldMs)
      this.fallbackTimer.unref()
      return
    }
    if (event.type === 'tool-start' || event.type === 'tool-end') {
      this.clearFallback()
      this.tui.setProgress(...PREPARING)
    }
  }

  dispose(): void {
    this.running = false
    this.clearFallback()
  }

  private clearFallback(): void {
    if (this.fallbackTimer !== undefined) clearTimeout(this.fallbackTimer)
    this.fallbackTimer = undefined
  }
}

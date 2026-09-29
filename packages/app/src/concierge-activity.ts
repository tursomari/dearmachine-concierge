import type { InstallerAgentEvent, InstallerAgentStatus } from '@dearmachine/machtiani-installer-dsh-adapter'
import type { InstallerProgressSpeed } from '@dearmachine/machtiani-installer-tui'

interface ConciergeActivityTui {
  setProgress(message: string | undefined, speed?: InstallerProgressSpeed): void
}

const PROGRESS_MESSAGE = 'processing'

/** Translate private stream activity into a transient, content-free status. */
export class ConciergeActivityIndicator {
  private running = false
  private interactions = 0
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly tui: ConciergeActivityTui,
    private readonly activityHoldMs = 200,
  ) {}

  status(status: InstallerAgentStatus): void {
    this.clearFallback()
    this.running = status === 'running'
    if (this.interactions > 0) return
    if (this.running) this.tui.setProgress(PROGRESS_MESSAGE, 'slow')
    else this.tui.setProgress(undefined)
  }

  event(event: InstallerAgentEvent): void {
    if (!this.running) return
    if (event.type === 'turn-end') {
      this.status('idle')
      return
    }
    if (this.interactions > 0) return
    if (event.type === 'assistant-stream') {
      this.tui.setProgress(PROGRESS_MESSAGE, event.channel === 'visible' ? 'fast' : 'medium')
      this.clearFallback()
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = undefined
        if (this.running) this.tui.setProgress(PROGRESS_MESSAGE, 'slow')
      }, this.activityHoldMs)
      this.fallbackTimer.unref()
      return
    }
    if (event.type === 'tool-start' || event.type === 'tool-end') {
      this.clearFallback()
      this.tui.setProgress(PROGRESS_MESSAGE, 'slow')
    }
  }

  /** Let a trusted prompt own progress, then resume the current agent state. */
  async duringInteraction<T>(run: () => Promise<T>): Promise<T> {
    this.interactions++
    this.clearFallback()
    try { return await run() }
    finally {
      this.interactions--
      if (this.interactions === 0) this.status(this.running ? 'running' : 'idle')
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

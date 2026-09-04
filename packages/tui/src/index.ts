/**
 * Machtiani Installer's deliberately small terminal surface. Presentation and
 * terminal ownership live here; workflow, tools, and DSH compatibility do not.
 */

import {
  Container,
  Editor,
  Key,
  Markdown,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  matchesKey,
  visibleWidth,
  type Terminal,
} from '@earendil-works/pi-tui'
import { displayText } from './text.ts'
import { createInstallerTheme, editorTheme, markdownTheme, type InstallerTheme } from './theme.ts'
import { MaskedInput } from './masked-input.ts'
import { ChoiceInput, type InstallerChoice } from './choice-input.ts'

export interface InstallerQuestion {
  message: string
  options?: readonly string[]
  signal?: AbortSignal
}

export interface InstallerTuiOptions {
  terminal?: Terminal
  title?: string
  color?: boolean
  onSubmit?(text: string): void | Promise<void>
  onInterrupt?(): void | Promise<void>
  onExit?(): void
}

export class SecretInputCancelledError extends Error {
  constructor() {
    super('secure credential entry was cancelled')
    this.name = 'SecretInputCancelledError'
  }
}

export interface ToolActivity {
  succeed(summary?: string): void
  fail(summary: string): void
}

export interface InstallerInteractionHandle {
  close(): void
}

export class InstallerTui {
  private readonly terminal: Terminal
  private readonly ui: TUI
  private readonly transcript = new Container()
  private readonly status = new Text('', 0, 0)
  private readonly interruptNotice = new Text('', 0, 0)
  private readonly editor: Editor
  private readonly maskedInput = new MaskedInput()
  private readonly secureInputLabel: Text
  private readonly inputSlot = new Container()
  private choiceInput: ChoiceInput | undefined
  private externalWaitLabel: Text | undefined
  private cancellationHandler: (() => void) | undefined
  private readonly theme: InstallerTheme
  private readonly markdown
  private readonly removeInputListener: () => void
  private pendingQuestion: {
    resolve(value: string): void
    reject(error: Error): void
    mode: 'text' | 'secret' | 'choice'
    signal?: AbortSignal
    onAbort?: () => void
  } | undefined
  private started = false
  private stopped = false
  private progressMessage: string | undefined
  private suspendedProgressMessage: string | undefined
  private progressFrame = 0
  private progressTimer: ReturnType<typeof setInterval> | undefined
  private exitArmed = false

  constructor(private readonly options: InstallerTuiOptions = {}) {
    this.terminal = options.terminal ?? new ProcessTerminal()
    this.theme = createInstallerTheme(options.color ?? true)
    this.markdown = markdownTheme(this.theme)
    this.secureInputLabel = new Text(
      `${this.theme.bold(this.theme.accent('🔒  Secure API key — input hidden'))}  ${this.theme.dim('Ctrl+C to cancel key entry')}`,
      0,
      0,
    )
    this.ui = new TUI(this.terminal, false)
    this.editor = new Editor(this.ui, editorTheme(this.theme), {
      frame: 'none',
      paddingX: 1,
      prompt: { first: '› ', continuation: '  ' },
    })
    this.editor.onSubmit = value => { void this.submit(value, false) }
    this.maskedInput.onSubmit = value => { void this.submit(value, true) }
    this.ui.addChild(this.transcript)
    this.ui.addChild(new Spacer(1))
    this.ui.addChild(this.status)
    this.ui.addChild(this.interruptNotice)
    this.inputSlot.addChild(this.editor)
    this.ui.addChild(this.inputSlot)
    this.ui.setFocus(this.editor)
    this.removeInputListener = this.ui.addInputListener(data => {
      if (matchesKey(data, Key.ctrl('c'))) {
        if (this.pendingQuestion?.mode === 'secret') {
          this.clearExitWarning()
          this.cancelPending(new SecretInputCancelledError())
        } else if (this.exitArmed) {
          this.options.onExit?.()
        } else {
          this.exitArmed = true
          this.interruptNotice.setText(this.theme.warning('Activity stopped. Press Ctrl+C again to exit the installer.'))
          this.requestRender()
          const interrupt = this.cancellationHandler ?? this.options.onInterrupt
          if (interrupt !== undefined) {
            try {
              void Promise.resolve(interrupt()).catch(() => {
                this.interruptNotice.setText(this.theme.error('The activity did not stop cleanly. Press Ctrl+C again to exit the installer.'))
                this.requestRender()
              })
            } catch {
              this.interruptNotice.setText(this.theme.error('The activity did not stop cleanly. Press Ctrl+C again to exit the installer.'))
              this.requestRender()
            }
          }
        }
        return { consume: true }
      }
      this.clearExitWarning()
      return undefined
    })
  }

  start(): void {
    if (this.started) return
    if (this.stopped) throw new Error('cannot restart a disposed Machtiani Installer TUI')
    this.started = true
    this.terminal.setTitle(this.options.title ?? 'Machtiani Installer')
    this.ui.start()
    this.appendBanner()
    this.requestRender()
  }

  addAssistant(message: string): void {
    this.addRole('Machtiani', message)
  }

  addUser(message: string): void {
    this.addRole('You', message)
  }

  addReasoning(message: string): void {
    this.transcript.addChild(new Spacer(1))
    this.transcript.addChild(new Text(this.theme.italic(this.theme.dim('Reasoning')), 0, 0))
    this.transcript.addChild(new Markdown(displayText(message), 0, 0, this.markdown, {
      color: this.theme.dim,
      italic: true,
    }))
    this.requestRender()
  }

  setProgress(message: string | undefined): void {
    if (message === undefined) {
      this.progressMessage = undefined
      this.progressFrame = 0
      if (this.progressTimer !== undefined) clearInterval(this.progressTimer)
      this.progressTimer = undefined
      this.status.setText('')
    } else {
      const nextMessage = displayText(message)
      if (nextMessage !== this.progressMessage) this.progressFrame = 0
      this.progressMessage = nextMessage
      this.renderProgress()
      if (this.progressTimer === undefined) {
        this.progressTimer = setInterval(() => {
          this.progressFrame += 1
          this.renderProgress()
        }, 240)
        this.progressTimer.unref()
      }
    }
    this.terminal.setProgress(message !== undefined)
    this.requestRender()
  }

  beginTool(name: string, detail: string): ToolActivity {
    const row = new Text(this.theme.warning(`◌ ${displayText(name)}  ${displayText(detail)}`), 0, 0)
    this.transcript.addChild(new Spacer(1))
    this.transcript.addChild(row)
    this.requestRender()
    let settled = false
    const settle = (kind: 'success' | 'error', summary?: string): void => {
      if (settled) return
      settled = true
      const marker = kind === 'success' ? '✓' : '×'
      const paint = kind === 'success' ? this.theme.success : this.theme.error
      row.setText(paint(`${marker} ${displayText(name)}${summary === undefined ? '' : `  ${displayText(summary)}`}`))
      this.requestRender()
    }
    return {
      succeed: summary => { settle('success', summary) },
      fail: summary => { settle('error', summary) },
    }
  }

  /** Temporarily make Ctrl+C cancel a setup interaction instead of the installer. */
  beginCancellationScope(onCancel: () => void): InstallerInteractionHandle {
    if (this.cancellationHandler !== undefined) throw new Error('a cancellable installer interaction is already active')
    let active = true
    this.cancellationHandler = onCancel
    return {
      close: () => {
        if (!active) return
        active = false
        if (this.cancellationHandler === onCancel) this.cancellationHandler = undefined
      },
    }
  }

  /** Hide ordinary input while an external browser or device-code action is pending. */
  beginExternalWait(message: string): InstallerInteractionHandle {
    if (this.pendingQuestion !== undefined) throw new Error('cannot wait externally while an installer question is active')
    if (this.externalWaitLabel !== undefined) throw new Error('an external installer action is already pending')
    const label = new Text(this.theme.dim(`${displayText(message)}  Ctrl+C to cancel sign-in`), 1, 0)
    this.externalWaitLabel = label
    this.inputSlot.removeChild(this.editor)
    this.inputSlot.addChild(label)
    this.ui.setFocus(null)
    this.requestRender()
    let active = true
    return {
      close: () => {
        if (!active) return
        active = false
        if (this.externalWaitLabel !== label) return
        this.inputSlot.removeChild(label)
        this.externalWaitLabel = undefined
        this.inputSlot.addChild(this.editor)
        this.ui.setFocus(this.editor)
        this.requestRender()
      },
    }
  }

  ask(question: InstallerQuestion): Promise<string> {
    if (this.pendingQuestion !== undefined) {
      return Promise.reject(new Error('the installer supports exactly one active question'))
    }
    if (this.externalWaitLabel !== undefined) return Promise.reject(new Error('an external installer action is pending'))
    if (question.signal?.aborted === true) return Promise.reject(new Error('the installer question was withdrawn'))
    const suffix = question.options === undefined || question.options.length === 0
      ? ''
      : `\n\n${question.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
    this.addAssistant(question.message + suffix)
    return new Promise<string>((resolve, reject) => {
      this.setPending('text', resolve, reject, question.signal)
    })
  }

  askSecret(message: string): Promise<string> {
    if (this.pendingQuestion !== undefined) {
      return Promise.reject(new Error('the installer supports exactly one active question'))
    }
    this.addAssistant(message)
    return this.captureSecret()
  }

  /** Switch to transcript-free masked input after the agent presented its prompt. */
  captureSecret(
    signal?: AbortSignal,
    label = 'Secure API key — input hidden',
    cancellationHint = 'Ctrl+C to cancel key entry',
  ): Promise<string> {
    if (this.pendingQuestion !== undefined) {
      return Promise.reject(new Error('the installer supports exactly one active question'))
    }
    if (this.externalWaitLabel !== undefined) return Promise.reject(new Error('an external installer action is pending'))
    if (signal?.aborted === true) return Promise.reject(new Error('the installer question was withdrawn'))
    this.secureInputLabel.setText(
      `${this.theme.bold(this.theme.accent(`🔒  ${displayText(label)}`))}  ${this.theme.dim(displayText(cancellationHint))}`,
    )
    this.suspendedProgressMessage = this.progressMessage
    this.setProgress(undefined)
    this.inputSlot.removeChild(this.editor)
    this.inputSlot.addChild(this.secureInputLabel)
    this.inputSlot.addChild(this.maskedInput)
    this.ui.setFocus(this.maskedInput)
    this.requestRender()
    return new Promise<string>((resolve, reject) => {
      this.setPending('secret', resolve, reject, signal)
    })
  }

  choose(
    message: string,
    choices: readonly InstallerChoice[],
    selectedValue?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.pendingQuestion !== undefined) {
      return Promise.reject(new Error('the installer supports exactly one active question'))
    }
    if (this.externalWaitLabel !== undefined) return Promise.reject(new Error('an external installer action is pending'))
    if (choices.length === 0) return Promise.reject(new Error('the installer choice list is empty'))
    if (signal?.aborted === true) return Promise.reject(new Error('the installer question was withdrawn'))
    this.addAssistant(message)
    this.setProgress(undefined)
    this.inputSlot.removeChild(this.editor)
    const input = new ChoiceInput(choices, selectedValue, 9, this.theme)
    this.choiceInput = input
    this.inputSlot.addChild(input)
    this.ui.setFocus(input)
    this.requestRender()
    return new Promise<string>((resolve, reject) => {
      this.setPending('choice', resolve, reject, signal)
      input.onSubmit = choice => {
        if (this.pendingQuestion?.mode !== 'choice' || this.choiceInput !== input) return
        this.removePendingAbortListener(this.pendingQuestion)
        this.pendingQuestion = undefined
        this.deactivateChoiceInput()
        this.addUser(choice.label)
        resolve(choice.value)
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.stopped) return
    if (this.started) {
      this.ui.requestRender(true)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    this.stopped = true
    if (this.progressTimer !== undefined) clearInterval(this.progressTimer)
    this.progressTimer = undefined
    this.progressMessage = undefined
    this.suspendedProgressMessage = undefined
    this.cancellationHandler = undefined
    this.clearExitWarning()
    if (this.externalWaitLabel !== undefined) this.inputSlot.removeChild(this.externalWaitLabel)
    this.externalWaitLabel = undefined
    const pending = this.pendingQuestion
    this.pendingQuestion = undefined
    if (pending !== undefined) this.removePendingAbortListener(pending)
    this.maskedInput.clear()
    pending?.reject(new Error('the installer closed before the question was answered'))
    this.removeInputListener()
    this.terminal.setProgress(false)
    this.terminal.setTitle('')
    await this.terminal.drainInput(100, 20)
    if (this.started) this.ui.stop()
  }

  private appendBanner(): void {
    const title = this.theme.bold(this.theme.accent('MACHTIANI INSTALLER'))
    this.transcript.addChild(new Text(title, 1, 0))
    this.transcript.addChild(new Text(this.theme.dim('A guided setup for Dear Machine'), 1, 0))
  }

  private addRole(role: string, message: string): void {
    this.transcript.addChild(new Spacer(1))
    this.transcript.addChild(new Text(this.theme.bold(this.theme.accent(role)), 0, 0))
    this.transcript.addChild(new Markdown(displayText(message), 0, 0, this.markdown, undefined, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
    }))
    this.requestRender()
  }

  private async submit(value: string, secret: boolean): Promise<void> {
    const text = secret ? value : value.trim()
    if (text === '') return
    const pending = this.pendingQuestion
    if (pending?.mode === 'choice') return
    if (pending !== undefined && (pending.mode === 'secret') !== secret) return
    if (secret) {
      if (pending === undefined) return
      this.removePendingAbortListener(pending)
      this.pendingQuestion = undefined
      this.deactivateSecretInput()
      pending.resolve(text)
      return
    }
    this.editor.addToHistory(text)
    this.editor.setText('')
    this.addUser(text)
    if (pending !== undefined) {
      this.removePendingAbortListener(pending)
      this.pendingQuestion = undefined
      pending.resolve(text)
      return
    }
    await this.options.onSubmit?.(text)
  }

  private deactivateSecretInput(): void {
    this.maskedInput.clear()
    this.inputSlot.removeChild(this.maskedInput)
    this.inputSlot.removeChild(this.secureInputLabel)
    this.inputSlot.addChild(this.editor)
    this.ui.setFocus(this.editor)
    const resumeProgress = this.suspendedProgressMessage
    this.suspendedProgressMessage = undefined
    if (resumeProgress !== undefined) this.setProgress(resumeProgress)
    this.requestRender()
  }

  private deactivateChoiceInput(): void {
    const input = this.choiceInput
    if (input !== undefined) this.inputSlot.removeChild(input)
    this.choiceInput = undefined
    this.inputSlot.addChild(this.editor)
    this.ui.setFocus(this.editor)
    this.requestRender()
  }

  private setPending(
    mode: 'text' | 'secret' | 'choice',
    resolve: (value: string) => void,
    reject: (error: Error) => void,
    signal: AbortSignal | undefined,
  ): void {
    const pending: NonNullable<InstallerTui['pendingQuestion']> = { resolve, reject, mode }
    this.pendingQuestion = pending
    if (signal !== undefined) {
      pending.signal = signal
      pending.onAbort = () => { this.cancelPending(new Error('the installer question was withdrawn')) }
      signal.addEventListener('abort', pending.onAbort, { once: true })
      if (signal.aborted) this.cancelPending(new Error('the installer question was withdrawn'))
    }
  }

  private cancelPending(error: Error): void {
    const pending = this.pendingQuestion
    if (pending === undefined) return
    this.pendingQuestion = undefined
    this.removePendingAbortListener(pending)
    if (pending.mode === 'secret') this.deactivateSecretInput()
    if (pending.mode === 'choice') this.deactivateChoiceInput()
    pending.reject(error)
  }

  private removePendingAbortListener(pending: NonNullable<InstallerTui['pendingQuestion']>): void {
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
  }

  private requestRender(): void {
    if (!this.started || this.stopped) return
    const prompt = '› '
    this.editor.setPrompt({ first: prompt, continuation: ' '.repeat(visibleWidth(prompt)) })
    this.ui.requestRender()
  }

  private clearExitWarning(): void {
    this.exitArmed = false
    this.interruptNotice.setText('')
    this.requestRender()
  }

  private renderProgress(): void {
    const message = this.progressMessage
    if (message === undefined) return
    const frames = ['◌', '◔', '◑', '◕', '●', '◕', '◑', '◔'] as const
    const marker = frames[this.progressFrame % frames.length]
    this.status.setText(this.theme.dim(`${marker} ${message}`))
    this.requestRender()
  }
}

export function assertInteractiveTerminal(
  stdin: Pick<NodeJS.ReadStream, 'isTTY'> = process.stdin,
  stdout: Pick<NodeJS.WriteStream, 'isTTY'> = process.stdout,
): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Machtiani Installer needs an interactive terminal. Open a terminal and run the installer again.')
  }
}

export { displayText } from './text.ts'
export { createInstallerTheme } from './theme.ts'
export type { InstallerChoice } from './choice-input.ts'

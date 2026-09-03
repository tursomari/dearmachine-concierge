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

export interface InstallerQuestion {
  message: string
  options?: readonly string[]
}

export interface InstallerTuiOptions {
  terminal?: Terminal
  title?: string
  color?: boolean
  onSubmit?(text: string): void | Promise<void>
  onCancel?(): void
  onExit?(): void
}

export interface ToolActivity {
  succeed(summary?: string): void
  fail(summary: string): void
}

export class InstallerTui {
  private readonly terminal: Terminal
  private readonly ui: TUI
  private readonly transcript = new Container()
  private readonly status = new Text('', 0, 0)
  private readonly editor: Editor
  private readonly maskedInput = new MaskedInput()
  private readonly inputSlot = new Container()
  private readonly theme: InstallerTheme
  private readonly markdown
  private readonly removeInputListener: () => void
  private pendingQuestion: {
    resolve(value: string): void
    reject(error: Error): void
    secret: boolean
  } | undefined
  private started = false
  private stopped = false

  constructor(private readonly options: InstallerTuiOptions = {}) {
    this.terminal = options.terminal ?? new ProcessTerminal()
    this.theme = createInstallerTheme(options.color ?? true)
    this.markdown = markdownTheme(this.theme)
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
    this.inputSlot.addChild(this.editor)
    this.ui.addChild(this.inputSlot)
    this.ui.setFocus(this.editor)
    this.removeInputListener = this.ui.addInputListener(data => {
      if (matchesKey(data, Key.ctrl('c'))) {
        if (this.pendingQuestion !== undefined) {
          const pending = this.pendingQuestion
          this.pendingQuestion = undefined
          if (pending.secret) this.deactivateSecretInput()
          pending.reject(new Error('the installer question was cancelled'))
          this.options.onCancel?.()
        } else if (this.editor.getText() !== '') {
          this.editor.setText('')
        } else {
          this.options.onExit?.()
        }
        return { consume: true }
      }
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
    this.status.setText(message === undefined ? '' : this.theme.dim(`◌ ${displayText(message)}`))
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

  ask(question: InstallerQuestion): Promise<string> {
    if (this.pendingQuestion !== undefined) {
      return Promise.reject(new Error('the installer supports exactly one active question'))
    }
    const suffix = question.options === undefined || question.options.length === 0
      ? ''
      : `\n\n${question.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
    this.addAssistant(question.message + suffix)
    return new Promise<string>((resolve, reject) => {
      this.pendingQuestion = { resolve, reject, secret: false }
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
  captureSecret(): Promise<string> {
    if (this.pendingQuestion !== undefined) {
      return Promise.reject(new Error('the installer supports exactly one active question'))
    }
    this.inputSlot.removeChild(this.editor)
    this.inputSlot.addChild(this.maskedInput)
    this.ui.setFocus(this.maskedInput)
    this.requestRender()
    return new Promise<string>((resolve, reject) => {
      this.pendingQuestion = { resolve, reject, secret: true }
    })
  }

  async dispose(): Promise<void> {
    if (this.stopped) return
    if (this.started) {
      this.ui.requestRender(true)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    this.stopped = true
    const pending = this.pendingQuestion
    this.pendingQuestion = undefined
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
    if (pending !== undefined && pending.secret !== secret) return
    if (secret) {
      if (pending === undefined) return
      this.pendingQuestion = undefined
      this.deactivateSecretInput()
      pending.resolve(text)
      return
    }
    this.editor.addToHistory(text)
    this.editor.setText('')
    this.addUser(text)
    if (pending !== undefined) {
      this.pendingQuestion = undefined
      pending.resolve(text)
      return
    }
    await this.options.onSubmit?.(text)
  }

  private deactivateSecretInput(): void {
    this.maskedInput.clear()
    this.inputSlot.removeChild(this.maskedInput)
    this.inputSlot.addChild(this.editor)
    this.ui.setFocus(this.editor)
    this.requestRender()
  }

  private requestRender(): void {
    if (!this.started || this.stopped) return
    const prompt = '› '
    this.editor.setPrompt({ first: prompt, continuation: ' '.repeat(visibleWidth(prompt)) })
    this.ui.requestRender()
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

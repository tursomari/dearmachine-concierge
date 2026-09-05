import { afterEach, describe, expect, it } from 'vitest'
import { InstallerChoiceBackError, InstallerTui, assertInteractiveTerminal } from '../src/index.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

const open = async (
  columns = 80,
  rows = 24,
  onExit?: () => void,
  onInterrupt?: () => void | Promise<void>,
): Promise<{
  terminal: HeadlessTerminal
  tui: InstallerTui
}> => {
  const terminal = new HeadlessTerminal(columns, rows)
  const tui = new InstallerTui({
    terminal,
    color: false,
    ...(onExit === undefined ? {} : { onExit }),
    ...(onInterrupt === undefined ? {} : { onInterrupt }),
  })
  tui.start()
  await terminal.waitForFrame()
  return { terminal, tui }
}

const opened: Array<{ terminal: HeadlessTerminal; tui: InstallerTui }> = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async ({ tui, terminal }) => {
    await tui.dispose()
    await terminal.dispose()
  }))
})

describe('Machtiani Installer TUI', () => {
  it.each([
    [80, 24],
    [48, 12],
  ])('renders branded welcome and a question at %ix%i', async (columns, rows) => {
    const harness = await open(columns, rows)
    opened.push(harness)
    void harness.tui.ask({
      message: 'Welcome to Dear Machine. Would you like to continue with the installation now?',
      options: ['Yes', 'Not now'],
    }).catch(() => {})
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot()).toMatchSnapshot()
    expect(harness.terminal.themeViolations()).toEqual([])
  })

  it('returns one editor answer without exposing hidden input machinery', async () => {
    const harness = await open()
    opened.push(harness)
    const answer = harness.tui.ask({ message: 'Which LLM provider would you like Machtiani to use?' })
    harness.terminal.send('OpenRouter')
    harness.terminal.send('\r')
    await expect(answer).resolves.toBe('OpenRouter')
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot()).toContain('OpenRouter')
  })

  it('filters and selects wizard choices without model interpretation', async () => {
    const harness = await open()
    opened.push(harness)
    const answer = harness.tui.choose('Choose the installer model provider.', [
      { value: 'openrouter', label: 'OpenRouter', description: 'Many hosted models' },
      { value: 'deepseek', label: 'DeepSeek', description: 'DeepSeek models' },
    ])
    await harness.terminal.waitForFrame()
    const initial = await harness.terminal.snapshot()
    expect(initial).toContain('Filter:')
    expect(initial).toContain('OpenRouter')
    expect(initial).toContain('DeepSeek')
    harness.terminal.send('deep')
    harness.terminal.send('\r')
    await expect(answer).resolves.toBe('deepseek')
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot({ includeScrollback: true })).toContain('DeepSeek')
  })

  it('clears a nonempty menu filter before Escape navigates back', async () => {
    const harness = await open()
    opened.push(harness)
    const answer = harness.tui.choose('Choose one.', [
      { value: 'one', label: 'One' },
      { value: 'two', label: 'Two' },
    ])
    harness.terminal.send('two')
    harness.terminal.send('\x1b')
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot()).toContain('One')
    harness.terminal.send('\x1b')
    await expect(answer).rejects.toBeInstanceOf(InstallerChoiceBackError)

    const next = harness.tui.choose('Choose again.', [{ value: 'one', label: 'One' }])
    harness.terminal.send('\r')
    await expect(next).resolves.toBe('one')
  })

  it.each([
    [80, 24],
    [48, 12],
  ])('lays out a searchable wizard choice at %ix%i', async (columns, rows) => {
    const harness = await open(columns, rows)
    opened.push(harness)
    void harness.tui.choose('Choose the AI service for this installation assistant.', [
      { value: 'openrouter', label: 'OpenRouter', description: 'subscription sign-in or API credentials' },
      { value: 'deepseek', label: 'DeepSeek', description: 'API credentials' },
      { value: 'openai-codex', label: 'OpenAI Codex', description: 'subscription sign-in' },
    ]).catch(() => {})
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot()).toMatchSnapshot()
  })

  it.each([
    [80, 24],
    [48, 12],
  ])('fits custom provider labels at %ix%i', async (columns, rows) => {
    const harness = await open(columns, rows)
    opened.push(harness)
    void harness.tui.choose('Choose the AI service.', [
      { value: 'custom-openai-remote', label: 'Custom OpenAI-compatible provider (remote)', description: 'Your HTTPS Chat Completions endpoint' },
      { value: 'custom-openai-local', label: 'Custom OpenAI-compatible provider (local)', description: 'A model server on this machine' },
    ]).catch(() => {})
    await harness.terminal.waitForFrame()
    const snapshot = await harness.terminal.snapshot()
    expect(snapshot).toContain('Custom OpenAI-compatible provider (remote)')
    expect(snapshot).toContain('Custom OpenAI-compatible provider (local)')
  })

  it('withdraws a wizard choice when its provider flow finishes elsewhere', async () => {
    const harness = await open()
    opened.push(harness)
    const controller = new AbortController()
    const answer = harness.tui.choose('Choose one.', [
      { value: 'one', label: 'One' },
      { value: 'two', label: 'Two' },
    ], undefined, controller.signal)
    controller.abort()
    await expect(answer).rejects.toThrow('withdrawn')
    const ordinary = harness.tui.ask({ message: 'Continue?' })
    harness.terminal.send('yes')
    harness.terminal.send('\r')
    await expect(ordinary).resolves.toBe('yes')
  })

  it('suppresses ordinary input and scopes Ctrl+C while device sign-in is pending', async () => {
    let exits = 0
    let cancellations = 0
    const harness = await open(48, 12, () => { exits += 1 })
    opened.push(harness)
    const cancellation = harness.tui.beginCancellationScope(() => { cancellations += 1 })
    const waiting = harness.tui.beginExternalWait('Waiting for browser sign-in…')
    harness.terminal.send('ignored input')
    harness.terminal.send('\r')
    await harness.terminal.waitForFrame()
    const pending = await harness.terminal.snapshot({ includeScrollback: true })
    expect(pending).toContain('Waiting for browser sign-in')
    expect(pending).toContain('Ctrl+C to cancel ')
    expect(pending).toContain(' sign-in ')
    expect(pending).not.toContain('ignored input')
    harness.terminal.send('\x03')
    expect(cancellations).toBe(1)
    expect(exits).toBe(0)
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot()).toContain('Press Ctrl+C again to exit')
    waiting.close()
    cancellation.close()
    const ordinary = harness.tui.ask({ message: 'Continue?' })
    harness.terminal.send('yes')
    harness.terminal.send('\r')
    await expect(ordinary).resolves.toBe('yes')
  })

  it('accepts bracketed-paste secret input without rendering or transcribing it', async () => {
    const harness = await open()
    opened.push(harness)
    harness.tui.setProgress('Machtiani is working')
    const secret = 'credential-value-that-must-stay-private'
    const answer = harness.tui.askSecret('Paste the API key and press Enter.')
    harness.terminal.send(`\x1b[200~${secret}\x1b[201~`)
    await harness.terminal.waitForFrame()
    const masked = await harness.terminal.snapshot()
    expect(masked).toContain('Secure API key — input hidden')
    expect(masked).toContain('Ctrl+C to cancel key entry')
    expect(masked).not.toContain('Machtiani is working')
    expect(masked).toContain('••••')
    expect(masked).not.toContain(secret)
    harness.terminal.send('\r')
    await expect(answer).resolves.toBe(secret)
    await harness.terminal.waitForFrame()
    const resumed = await harness.terminal.snapshot({ includeScrollback: true })
    expect(resumed).not.toContain(secret)
    expect(resumed).toContain('Machtiani is working')
  })

  it('labels a browser authorization code as secure and keeps it out of the transcript', async () => {
    const harness = await open()
    opened.push(harness)
    const code = 'short-lived-authorization-code'
    harness.tui.addAssistant('Paste the authorization code from Claude and press Enter.')
    const answer = harness.tui.captureSecret(undefined, 'Secure sign-in code — input hidden', 'Ctrl+C to cancel sign-in')
    harness.terminal.send(code)
    await harness.terminal.waitForFrame()
    const masked = await harness.terminal.snapshot()
    expect(masked).toContain('Secure sign-in code — input hidden')
    expect(masked).toContain('Ctrl+C to cancel sign-in')
    expect(masked).not.toContain(code)
    harness.terminal.send('\r')
    await expect(answer).resolves.toBe(code)
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot({ includeScrollback: true })).not.toContain(code)
  })

  it('clears a masked value when secret entry is cancelled', async () => {
    let exits = 0
    const harness = await open(80, 24, () => { exits += 1 })
    opened.push(harness)
    const secret = 'cancelled-private-value'
    const answer = harness.tui.askSecret('Paste the API key and press Enter.')
    harness.terminal.send(secret)
    harness.terminal.send('\x03')
    await expect(answer).rejects.toThrow('cancelled')
    expect(exits).toBe(0)
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot()).not.toContain('Press Ctrl+C again to exit')
    const ordinary = harness.tui.ask({ message: 'Continue?' })
    harness.terminal.send('yes')
    harness.terminal.send('\r')
    await expect(ordinary).resolves.toBe('yes')
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot({ includeScrollback: true })).not.toContain(secret)
  })

  it('renders tool progress and settles it without leaving terminal progress active', async () => {
    const harness = await open()
    opened.push(harness)
    harness.tui.setProgress('Inspecting this computer')
    await harness.terminal.waitForFrame()
    const firstProgress = await harness.terminal.snapshot()
    expect(firstProgress).toContain('Inspecting this computer')
    expect(firstProgress).not.toMatch(/[◌◔◑◕●] Inspecting this computer/u)
    await new Promise(resolve => setTimeout(resolve, 650))
    await harness.terminal.waitForFrame()
    const nextProgress = await harness.terminal.snapshot()
    expect(nextProgress).not.toBe(firstProgress)
    const activity = harness.tui.beginTool('Environment check', 'read-only')
    await harness.terminal.waitForFrame()
    expect(harness.terminal.progress).toBe(true)
    activity.succeed('ready')
    harness.tui.setProgress(undefined)
    await harness.terminal.waitForFrame()
    const snapshot = await harness.terminal.snapshot()
    expect(snapshot).toContain('✓ Environment check  ready')
    expect(harness.terminal.progress).toBe(false)
  })

  it('recesses routine tool activity while keeping failures prominent', async () => {
    const terminal = new HeadlessTerminal()
    const tui = new InstallerTui({ terminal, color: true, environment: { TERM: 'xterm-256color' } })
    const harness = { terminal, tui }
    opened.push(harness)
    tui.start()
    await terminal.waitForFrame()

    const successful = tui.beginTool('Read configuration', 'Working')
    await terminal.waitForFrame()
    let snapshot = await terminal.snapshot({ includeScrollback: true })
    expect(snapshot).toContain('◌ Read configuration  Working')
    expect(snapshot).toMatch(/style .* dim/u)
    expect(snapshot).not.toContain('fg=yellow')

    successful.succeed('Done')
    const failed = tui.beginTool('Backend check', 'Working')
    failed.fail('Failed')
    await terminal.waitForFrame()
    snapshot = await terminal.snapshot({ includeScrollback: true })
    expect(snapshot).toContain('✓ Read configuration  Done')
    expect(snapshot).toContain('× Backend check  Failed')
    expect(snapshot).toContain('fg=red')
  })

  it('interrupts first, warns, and exits only on a second Ctrl-C', async () => {
    const terminal = new HeadlessTerminal()
    let exits = 0
    let interrupts = 0
    const tui = new InstallerTui({
      terminal,
      color: false,
      onInterrupt: () => { interrupts += 1 },
      onExit: () => { exits += 1 },
    })
    tui.start()
    await terminal.waitForFrame()
    const answer = tui.ask({ message: 'Continue?' })
    const closed = expect(answer).rejects.toThrow('closed')
    terminal.send('\x03')
    expect(interrupts).toBe(1)
    expect(exits).toBe(0)
    await terminal.waitForFrame()
    expect(await terminal.snapshot()).toContain('Activity stopped. Press Ctrl+C again to exit the installer.')
    terminal.send('\x03')
    expect(exits).toBe(1)
    await tui.dispose()
    await closed
    expect(terminal.started).toBe(1)
    expect(terminal.stopped).toBe(1)
    expect(terminal.lifecycle).toEqual(['start', 'drain:100:20', 'stop'])
    expect(terminal.progress).toBe(false)
    expect(terminal.title).toBe('')
    await terminal.dispose()
  })

  it('disarms the exit warning when the user resumes typing', async () => {
    let exits = 0
    let interrupts = 0
    const harness = await open(80, 24, () => { exits += 1 }, () => { interrupts += 1 })
    opened.push(harness)
    harness.terminal.send('\x03')
    harness.terminal.send('continue')
    harness.terminal.send('\x03')
    expect(interrupts).toBe(2)
    expect(exits).toBe(0)
  })

  it('fails early with an actionable message without a TTY', () => {
    expect(() => { assertInteractiveTerminal({ isTTY: false } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream) })
      .toThrow('Open a terminal and run the installer again')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { InstallerTui, assertInteractiveTerminal } from '../src/index.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

const open = async (columns = 80, rows = 24): Promise<{
  terminal: HeadlessTerminal
  tui: InstallerTui
}> => {
  const terminal = new HeadlessTerminal(columns, rows)
  const tui = new InstallerTui({ terminal, color: false })
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

  it('accepts bracketed-paste secret input without rendering or transcribing it', async () => {
    const harness = await open()
    opened.push(harness)
    const secret = 'credential-value-that-must-stay-private'
    const answer = harness.tui.askSecret('Paste the API key and press Enter.')
    harness.terminal.send(`\x1b[200~${secret}\x1b[201~`)
    await harness.terminal.waitForFrame()
    const masked = await harness.terminal.snapshot()
    expect(masked).toContain('••••')
    expect(masked).not.toContain(secret)
    harness.terminal.send('\r')
    await expect(answer).resolves.toBe(secret)
    await harness.terminal.waitForFrame()
    expect(await harness.terminal.snapshot({ includeScrollback: true })).not.toContain(secret)
  })

  it('clears a masked value when secret entry is cancelled', async () => {
    const harness = await open()
    opened.push(harness)
    const secret = 'cancelled-private-value'
    const answer = harness.tui.askSecret('Paste the API key and press Enter.')
    harness.terminal.send(secret)
    harness.terminal.send('\x03')
    await expect(answer).rejects.toThrow('cancelled')
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
    harness.tui.setProgress('Inspecting this computer…')
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

  it('cancels a pending question and restores terminal state', async () => {
    const terminal = new HeadlessTerminal()
    let cancelled = 0
    const tui = new InstallerTui({ terminal, color: false, onCancel: () => { cancelled += 1 } })
    tui.start()
    await terminal.waitForFrame()
    const answer = tui.ask({ message: 'Continue?' })
    terminal.send('\x03')
    await expect(answer).rejects.toThrow('cancelled')
    expect(cancelled).toBe(1)
    await tui.dispose()
    expect(terminal.started).toBe(1)
    expect(terminal.stopped).toBe(1)
    expect(terminal.lifecycle).toEqual(['start', 'drain:100:20', 'stop'])
    expect(terminal.progress).toBe(false)
    expect(terminal.title).toBe('')
    await terminal.dispose()
  })

  it('fails early with an actionable message without a TTY', () => {
    expect(() => { assertInteractiveTerminal({ isTTY: false } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream) })
      .toThrow('Open a terminal and run the installer again')
  })
})

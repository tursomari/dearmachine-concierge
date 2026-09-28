import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstallerTui } from '../src/index.ts'
import { HeadlessTerminal } from './headless-terminal.ts'
const opened: { tui: InstallerTui; terminal: HeadlessTerminal }[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(opened.splice(0).map(async ({ tui, terminal }) => { await tui.dispose(); await terminal.dispose() }))
})
async function fixture() {
  const terminal = new HeadlessTerminal()
  const local = vi.fn().mockResolvedValue(undefined)
  const exit = vi.fn()
  const submit = vi.fn()
  const tui = new InstallerTui({ terminal, color: false, title: 'Dear Machine Concierge', onLocalCommand: local, onExit: exit, onSubmit: submit, exitWindowMs: 2_000 })
  opened.push({ tui, terminal })
  tui.start()
  await terminal.waitForFrame()
  return { tui, terminal, local, exit, submit }
}
describe('concierge terminal commands', () => {
  it('shows a visual-only prompt placeholder while input is empty', async () => {
    const terminal = new HeadlessTerminal()
    const submit = vi.fn()
    const tui = new InstallerTui({
      terminal,
      title: 'Dear Machine Concierge',
      environment: { TERM: 'xterm' },
      inputPlaceholder: 'Enter a prompt or /help',
      onSubmit: submit,
    })
    opened.push({ tui, terminal })
    tui.start()
    await terminal.waitForFrame()
    let screen = await terminal.snapshot()
    expect(screen).toContain('Enter a prompt or /help')
    const placeholderRow = screen.split('\n').findIndex(line => line.includes('Enter a prompt or /help'))
    expect(screen.split('\n').slice(placeholderRow + 1, placeholderRow + 4).some(line => line.includes('dim'))).toBe(true)

    terminal.send('\r')
    expect(submit).not.toHaveBeenCalled()

    terminal.send('hello')
    await terminal.waitForFrame()
    screen = await terminal.snapshot()
    expect(screen).toContain('hello')
    expect(screen).not.toContain('Enter a prompt or /help')

    for (let index = 0; index < 5; index += 1) terminal.send('\x7f')
    await terminal.waitForFrame()
    expect(await terminal.snapshot()).toContain('Enter a prompt or /help')

    terminal.send('\r')
    expect(submit).not.toHaveBeenCalled()
    terminal.send('actual prompt')
    terminal.send('\r')
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith('actual prompt'))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('invites conversation and renders command details as subdued literal text', async () => {
    const terminal = new HeadlessTerminal()
    const tui = new InstallerTui({ terminal, title: 'Dear Machine Concierge', environment: { TERM: 'xterm' } })
    opened.push({ tui, terminal })
    tui.start()
    tui.addCommand('printf "**literal**"\n\x1b[31mdearmachine status')
    await terminal.waitForFrame()
    const screen = await terminal.snapshot()
    expect(screen).toContain('Ask a question or tell me what you need')
    expect(screen).toContain('**literal**')
    expect(screen).toContain('␛[31mdearmachine status')
    expect(screen).toContain('dim')
    expect(screen).not.toContain('fg=red')
  })
  it('labels replies with the configured assistant role and aligns the banner flush left', async () => {
    const terminal = new HeadlessTerminal()
    const tui = new InstallerTui({ terminal, color: false, title: 'Dear Machine Concierge', assistantLabel: 'Concierge', environment: { TERM: 'xterm' } })
    opened.push({ tui, terminal })
    tui.start()
    tui.addAssistant('Dear Machine is running.')
    await terminal.waitForFrame()
    const lines = (await terminal.snapshot()).split('\n')
    expect(lines.some(line => line.includes('"DEAR MACHINE CONCIERGE'))).toBe(true)
    expect(lines.some(line => line.includes('"Ask a question or tell me what you need'))).toBe(true)
    expect(lines.some(line => line.includes('"Concierge '))).toBe(true)
    expect(lines.some(line => line.includes('"Machtiani '))).toBe(false)
  })
  it('routes slash input before an ordinary question without resolving it', async () => {
    const { tui, terminal, local, submit } = await fixture()
    const answer = tui.ask({ message: 'Question' })
    terminal.send('/help')
    terminal.send('\r')
    await vi.waitFor(() => expect(local).toHaveBeenCalledWith('/help'))
    terminal.send('answer')
    terminal.send('\r')
    await expect(answer).resolves.toBe('answer')
    expect(submit).not.toHaveBeenCalled()
  })
  it('makes help available during the provider choice without accepting or dismissing it', async () => {
    const { tui, terminal, local } = await fixture()
    const answer = tui.choose('Provider', [{ value: 'fixture', label: 'Fixture' }])
    terminal.send('/help')
    terminal.send('\r')
    await vi.waitFor(() => expect(local).toHaveBeenCalledWith('/help'))
    terminal.send('\r')
    await expect(answer).resolves.toBe('fixture')
  })
  it('makes help available while browser sign-in is pending', async () => {
    const { tui, terminal, local, submit } = await fixture()
    const wait = tui.beginExternalWait('Sign in')
    terminal.send('/help')
    terminal.send('\r')
    await vi.waitFor(() => expect(local).toHaveBeenCalledWith('/help'))
    expect(submit).not.toHaveBeenCalled()
    wait.close()
  })
  it('restores the provider menu when a local command is cancelled', async () => {
    const { tui, terminal, local } = await fixture()
    const answer = tui.choose('Provider', [{ value: 'fixture', label: 'Fixture' }])
    void answer.catch(() => {})
    terminal.send('/')
    terminal.send('\x1b')
    terminal.send('\r')
    await expect(answer).resolves.toBe('fixture')
    expect(local).not.toHaveBeenCalled()
  })
  it('never interprets masked input as a slash command', async () => {
    const { tui, terminal, local } = await fixture()
    const secret = tui.captureSecret()
    terminal.send('/up')
    terminal.send('\r')
    await expect(secret).resolves.toBe('/up')
    expect(local).not.toHaveBeenCalled()
  })
  it('expires the second-interrupt window at two seconds', async () => {
    const { terminal, exit } = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    terminal.send('\x03')
    vi.setSystemTime(2_000)
    terminal.send('\x03')
    expect(exit).not.toHaveBeenCalled()
    vi.setSystemTime(2_100)
    terminal.send('\x03')
    expect(exit).toHaveBeenCalledOnce()
  })
})

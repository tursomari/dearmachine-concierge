import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { HeadlessTerminal } from '../../tui/tests/headless-terminal.ts'
import { ConciergeActivityIndicator } from '../src/concierge-activity.ts'
import { authenticateClaudeBackend } from '../src/backend-auth.ts'

afterEach(() => vi.unstubAllEnvs())

async function fixture(authenticated = true) {
  const home = await mkdtemp(join(tmpdir(), 'backend-auth-'))
  const executable = join(home, 'claude')
  await writeFile(executable, `#!${process.execPath}
const fs = require('fs');
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN) process.exit(9);
if (process.argv[3] === 'status') console.log(JSON.stringify({loggedIn: ${authenticated} && fs.existsSync(process.env.CLAUDE_CONFIG_DIR + '/verified')}));
else { console.log('https://example.test/authorize'); console.log('Paste code here if prompted>');
process.stdin.once('data', code => { fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, {recursive:true}); fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/verified', code); process.exit(0); }); }
`, { mode: 0o700 })
  const terminal = new HeadlessTerminal(100, 35)
  const tui = new InstallerTui({ terminal, color: false })
  tui.start()
  const activity = new ConciergeActivityIndicator(tui)
  activity.status('running')
  const authenticate = (signal: AbortSignal) => activity.duringInteraction(() => authenticateClaudeBackend(tui, home, signal, executable))
  return { home, executable, terminal, tui, activity, authenticate, close: async () => { activity.dispose(); await tui.dispose(); await terminal.dispose(); await rm(home, { recursive: true, force: true }) } }
}

it.each([false, true])('uses a masked code and the backend profile (custom profile: %s)', async custom => {
  const f = await fixture()
  const profile = custom ? join(f.home, 'custom-claude') : join(f.home, '.claude')
  vi.stubEnv('CLAUDE_CONFIG_DIR', custom ? profile : '')
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(name, 'fixture-bypass')
  await writeFile(join(f.home, 'installer-profile.json'), '{"provider":"independent"}')
  try {
    const result = f.authenticate(new AbortController().signal)
    await expect.poll(async () => await f.terminal.snapshot()).toContain('Secure sign-in code')
    expect(await f.terminal.snapshot()).toContain('https://example.test/authorize')
    expect(f.terminal.progress).toBe(false)
    f.terminal.send('fixture-private-code')
    await f.terminal.waitForFrame()
    expect(await f.terminal.snapshot({ includeScrollback: true })).not.toContain('fixture-private-code')
    f.terminal.send('\r')
    await expect(result).resolves.toBeUndefined()
    // No new running status or tool event is needed to restore the installer footer.
    await expect.poll(async () => await f.terminal.snapshot()).toContain('processing')
    expect(f.terminal.progress).toBe(true)
    f.activity.status('idle')
    await expect.poll(async () => await f.terminal.snapshot()).not.toContain('processing')
    expect(f.terminal.progress).toBe(false)
    expect(await readFile(join(profile, 'verified'), 'utf8')).toBe('fixture-private-code\n')
    expect(await readFile(join(f.home, 'installer-profile.json'), 'utf8')).toBe('{"provider":"independent"}')
  } finally { await f.close() }
})

it('cancels sign-in while awaiting the code and returns control to the terminal', async () => {
  const f = await fixture()
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  const controller = new AbortController()
  try {
    const result = f.authenticate(controller.signal)
    const rejected = expect(result).rejects.toThrow()
    await expect.poll(async () => await f.terminal.snapshot()).toContain('Secure sign-in code')
    controller.abort()
    await rejected
    await expect.poll(async () => await f.terminal.snapshot()).toContain('processing')
    expect(f.terminal.progress).toBe(true)
    await expect(readFile(join(f.home, '.claude/verified'))).rejects.toMatchObject({ code: 'ENOENT' })
    const answer = f.tui.ask({ message: 'Continue?' })
    f.terminal.send('yes'); f.terminal.send('\r')
    await expect(answer).resolves.toBe('yes')
  } finally { await f.close() }
})

it('requires authenticated status after the login process exits successfully', async () => {
  const f = await fixture(false)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  try {
    const result = f.authenticate(new AbortController().signal)
    const rejected = expect(result).rejects.toThrow('did not report an authenticated')
    await expect.poll(async () => await f.terminal.snapshot()).toContain('Secure sign-in code')
    f.terminal.send('fixture-code'); f.terminal.send('\r')
    await rejected
    await expect.poll(async () => await f.terminal.snapshot()).toContain('processing')
    expect(f.terminal.progress).toBe(true)
  } finally { await f.close() }
})

it('does not restart progress when the installer becomes idle during sign-in', async () => {
  const f = await fixture()
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  const controller = new AbortController()
  try {
    const rejected = expect(f.authenticate(controller.signal)).rejects.toThrow()
    await expect.poll(async () => await f.terminal.snapshot()).toContain('Secure sign-in code')
    f.activity.status('idle')
    controller.abort()
    await rejected
    await expect.poll(async () => await f.terminal.snapshot()).not.toContain('processing')
    expect(f.terminal.progress).toBe(false)
  } finally { await f.close() }
})

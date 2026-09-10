import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { SocketDaemonControl } from '../src/concierge-control.ts'

// Optional cross-repository gate: caller supplies a freshly built native CLI.
// No real native HOME, provider, credentials, or existing supervisor is used.
const native = process.env.DEARMACHINE_TEST_BIN
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  if (!native || !isAbsolute(native)) throw new Error('DEARMACHINE_TEST_BIN must be an absolute built native CLI path')
  const home = await mkdtemp(join(tmpdir(), 'native-concierge-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const wrapper = join(home, 'concierge')
  await writeFile(wrapper, '#!/bin/sh\nexec "$CONCIERGE_TEST_NODE" "$CONCIERGE_TEST_APP" "$@"\n', { mode: 0o700 })
  const source = join(home, 'source')
  await mkdir(join(source, 'dearmachine'), { recursive: true })
  await mkdir(join(source, 'machtiani-harness'))
  await mkdir(join(source, 'docs'))
  await writeFile(join(source, 'docs', 'README.md'), '# Fixture documentation\n')
  await writeFile(join(source, 'bootstrap-source-revisions.json'), JSON.stringify({ '.': 'a'.repeat(40) }))
  const env = {
    PATH: process.env.PATH!, HOME: home, XDG_RUNTIME_DIR: join(home, 'run'), DEARMACHINE_SUPERVISOR_SOCKET: join(home, '.dearmachine', 'run', 'supervisor.sock'), TERM: 'xterm-256color',
    XDG_STATE_HOME: join(home, 'xdg-state'), XDG_DATA_HOME: join(home, 'xdg-data'), XDG_CONFIG_HOME: join(home, 'xdg-config'),
    DEARMACHINE_CONCIERGE_BIN: wrapper, DEARMACHINE_SOURCE_ROOT: source,
    CONCIERGE_TEST_NODE: process.execPath, CONCIERGE_TEST_APP: resolve('packages/app/dist/bin.mjs'),
  }
  return { home, env }
}
function terminal(env: Record<string, string>, steps: { prompt: string; input: string }[]) {
  return new Promise<{ code: number; output: string }>((resolveResult, reject) => {
    const child = pty.spawn('bash', ['--noprofile', '--norc', '-c',
      'before=$(stty -g); "$1"; code=$?; after=$(stty -g); [ "$before" = "$after" ] || exit 90; exit "$code"', 'native-test', native!],
    { env, cols: 120, rows: 35 })
    let output = ''
    let pending = ''
    let stage = 0
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Native concierge PTY timed out at step ${stage}: ${output}`)) }, 8_000)
    child.onData(chunk => {
      output += chunk
      pending += chunk
      if (stage < steps.length && pending.includes(steps[stage]!.prompt)) {
        const input = steps[stage++]!.input
        pending = ''
        child.write(input)
      }
    })
    child.onExit(({ exitCode }) => { clearTimeout(timer); resolveResult({ code: exitCode, output }) })
  })
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

describe.skipIf(!native)('native Go to TS foreground handoff', () => {
  it('bootstraps an absent native supervisor and honestly reports a local startup failure', async () => {
    const { home, env } = await fixture()
    const root = join(home, '.dearmachine')
    await mkdir(join(root, 'config'), { recursive: true, mode: 0o700 })
    const inbox = randomUUID()
    await writeFile(join(root, 'pairs.toml'), `version = 2\n[[inboxes]]\nid = "${inbox}"\ntransport = "agentmail"\nprovider_id = "fixture"\naddress = "machine@example.test"\n[[pairs]]\nid = "${randomUUID()}"\nuser_email = "user@example.test"\ninbox_id = "${inbox}"\n`, { mode: 0o600 })
    // Guaranteed local parse failure before application/provider construction.
    await writeFile(join(root, 'config', 'runtime.toml'), '[invalid', { mode: 0o600 })
    const control = new SocketDaemonControl(env.DEARMACHINE_SUPERVISOR_SOCKET, 500)
    cleanups.push(async () => {
      try {
        const status = await control.request('status') as unknown as { supervisorPid: number }
        process.kill(status.supervisorPid, 'SIGTERM')
        await expect.poll(async () => { try { await control.request('status'); return false } catch { return true } }).toBe(true)
      } catch { /* No owner was started. */ }
    })
    const result = await terminal(env, [
      { prompt: 'Use /help', input: '/up\r' },
      { prompt: 'Bootstrapping', input: '/help\r' },
      { prompt: 'Run dearmachine status', input: '/down\r' },
      { prompt: 'Dear Machine: stopped', input: '/quit\r' },
    ])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain('startup is not yet confirmed')
    expect(result.output).not.toContain('Dear Machine: running')
    expect((await control.request('status')).supervisor).toBe('stopped')
  })

  it('opens fresh setup consent and exits without a provider', async () => {
    const { env } = await fixture()
    const result = await terminal(env, [{ prompt: 'Would you like to continue', input: '/quit\r' }])
    expect(result.code, result.output).toBe(0)
    expect(result.output).not.toContain('Which LLM provider')
  })
  it('controls a native supervisor via all slash commands and preserves it on exit', async () => {
    const { home, env } = await fixture()
    const root = join(home, '.dearmachine')
    await mkdir(root, { mode: 0o700 })
    const inbox = randomUUID()
    await writeFile(join(root, 'pairs.toml'), `version = 2\n[[inboxes]]\nid = "${inbox}"\ntransport = "agentmail"\nprovider_id = "fixture"\naddress = "machine@example.test"\n[[pairs]]\nid = "${randomUUID()}"\nuser_email = "user@example.test"\ninbox_id = "${inbox}"\n`, { mode: 0o600 })
    const daemon = join(home, 'daemon.cjs')
    await writeFile(daemon, `const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.argv[2], 'run', 'launches'), String(process.pid) + '\\n');
for (const name of ['dearmachine.pid', 'dearmachine.ready']) fs.writeFileSync(path.join(process.argv[2], 'run', name), String(process.pid));
setInterval(() => {}, 1000);
`)
    const owner = spawn(native!, ['_supervise', '--state-dir', root, '--', process.execPath, daemon, root], { env, stdio: 'ignore' })
    cleanups.push(() => stop(owner))
    const control = new SocketDaemonControl(join(root, 'run', 'supervisor.sock'), 200)
    await expect.poll(async () => (await control.request('status')).daemon, { timeout: 3_000 }).toBe('running')
    await control.request('down')
    const before = await readFile(join(root, 'run', 'dearmachine.pid'), 'utf8')
    const result = await terminal(env, [
      { prompt: 'Use /help', input: '/status\r' },
      { prompt: 'Dear Machine: stopped', input: '/up\r' },
      { prompt: 'Dear Machine: running', input: '/restart\r' },
      { prompt: 'Dear Machine: running', input: '/down\r' },
      { prompt: 'Dear Machine: stopped', input: '/up\r' },
      { prompt: 'Dear Machine: running', input: '/quit\r' },
    ])
    expect(result.code, result.output).toBe(0)
    expect(result.output).not.toContain('Would you like to continue')
    expect(result.output).toContain('Crash recovery:')
    expect(result.output).toContain('After account logout: not verified')
    expect(result.output).toContain('Managed startup at login:')
    expect(result.output).not.toContain('Persistence:')
    expect(result.output).not.toContain('detailed native status unavailable')
    expect((await control.request('status')).daemon).toBe('running')
    expect(await readFile(join(root, 'run', 'dearmachine.pid'), 'utf8')).not.toBe(before)
    expect(owner.exitCode).toBeNull()
    const launches = (await readFile(join(root, 'run', 'launches'), 'utf8')).trim().split('\n')
    expect(launches).toHaveLength(4) // Initial start, /up, /restart, /up.
    expect(new Set(launches).size).toBe(4)
    // Missing saved profile fails before any provider process/request; local controls survive.
    const offline = await terminal(env, [
      { prompt: 'Use /help', input: 'What is running?\r' },
      { prompt: 'provider is unavailable', input: '/help\r' },
      { prompt: 'Native fallback CLI', input: '/status\r' },
      { prompt: 'Dear Machine: running', input: '/quit\r' },
    ])
    expect(offline.code, offline.output).toBe(0)
    // First Ctrl+C stays in the TS shell; second exits and restores the TTY.
    const interrupted = await terminal(env, [
      { prompt: 'Use /help', input: '\x03' },
      { prompt: 'Press Ctrl+C again', input: '\x03' },
    ])
    expect(interrupted.code).toBe(0)
    expect((await control.request('status')).daemon).toBe('running')
  })
})

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
const app = resolve('packages/app/dist/bin.mjs')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(withServer = false) {
  const root = await mkdtemp(join(tmpdir(), 'concierge-cli-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const env = { ...process.env, HOME: root, DEARMACHINE_SUPERVISOR_SOCKET: '', XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'), TERM: 'xterm-256color' }
  const commands: string[] = []
  if (withServer) {
    await mkdir(join(root, '.dearmachine'))
    await mkdir(join(root, '.dearmachine', 'run'), { recursive: true })
    let running = false
    const server: Server = createServer(socket => {
      let request = ''
      socket.on('data', chunk => {
        request += String(chunk)
        if (!request.includes('\n')) return
        const { command } = JSON.parse(request) as { command: string }
        commands.push(command)
        if (command === 'up' || command === 'restart') running = true
        if (command === 'down') running = false
        socket.end(JSON.stringify({ version: 1, ok: true, status: {
          installation: 'installed', supervisor: running ? 'running' : 'stopped', daemon: running ? 'running' : 'stopped', persistence: 'disabled',
        } }) + '\n')
      })
    })
    await new Promise<void>(resolve => server.listen(join(root, '.dearmachine', 'run', 'supervisor.sock'), resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  }
  return { root, env, commands }
}
async function cli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [app, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.once('error', reject)
    child.once('close', code => resolveResult({ code, output }))
  })
}
describe('headless concierge CLI', () => {
  it.each([[], ['--concierge'], ['--help']])('prints help without a provider or endpoint for %j', async (...args) => {
    const { env } = await fixture()
    expect(await cli(args, env)).toMatchObject({ code: 0, output: expect.stringContaining('dearmachine --help') })
  })
  it('reports a failed query distinctly from an observed stopped daemon', async () => {
    const absent = await fixture()
    expect(await cli(['status'], absent.env)).toMatchObject({ code: 1, output: expect.stringContaining('state is unknown') })
    const ready = await fixture(true)
    expect(await cli(['status'], ready.env)).toMatchObject({ code: 0, output: expect.stringContaining('Daemon: stopped') })
  })
  it('uses confirmed lifecycle results through the same socket as the shell', async () => {
    const { env, commands } = await fixture(true)
    expect((await cli(['up'], env)).code).toBe(0)
    expect((await cli(['up'], env)).code).toBe(0)
    expect((await cli(['restart'], env)).code).toBe(0)
    expect((await cli(['down'], env)).code).toBe(0)
    expect(commands).toEqual(['status', 'up', 'status', 'status', 'restart', 'status', 'down'])
  })
})

describe('real PTY concierge exit', () => {
  it.each(['/quit', '/detach'])('restores the terminal and preserves an independent disposable process on %s', async exitCommand => {
    const { env, commands } = await fixture(true)
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, detached: true, stdio: 'ignore' })
    cleanups.push(() => new Promise<void>(resolve => { daemon.once('close', () => resolve()); daemon.kill() }))
    const result = await new Promise<{ code: number; output: string }>((resolveResult, reject) => {
      const child = pty.spawn('bash', ['--noprofile', '--norc', '-c', 'before=$(stty -g); "$1" "$2"; code=$?; after=$(stty -g); [ "$before" = "$after" ] || exit 90; exit "$code"', 'concierge-test', process.execPath, app], { env: env as Record<string, string>, cols: 100, rows: 30 })
      let output = ''
      let sent = false
      const timer = setTimeout(() => { child.kill(); reject(new Error('Concierge PTY timed out')) }, 5_000)
      child.onData(chunk => {
        output += chunk
        if (!sent && output.includes('Use /help')) { sent = true; child.write(`${exitCommand}\r`) }
      })
      child.onExit(({ exitCode }) => { clearTimeout(timer); resolveResult({ code: exitCode, output }) })
    })
    expect(result.code).toBe(0)
    expect(daemon.exitCode).toBeNull()
    expect(daemon.signalCode).toBeNull()
    expect(commands).toEqual(['status'])
  })
})

it('keeps local help and quit available before installer consent or provider setup', async () => {
  const { root, env } = await fixture()
  await mkdir(join(root, 'source', 'machtiani-harness'), { recursive: true })
  await mkdir(join(root, 'source', 'dearmachine'))
  const result = await new Promise<{ code: number; output: string }>((resolveResult, reject) => {
    const child = pty.spawn('bash', ['--noprofile', '--norc', '-c', 'before=$(stty -g); "$1" "$2" --concierge --source-root "$3"; code=$?; after=$(stty -g); [ "$before" = "$after" ] || exit 90; exit "$code"', 'concierge-test', process.execPath, app, join(root, 'source')], { env: env as Record<string, string>, cols: 100, rows: 30 })
    let output = ''
    let stage = 0
    const timer = setTimeout(() => { child.kill(); reject(new Error('Pre-setup concierge PTY timed out')) }, 5_000)
    child.onData(chunk => {
      output += chunk
      if (stage === 0 && output.includes('Would you like to continue')) { stage++; child.write('/help\r') }
      else if (stage === 1 && output.includes('Native fallback CLI commands')) { stage++; child.write('/quit\r') }
    })
    child.onExit(({ exitCode }) => { clearTimeout(timer); resolveResult({ code: exitCode, output }) })
  })
  expect(result.code).toBe(0)
  expect(result.output).toContain('Native fallback CLI commands')
  expect(result.output).not.toContain('Which LLM provider')
})

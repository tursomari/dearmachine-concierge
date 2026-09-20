import { protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, unlink, open } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import type { CredentialFileAdapter, CredentialKind } from '@dearmachine/machtiani-installer-credentials'
import { SecretInputCancelledError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { messages } from '@dearmachine/machtiani-installer-workflow'
import { MachtianiCredentialTarget } from './credential-machtiani.ts'

interface CredentialRequest {
  kind: CredentialKind
  selection: string
  action: 'ensure' | 'use-existing' | 'replace'
}

export interface CredentialBridgeOptions {
  socketPath: string
  tui: Pick<InstallerTui, 'askSecret'>
  credentials: CredentialFileAdapter
  authenticateBackend?(executable: string | undefined, signal: AbortSignal): Promise<void>
  machtiani?: Pick<MachtianiCredentialTarget, 'check' | 'configure'>
}

const PORTABLE_UNIX_SOCKET_PATH_LIMIT = 100

/** Build a compact private socket path that remains portable across Unix hosts. */
export function credentialSocketPath(
  stateDirectory: string,
  pid = process.pid,
  nonce: string = randomUUID(),
): string {
  const token = nonce.replace(/[^a-z0-9]/giu, '').slice(0, 8)
  const path = join(stateDirectory, `c-${pid.toString(36)}-${token}.sock`)
  if (process.platform === 'win32') return path + '.json'
  if (Buffer.byteLength(path) > PORTABLE_UNIX_SOCKET_PATH_LIMIT) {
    throw new Error('The installer state path is too long for its private socket. Set XDG_STATE_HOME to a shorter path and try again.')
  }
  return path
}

function request(value: unknown): CredentialRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid credential request')
  const candidate = value as Record<string, unknown>
  if ((candidate.kind !== 'backend-provider' && candidate.kind !== 'machtiani-provider' && candidate.kind !== 'email') || typeof candidate.selection !== 'string' || candidate.selection.trim() === '') {
    throw new Error('invalid credential request')
  }
  const action = candidate.action ?? 'ensure'
  if (action !== 'ensure' && action !== 'use-existing' && action !== 'replace') throw new Error('invalid credential action')
  if (candidate.kind === 'machtiani-provider' && action === 'ensure') throw new Error('Machtiani credentials require --use-existing or --replace')
  return { kind: candidate.kind, selection: candidate.selection.trim(), action }
}

function credentialPrompt(credential: CredentialRequest): string {
  const replacement = credential.action === 'replace' ? 'Replace the saved credential. Other components using this same credential reference will also use the replacement.\n\n' : ''
  if (credential.kind === 'email') return replacement + messages.emailCredential(credential.selection)
  return `${replacement}Dear Machine needs your ${credential.selection} API key to configure ${credential.kind === 'machtiani-provider' ? 'the Machtiani harness' : 'the backend agent you chose'}.

Paste it into the secure field below and press Enter. Your input is masked, saved directly to a private file, and never added to the conversation or sent to the installer model.`
}

function reply(socket: Socket, value: object): void {
  socket.end(`${JSON.stringify(value)}\n`)
}

/** Private local bridge from the agent's helper tool to transcript-free TUI input. */
export class CredentialBridge {
  private server: Server | undefined
  private active = false
  private bound = false
  private readonly token = randomBytes(32).toString('hex')
  private readonly sockets = new Set<Socket>()

  constructor(private readonly options: CredentialBridgeOptions) {}

  async start(): Promise<void> {
    if (this.server !== undefined) throw new Error('the credential bridge is already started')
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 })
    try {
      await lstat(this.options.socketPath)
      throw new Error('the private credential bridge path already exists')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const server = createServer(socket => { this.accept(socket) })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(process.platform === 'win32' ? { host: '127.0.0.1', port: 0 } : this.options.socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.bound = true
    if (process.platform === 'win32') {
      await protectPrivatePath(dirname(this.options.socketPath), 0o700)
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Invalid credential bridge address')
      const file = await open(this.options.socketPath, 'wx', 0o600)
      try {
        await protectPrivatePath(this.options.socketPath, 0o600)
        await file.writeFile(JSON.stringify({ version: 1, port: address.port, token: this.token }))
      } finally { await file.close() }
    } else await chmod(this.options.socketPath, 0o600)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      for (const socket of this.sockets) socket.destroy()
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
    if (!this.bound) return
    this.bound = false
    try {
      const metadata = await lstat(this.options.socketPath)
      if (metadata.isSocket() || (process.platform === 'win32' && metadata.isFile())) await unlink(this.options.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => { this.sockets.delete(socket) })
    socket.on('error', () => { socket.destroy() })
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', chunk => {
      input += chunk
      if (input.length > 4096) {
        reply(socket, { ok: false, error: 'credential request was too large' })
        return
      }
      const newline = input.indexOf('\n')
      if (newline < 0) return
      socket.removeAllListeners('data')
      void this.handle(socket, input.slice(0, newline))
    })
  }

  private async handle(socket: Socket, line: string): Promise<void> {
    if (this.active) {
      reply(socket, { ok: false, error: 'another credential field is already active' })
      return
    }
    this.active = true
    const cancellation = new AbortController()
    socket.once('close', () => { cancellation.abort() })
    let value = ''
    try {
      const parsed: unknown = JSON.parse(line)
      if (process.platform === 'win32') {
        const supplied = typeof parsed === 'object' && parsed !== null && '_bridgeToken' in parsed && typeof parsed._bridgeToken === 'string' ? parsed._bridgeToken : ''
        const expected = Buffer.from(this.token)
        const actual = Buffer.from(supplied)
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Unauthorized credential request')
      }
      if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed && parsed.kind === 'backend-login') {
        const login = parsed as Record<string, unknown>
        if (login.backend !== 'claude' || (login.executable !== undefined &&
            (typeof login.executable !== 'string' || !isAbsolute(login.executable)))) throw new Error('Invalid backend sign-in request')
        if (!this.options.authenticateBackend) throw new Error('Backend sign-in is unavailable in this interface')
        try { await this.options.authenticateBackend(login.executable as string | undefined, cancellation.signal) }
        catch { throw new Error('Claude Code sign-in did not complete. Retry the browser sign-in when ready.') }
        if (!cancellation.signal.aborted && this.server !== undefined && !socket.destroyed) reply(socket, { ok: true, authenticated: true })
        return
      }
      const credential = request(parsed)
      const readiness = await this.options.credentials.prepare(credential.kind, credential.selection)
      const reference = this.options.credentials.reference?.(credential.kind)
      if (cancellation.signal.aborted || this.server === undefined || socket.destroyed) return
      const target = credential.kind === 'machtiani-provider' ? (this.options.machtiani ?? new MachtianiCredentialTarget()) : undefined
      if (target && !reference) throw new Error('Machtiani credential reference is unavailable')
      if (target) await target.check(credential.selection)
      if (cancellation.signal.aborted || this.server === undefined || socket.destroyed) return
      if (credential.action === 'use-existing' && readiness !== 'ready') throw new Error('No saved credential is available; use --replace to enter one securely')
      if (readiness === 'ready' && credential.action !== 'replace') {
        if (target && reference) await target.configure(credential.selection, reference)
        reply(socket, { ok: true, status: target ? 'configured' : 'already-present', reference })
        return
      }
      value = await this.options.tui.askSecret(credentialPrompt(credential), cancellation.signal)
      if (cancellation.signal.aborted || this.server === undefined || socket.destroyed) return
      await this.options.credentials.save(credential.kind, value)
      value = ''
      if (target && reference) {
        try { await target.configure(credential.selection, reference) }
        catch { throw new Error('Credential saved, but Machtiani configuration failed. Use --use-existing to retry configuration; authentication has not been verified.') }
      }
      reply(socket, { ok: true, status: target ? 'configured' : 'saved', reference })
    } catch (error) {
      value = ''
      if (error instanceof SecretInputCancelledError) reply(socket, { ok: true, status: 'cancelled' })
      else reply(socket, { ok: false, error: error instanceof Error ? error.message : 'credential entry failed' })
    } finally {
      this.active = false
    }
  }
}

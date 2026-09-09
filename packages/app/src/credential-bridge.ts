import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { CredentialFileAdapter, CredentialKind } from '@dearmachine/machtiani-installer-credentials'
import { SecretInputCancelledError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { messages } from '@dearmachine/machtiani-installer-workflow'

interface CredentialRequest {
  kind: CredentialKind
  selection: string
}

export interface CredentialBridgeOptions {
  socketPath: string
  tui: Pick<InstallerTui, 'askSecret'>
  credentials: CredentialFileAdapter
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
  if (Buffer.byteLength(path) > PORTABLE_UNIX_SOCKET_PATH_LIMIT) {
    throw new Error('The installer state path is too long for its private socket. Set XDG_STATE_HOME to a shorter path and try again.')
  }
  return path
}

function request(value: unknown): CredentialRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid credential request')
  const candidate = value as Record<string, unknown>
  if ((candidate.kind !== 'backend-provider' && candidate.kind !== 'email') || typeof candidate.selection !== 'string' || candidate.selection.trim() === '') {
    throw new Error('invalid credential request')
  }
  return { kind: candidate.kind, selection: candidate.selection.trim() }
}

function credentialPrompt(credential: CredentialRequest): string {
  if (credential.kind === 'email') return messages.emailCredential(credential.selection)
  return `Dear Machine needs your ${credential.selection} API key to configure the backend agent you chose.

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
      server.listen(this.options.socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.bound = true
    await chmod(this.options.socketPath, 0o600)
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
      if (metadata.isSocket()) await unlink(this.options.socketPath)
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
      const credential = request(JSON.parse(line))
      const readiness = await this.options.credentials.prepare(credential.kind, credential.selection)
      const reference = this.options.credentials.reference?.(credential.kind)
      if (cancellation.signal.aborted || this.server === undefined || socket.destroyed) return
      if (readiness === 'ready') {
        reply(socket, { ok: true, status: 'already-present', reference })
        return
      }
      value = await this.options.tui.askSecret(credentialPrompt(credential), cancellation.signal)
      if (cancellation.signal.aborted || this.server === undefined || socket.destroyed) return
      await this.options.credentials.save(credential.kind, value)
      value = ''
      reply(socket, { ok: true, status: 'saved', reference })
    } catch (error) {
      value = ''
      if (error instanceof SecretInputCancelledError) reply(socket, { ok: true, status: 'cancelled' })
      else reply(socket, { ok: false, error: error instanceof Error ? error.message : 'credential entry failed' })
    } finally {
      this.active = false
    }
  }
}

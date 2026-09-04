import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { CredentialFileAdapter, CredentialKind } from '@dearmachine/machtiani-installer-credentials'
import { SecretInputCancelledError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'

interface CredentialRequest {
  kind: CredentialKind
  selection: string
}

export interface CredentialBridgeOptions {
  socketPath: string
  tui: InstallerTui
  credentials: CredentialFileAdapter
}

function request(value: unknown): CredentialRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid credential request')
  const candidate = value as Record<string, unknown>
  if ((candidate.kind !== 'llm' && candidate.kind !== 'email') || typeof candidate.selection !== 'string' || candidate.selection.trim() === '') {
    throw new Error('invalid credential request')
  }
  return { kind: candidate.kind, selection: candidate.selection.trim() }
}

function reply(socket: Socket, value: object): void {
  socket.end(`${JSON.stringify(value)}\n`)
}

/** Private local bridge from the agent's helper tool to transcript-free TUI input. */
export class CredentialBridge {
  private server: Server | undefined
  private active = false

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
    await chmod(this.options.socketPath, 0o600)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
    try {
      const metadata = await lstat(this.options.socketPath)
      if (metadata.isSocket()) await unlink(this.options.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private accept(socket: Socket): void {
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
    let value = ''
    try {
      const credential = request(JSON.parse(line))
      if (await this.options.credentials.prepare(credential.kind, credential.selection) === 'ready') {
        reply(socket, { ok: true, status: 'already-present' })
        return
      }
      value = await this.options.tui.captureSecret()
      await this.options.credentials.save(credential.kind, value)
      value = ''
      reply(socket, { ok: true, status: 'saved' })
    } catch (error) {
      value = ''
      if (error instanceof SecretInputCancelledError) reply(socket, { ok: true, status: 'cancelled' })
      else reply(socket, { ok: false, error: error instanceof Error ? error.message : 'credential entry failed' })
    } finally {
      this.active = false
    }
  }
}

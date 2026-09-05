import { mkdtemp, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CredentialFileAdapter, CredentialKind } from '@dearmachine/machtiani-installer-credentials'
import { SecretInputCancelledError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { CredentialBridge, credentialSocketPath } from '../src/credential-bridge.ts'

function invoke(socketPath: string, request: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.setEncoding('utf8')
    let output = ''
    socket.once('connect', () => { socket.write(`${JSON.stringify(request)}\n`) })
    socket.on('data', chunk => { output += chunk })
    socket.once('end', () => { resolve(output) })
    socket.once('error', reject)
  })
}

describe('credential interaction bridge', () => {
  it('opens beneath an isolated XDG state path without exceeding Unix socket limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmp.'))
    const stateDirectory = join(root, '.local', 'state', 'machtiani-installer')
    const socketPath = credentialSocketPath(stateDirectory, 766296, 'a3bdb498-2d12-45fe-ab3c-16e9e6866a23')
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(100)
    const bridge = new CredentialBridge({
      socketPath,
      tui: { askSecret: async () => '' } as unknown as InstallerTui,
      credentials: {} as CredentialFileAdapter,
    })
    await bridge.start()
    await bridge.close()
  })

  it('reports an actionable error before binding an exceptionally long socket path', () => {
    const stateDirectory = join('/tmp', 'x'.repeat(100), 'machtiani-installer')
    expect(() => credentialSocketPath(stateDirectory, 1, '12345678')).toThrow('Set XDG_STATE_HOME to a shorter path')
  })

  it('keeps the captured value out of its local protocol response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-credential-bridge-'))
    const socketPath = join(root, 'private', 'credential.sock')
    const secret = 'bridge-test-secret'
    const calls: string[] = []
    const tui = {
      askSecret: async (message: string) => { calls.push(`ask:${message}`); return secret },
    } as unknown as InstallerTui
    const credentials = {
      prepare: async (kind: CredentialKind, selection: string) => { calls.push(`prepare:${kind}:${selection}`); return 'pending' as const },
      save: async (kind: CredentialKind, value: string) => { calls.push(`save:${kind}:${value === secret ? 'received' : 'wrong'}`) },
    } as unknown as CredentialFileAdapter
    const bridge = new CredentialBridge({ socketPath, tui, credentials })
    await bridge.start()
    try {
      expect((await stat(socketPath)).mode & 0o077).toBe(0)
      const response = await invoke(socketPath, { kind: 'backend-provider', selection: 'OpenRouter' })
      expect(JSON.parse(response)).toEqual({ ok: true, status: 'saved' })
      expect(response).not.toContain(secret)
      expect(calls).toEqual([
        'prepare:backend-provider:OpenRouter',
        'ask:Dear Machine needs your OpenRouter API key to configure the backend agent you chose.\n\nPaste it into the secure field below and press Enter. Your input is masked, saved directly to a private file, and never added to the conversation or sent to the installer model.',
        'save:backend-provider:received',
      ])
    } finally {
      await bridge.close()
    }
  })

  it('reports secure-entry cancellation without saving or failing the helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-credential-bridge-'))
    const socketPath = join(root, 'private', 'credential.sock')
    const calls: string[] = []
    const tui = {
      askSecret: async () => { calls.push('ask'); throw new SecretInputCancelledError() },
    } as unknown as InstallerTui
    const credentials = {
      prepare: async () => { calls.push('prepare'); return 'pending' as const },
      save: async () => { calls.push('save') },
    } as unknown as CredentialFileAdapter
    const bridge = new CredentialBridge({ socketPath, tui, credentials })
    await bridge.start()
    try {
      expect(JSON.parse(await invoke(socketPath, { kind: 'email', selection: 'AgentMail' })))
        .toEqual({ ok: true, status: 'cancelled' })
      expect(calls).toEqual(['prepare', 'ask'])
    } finally {
      await bridge.close()
    }
  })

  it('rejects the obsolete generic LLM slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-credential-bridge-'))
    const socketPath = join(root, 'private', 'credential.sock')
    const bridge = new CredentialBridge({
      socketPath,
      tui: {} as InstallerTui,
      credentials: {} as CredentialFileAdapter,
    })
    await bridge.start()
    try {
      expect(JSON.parse(await invoke(socketPath, { kind: 'llm', selection: 'OpenRouter' })))
        .toEqual({ ok: false, error: 'invalid credential request' })
    } finally {
      await bridge.close()
    }
  })
})

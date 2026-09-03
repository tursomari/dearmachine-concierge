import { mkdtemp, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CredentialFileAdapter, CredentialKind } from '@dearmachine/machtiani-installer-credentials'
import type { InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { CredentialBridge } from '../src/credential-bridge.ts'

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
  it('keeps the captured value out of its local protocol response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-credential-bridge-'))
    const socketPath = join(root, 'private', 'credential.sock')
    const secret = 'bridge-test-secret'
    const calls: string[] = []
    const tui = {
      captureSecret: async () => { calls.push('capture'); return secret },
    } as unknown as InstallerTui
    const credentials = {
      prepare: async (kind: CredentialKind, selection: string) => { calls.push(`prepare:${kind}:${selection}`); return 'pending' as const },
      save: async (kind: CredentialKind, value: string) => { calls.push(`save:${kind}:${value === secret ? 'received' : 'wrong'}`) },
    } as unknown as CredentialFileAdapter
    const bridge = new CredentialBridge({ socketPath, tui, credentials })
    await bridge.start()
    try {
      expect((await stat(socketPath)).mode & 0o077).toBe(0)
      const response = await invoke(socketPath, { kind: 'llm', selection: 'OpenRouter' })
      expect(JSON.parse(response)).toEqual({ ok: true, status: 'saved' })
      expect(response).not.toContain(secret)
      expect(calls).toEqual(['prepare:llm:OpenRouter', 'capture', 'save:llm:received'])
    } finally {
      await bridge.close()
    }
  })
})

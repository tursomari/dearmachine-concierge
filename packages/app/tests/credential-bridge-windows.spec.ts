import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CredentialFileAdapter, connectCredentialBridge, hasPrivatePermissions } from '@dearmachine/machtiani-installer-credentials'
import { CredentialBridge, credentialSocketPath } from '../src/credential-bridge.ts'
function reply(socket: Socket, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    socket.on('error', reject)
    socket.on('data', chunk => { data += String(chunk); if (data.includes('\n')) { socket.destroy(); resolve(JSON.parse(data.split('\n')[0]!)) } })
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
  })
}
describe.runIf(process.platform === 'win32')('Windows credential bridge', () => {
  it('rejects requests without the owner token before prompting and accepts the authorized helper', async () => {
    const home = await mkdtemp(join(tmpdir(), 'Dear Machine bridge Ω '))
    const path = credentialSocketPath(join(home, 'state'))
    const askSecret = vi.fn(async () => 'fixture-key-not-a-real-credential')
    const bridge = new CredentialBridge({ socketPath: path, credentials: new CredentialFileAdapter({ home }), tui: { askSecret } })
    try {
      await bridge.start()
      expect(await hasPrivatePermissions(path)).toBe(true)
      const endpoint = JSON.parse(await readFile(path, 'utf8'))
      const request = { kind: 'email', selection: 'agentmail', action: 'replace' }
      const bad = await reply(createConnection({ host: '127.0.0.1', port: endpoint.port }), request)
      expect(bad.ok).toBe(false); expect(askSecret).not.toHaveBeenCalled()
      const { socket, token } = await connectCredentialBridge(path)
      const good = await reply(socket, { ...request, _bridgeToken: token })
      expect(good.ok).toBe(true); expect(askSecret).toHaveBeenCalledTimes(1)
    } finally { await bridge.close(); await rm(home, { recursive: true, force: true }) }
  }, 30_000)
})

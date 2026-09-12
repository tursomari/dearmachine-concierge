import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const helper = fileURLToPath(new URL('../dist/credential-bin.mjs', import.meta.url))

describe('credential CLI actions', () => {
  it.each(['--use-existing', '--replace'])('forwards %s to the bridge and reports configuration limits', async flag => {
    const home = await mkdtemp(join(tmpdir(), 'cc-'))
    const socketPath = join(home, 'c.sock')
    let request: unknown
    const server = createServer(socket => {
      socket.once('data', data => {
        request = JSON.parse(data.toString())
        socket.end(JSON.stringify({ ok: true, status: 'configured', reference: { kind: 'machtiani-provider', variable: 'DEEPSEEK_API_KEY' } }) + '\n')
      })
    })
    await new Promise<void>(resolve => { server.listen(socketPath, resolve) })
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, [helper, 'machtiani-provider', 'deepseek', flag], {
          env: { ...process.env, MACHTIANI_INSTALLER_CREDENTIAL_SOCKET: socketPath }, timeout: 10_000,
        }, (error, stdout) => { if (error) reject(error); else resolve(stdout) })
      })
      expect(request).toEqual({ kind: 'machtiani-provider', selection: 'deepseek', action: flag === '--replace' ? 'replace' : 'use-existing' })
      expect(output).toContain('Authentication has not been tested')
      expect(output).toContain('no client restart')
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects conflicting actions before opening the socket', async () => {
    const code = await new Promise<number | string | null | undefined>(resolve => {
      execFile(process.execPath, [helper, 'backend-provider', 'deepseek', '--replace', '--use-existing'], {
        env: { ...process.env, MACHTIANI_INSTALLER_CREDENTIAL_SOCKET: '/nonexistent-fixture.sock' }, timeout: 10_000,
      }, error => { resolve(error?.code) })
    })
    expect(code).toBe(2)
  })
})

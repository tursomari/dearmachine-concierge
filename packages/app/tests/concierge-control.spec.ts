import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SocketDaemonControl, selectSupervision, type DaemonStatus } from '../src/concierge-control.ts'

const stopped: DaemonStatus = {
  installation: 'installed', supervisor: 'stopped', daemon: 'stopped', persistence: 'disabled',
}
const roots: string[] = []
const servers: Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(reply?: (request: string, socket: Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), 'concierge-control-'))
  roots.push(root)
  const path = join(root, 'control.sock')
  if (reply !== undefined) {
    const server = createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      let request = ''
      socket.on('data', chunk => {
        request += String(chunk)
        if (request.includes('\n')) reply(request, socket)
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(path, resolve))
  }
  return new SocketDaemonControl(path, 100)
}

describe('concierge supervisor control client', () => {
  it.each(['status', 'up', 'down', 'restart'] as const)('sends %s once and returns observed state', async command => {
    const requests: unknown[] = []
    const control = await fixture((request, socket) => {
      requests.push(JSON.parse(request))
      const response = JSON.stringify({ version: 1, ok: true, status: stopped }) + '\n'
      socket.write(response.slice(0, 12))
      socket.end(response.slice(12))
    })
    await expect(control.request(command)).resolves.toEqual(stopped)
    expect(requests).toEqual([{ version: 1, command }])
  })
  it('reports an unavailable endpoint as a failed query, never a stopped daemon', async () => {
    const control = await fixture()
    await expect(control.request('status')).rejects.toThrow('dearmachine status')
  })
  it('bounds unresponsive requests without retrying mutations', async () => {
    let requests = 0
    const control = await fixture(() => { requests++ })
    await expect(control.request('up')).rejects.toThrow('may have completed')
    expect(requests).toBe(1)
  })
  it.each([
    'not json\n',
    JSON.stringify({ version: 2, ok: true, status: stopped }) + '\n',
    JSON.stringify({ version: 1, ok: true, status: { ...stopped, daemon: 'maybe' } }) + '\n',
    JSON.stringify({ version: 1, ok: true, status: { ...stopped, supervisor: 'backing-off', retryInMs: -1 } }) + '\n',
    'x'.repeat(65_537),
    '',
  ])('rejects malformed, oversized, or incomplete responses (%#)', async response => {
    const control = await fixture((_request, socket) => socket.end(response))
    await expect(control.request('status')).rejects.toThrow('control')
  })
  it('returns pending retry details without interpreting them as success', async () => {
    const status = { ...stopped, supervisor: 'backing-off', retryInMs: 200, lastExit: 'exit code 1' }
    const control = await fixture((_request, socket) => socket.end(JSON.stringify({ version: 1, ok: true, status }) + '\n'))
    await expect(control.request('status')).resolves.toEqual(status)
  })
  it('does not echo arbitrary endpoint errors into the interface', async () => {
    const control = await fixture((_request, socket) => socket.end(JSON.stringify({ version: 1, ok: false, error: 'private diagnostic' }) + '\n'))
    await expect(control.request('down')).rejects.toThrow('dearmachine status')
    await expect(control.request('down')).rejects.not.toThrow('private diagnostic')
  })
})

describe('systemd consent seam', () => {
  it.each([
    [false, false, false, 'supervisor-lite'], [false, true, true, 'supervisor-lite'],
    [true, false, false, 'supervisor-lite'], [true, false, true, 'supervisor-lite'],
    [true, true, false, 'systemd'], [true, true, true, 'systemd'],
  ] as const)('requires a usable user manager and separate consent (%#)', (usableUserManager, useSystemd, enablePersistence, owner) => {
    expect(selectSupervision({ usableUserManager, consent: { useSystemd, enablePersistence } })).toEqual({
      owner, enablePersistence: owner === 'systemd' && enablePersistence,
    })
  })
})

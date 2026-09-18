import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { requestBackendLogin } from '../src/backend-login.ts'

afterEach(() => vi.unstubAllEnvs())
async function fixture(connected: (socket: Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), 'backend-login-'))
  const path = join(root, 'bridge.sock')
  const sockets: Socket[] = []
  const server = createServer(socket => {sockets.push(socket); connected(socket)})
  await new Promise<void>(resolve => server.listen(path, resolve))
  vi.stubEnv('MACHTIANI_INSTALLER_CREDENTIAL_SOCKET', path)
  return async () => {for(const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, {recursive:true,force:true})}
}
it('sends only the selected backend path and requires a confirmed success', async () => {
  let request: unknown
  const close = await fixture(socket => socket.on('data', data => {request = JSON.parse(String(data)); socket.end('{"ok":true,"authenticated":true}\n')}))
  try {await requestBackendLogin('/fixture/claude'); expect(request).toEqual({kind:'backend-login',backend:'claude',executable:'/fixture/claude'})} finally {await close()}
})
it.each(['{"ok":true}\n', '{"ok":false,"error":"fixture-private-code"}\n', 'invalid\n', ''])('rejects incomplete or failed replies without leaking private errors', async response => {
  const close = await fixture(socket => socket.on('data', () => socket.end(response)))
  try {await expect(requestBackendLogin()).rejects.not.toThrow('fixture-private-code')} finally {await close()}
})
it('closes the request when interrupted', async () => {
  let ready!: () => void
  const waiting = new Promise<void>(resolve => {ready = resolve})
  const close = await fixture(socket => socket.on('data', ready))
  const controller = new AbortController()
  try {const pending = requestBackendLogin(undefined, controller.signal); const rejected=expect(pending).rejects.toThrow('cancelled'); await waiting; controller.abort(); await rejected} finally {await close()}
})

import { createConnection } from 'node:net'

/** The private bridge owns browser/code interaction; the model receives only the result. */
export async function requestBackendLogin(executable?: string, signal?: AbortSignal): Promise<void> {
  const path = process.env.MACHTIANI_INSTALLER_CREDENTIAL_SOCKET
  if (!path) throw new Error('Interactive backend sign-in is unavailable')
  const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(11 * 60_000)])
  lifetime.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path)
    const abort = () => { socket.destroy(); reject(new Error('Backend sign-in cancelled')) }
    lifetime.addEventListener('abort', abort, { once: true })
    socket.once('close', () => { lifetime.removeEventListener('abort', abort); reject(new Error('Backend sign-in bridge disconnected')) })
    let data = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(JSON.stringify({ kind: 'backend-login', backend: 'claude', ...(executable ? { executable } : {}) }) + '\n'))
    socket.on('data', chunk => {
      data += chunk
      if (data.length > 8192) { socket.destroy(); reject(new Error('Invalid backend sign-in reply')); return }
      if (!data.includes('\n')) return
      socket.end()
      try {
        const reply = JSON.parse(data.slice(0, data.indexOf('\n')))
        if (reply.ok === true && reply.authenticated === true) resolve()
        else reject(new Error('Claude Code sign-in did not complete. Retry the browser sign-in when ready.'))
      } catch { reject(new Error('Invalid backend sign-in reply')) }
    })
    socket.once('error', reject)
  })
}

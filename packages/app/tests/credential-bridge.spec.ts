import { mkdtemp, stat, readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CredentialFileAdapter, type CredentialKind } from '@dearmachine/machtiani-installer-credentials'
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
  it('cancels pending masked input and closes clients without saving during shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cb-'))
    const socketPath = join(root, 'credential.sock')
    let opened!: () => void
    const ready = new Promise<void>(resolve => { opened = resolve })
    let aborted = false
    let saved = false
    const bridge = new CredentialBridge({
      socketPath,
      tui: { askSecret: async (_message, signal) => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(new SecretInputCancelledError()) }, { once: true })
        opened()
      }) },
      credentials: { prepare: async () => 'pending', save: async () => { saved = true } } as unknown as CredentialFileAdapter,
    })
    await bridge.start()
    const result = invoke(socketPath, { kind: 'backend-provider', selection: 'openrouter' }).catch(() => '')
    await ready
    await bridge.close()
    await result
    expect(aborted).toBe(true)
    expect(saved).toBe(false)
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

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


describe('explicit credential actions', () => {
  async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'ca-'))
    const credentials = new CredentialFileAdapter({ home })
    await credentials.prepare('machtiani-provider', 'deepseek')
    await credentials.save('machtiani-provider', 'original-fixture-key')
    await credentials.prepare('machtiani-provider', 'openrouter')
    await credentials.save('machtiani-provider', 'other-fixture-key')
    return { home, credentials, socketPath: join(home, 'c.sock'), store: join(home, '.config/dearmachine/machtiani/credentials.env') }
  }

  it.each(['use-existing', 'replace'] as const)('targets Machtiani with %s and preserves other credentials', async action => {
    const f = await fixture()
    const events: string[] = []
    const bridge = new CredentialBridge({
      ...f,
      tui: { askSecret: async prompt => {
        expect(prompt).toContain('Machtiani harness')
        expect(prompt).toContain('Other components')
        events.push('prompt')
        return 'new-fixture-key'
      } },
      machtiani: {
        check: async provider => { expect(provider).toBe('deepseek'); events.push('check') },
        configure: async (provider, reference) => {
          expect(provider).toBe('deepseek')
          expect(reference).toMatchObject({ kind: 'machtiani-provider', variable: 'DEEPSEEK_API_KEY', destination: f.store })
          events.push('configure')
        },
      },
    })
    await bridge.start()
    try {
      const result = await invoke(f.socketPath, { kind: 'machtiani-provider', selection: 'deepseek', action })
      expect(JSON.parse(result)).toMatchObject({ ok: true, status: 'configured' })
      expect(result).not.toContain('fixture-key')
      expect(events).toEqual(action === 'replace' ? ['check', 'prompt', 'configure'] : ['check', 'configure'])
      const stored = await readFile(f.store, 'utf8')
      expect(stored).toContain('OPENROUTER_API_KEY=other-fixture-key')
      expect(stored).toContain(`DEEPSEEK_API_KEY=${action === 'replace' ? 'new' : 'original'}-fixture-key`)
    } finally { await bridge.close(); await rm(f.home, { recursive: true, force: true }) }
  })

  it('preserves the old key and target on cancelled replacement', async () => {
    const f = await fixture()
    const original = await readFile(f.store, 'utf8')
    let configured = false
    const bridge = new CredentialBridge({ ...f,
      tui: { askSecret: async () => { throw new SecretInputCancelledError() } },
      machtiani: { check: async () => {}, configure: async () => { configured = true } },
    })
    await bridge.start()
    try {
      expect(JSON.parse(await invoke(f.socketPath, { kind: 'machtiani-provider', selection: 'deepseek', action: 'replace' })))
        .toEqual({ ok: true, status: 'cancelled' })
      expect(await readFile(f.store, 'utf8')).toBe(original)
      expect(configured).toBe(false)
    } finally { await bridge.close(); await rm(f.home, { recursive: true, force: true }) }
  })

  it('does not prompt or configure when use-existing has no saved credential', async () => {
    const f = await fixture()
    const bridge = new CredentialBridge({ ...f,
      tui: { askSecret: async () => { throw new Error('unexpected prompt') } },
      machtiani: { check: async () => {}, configure: async () => { throw new Error('unexpected configuration') } },
    })
    await bridge.start()
    try {
      const result = JSON.parse(await invoke(f.socketPath, { kind: 'machtiani-provider', selection: 'openai', action: 'use-existing' }))
      expect(result).toEqual({ ok: false, error: 'No saved credential is available; use --replace to enter one securely' })
    } finally { await bridge.close(); await rm(f.home, { recursive: true, force: true }) }
  })

  it('rejects an unavailable target before replacement entry or saving', async () => {
    const f = await fixture()
    const original = await readFile(f.store, 'utf8')
    const bridge = new CredentialBridge({ ...f,
      tui: { askSecret: async () => { throw new Error('unexpected prompt') } },
      machtiani: { check: async () => { throw new Error('Unsupported provider target') }, configure: async () => {} },
    })
    await bridge.start()
    try {
      const result = JSON.parse(await invoke(f.socketPath, { kind: 'machtiani-provider', selection: 'deepseek', action: 'replace' }))
      expect(result).toEqual({ ok: false, error: 'Unsupported provider target' })
      expect(await readFile(f.store, 'utf8')).toBe(original)
    } finally { await bridge.close(); await rm(f.home, { recursive: true, force: true }) }
  })

  it('reports saved-but-not-connected separately so reuse can finish the operation', async () => {
    const f = await fixture()
    const bridge = new CredentialBridge({ ...f,
      tui: { askSecret: async () => 'new-fixture-key' },
      machtiani: { check: async () => {}, configure: async () => { throw new Error('private subprocess output') } },
    })
    await bridge.start()
    try {
      const result = await invoke(f.socketPath, { kind: 'machtiani-provider', selection: 'deepseek', action: 'replace' })
      expect(JSON.parse(result)).toMatchObject({ ok: false, error: expect.stringContaining('Credential saved, but Machtiani configuration failed') })
      expect(result).not.toContain('private subprocess output')
      expect(await readFile(f.store, 'utf8')).toContain('DEEPSEEK_API_KEY=new-fixture-key')
    } finally { await bridge.close(); await rm(f.home, { recursive: true, force: true }) }
  })

  it('rotates an existing backend key without configuring Machtiani', async () => {
    const f = await fixture()
    await f.credentials.prepare('backend-provider', 'deepseek')
    await f.credentials.save('backend-provider', 'original-fixture-key')
    const bridge = new CredentialBridge({ ...f,
      tui: { askSecret: async () => 'replacement-fixture-key' },
      machtiani: { check: async () => { throw new Error('wrong target') }, configure: async () => { throw new Error('wrong target') } },
    })
    await bridge.start()
    try {
      const result = await invoke(f.socketPath, { kind: 'backend-provider', selection: 'deepseek', action: 'replace' })
      expect(JSON.parse(result)).toMatchObject({ ok: true, status: 'saved' })
      expect(result).not.toContain('fixture-key')
      expect(await readFile(join(f.home, '.config/dearmachine/backends.env'), 'utf8')).toContain('DEEPSEEK_API_KEY=replacement-fixture-key')
    } finally { await bridge.close(); await rm(f.home, { recursive: true, force: true }) }
  })
})

it('routes supported backend login without exposing credentials or private errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cb-auth-'))
  const socketPath = join(root, 'credential.sock')
  const calls: Array<string | undefined> = []
  const bridge = new CredentialBridge({ socketPath, tui: { askSecret: async () => { throw new Error('not an API key') } },
    credentials: {} as CredentialFileAdapter,
    authenticateBackend: async executable => { calls.push(executable); if (executable?.endsWith('broken')) throw new Error('fixture-private-code') },
  })
  await bridge.start()
  try {
    expect(JSON.parse(await invoke(socketPath, {kind: 'backend-login', backend: 'claude', executable: '/fixture/claude'}))).toEqual({ok: true, authenticated: true})
    expect(JSON.parse(await invoke(socketPath, {kind: 'backend-login', backend: 'other'})).ok).toBe(false)
    expect(JSON.parse(await invoke(socketPath, {kind: 'backend-login', backend: 'claude', executable: 'relative'})).ok).toBe(false)
    const failed = await invoke(socketPath, {kind: 'backend-login', backend: 'claude', executable: '/fixture/broken'})
    expect(JSON.parse(failed).ok).toBe(false)
    expect(failed).not.toContain('fixture-private-code')
    expect(calls).toEqual(['/fixture/claude', '/fixture/broken'])
  } finally { await bridge.close(); await rm(root, {recursive: true, force: true}) }
})

it('cancels backend sign-in when its tool disconnects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cb-auth-'))
  const socketPath = join(root, 'credential.sock')
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  let aborted = false
  const bridge = new CredentialBridge({ socketPath, tui: {askSecret: async () => ''}, credentials: {} as CredentialFileAdapter,
    authenticateBackend: async (_executable, signal) => await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {aborted = true; reject(new Error('cancelled'))}, {once: true}); opened()
    }),
  })
  await bridge.start()
  const socket = createConnection(socketPath)
  socket.on('error', () => {})
  try {
    socket.once('connect', () => socket.write(JSON.stringify({kind: 'backend-login', backend: 'claude'}) + '\n'))
    await ready
    socket.destroy()
    await expect.poll(() => aborted).toBe(true)
  } finally {socket.destroy(); await bridge.close(); await rm(root, {recursive: true, force: true})}
})

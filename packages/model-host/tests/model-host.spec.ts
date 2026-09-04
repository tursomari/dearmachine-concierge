import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  API_KEY_PROVIDERS,
  loadModelHostProfile,
  ModelHost,
  ModelHostError,
  readApiKeyCredential,
  saveModelHostProfile,
  serveModelHost,
  writeApiKeyCredential,
} from '../src/index.ts'

describe('shared model host profile', () => {
  it('stores one private credential reference without embedding the key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-host-'))
    const credentials = join(root, 'config', 'dearmachine', 'backends.env')
    const profilePath = join(root, 'config', 'machtiani', 'model-profile.json')
    const secret = 'test-model-host-secret'
    await writeApiKeyCredential(credentials, 'openrouter', secret)
    await saveModelHostProfile(profilePath, {
      version: 1, driver: 'pi-ai', provider: 'openrouter', authMethod: 'api_key',
      model: 'z-ai/glm-5.3-flash', reasoningEffort: 'high',
      credential: { kind: 'environment-file', path: credentials, variable: 'OPENROUTER_API_KEY' },
    })
    expect(await readApiKeyCredential(credentials, 'openrouter')).toBe(secret)
    expect(await loadModelHostProfile(profilePath)).toMatchObject({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash' })
    expect(await readFile(profilePath, 'utf8')).not.toContain(secret)
    expect((await stat(credentials)).mode & 0o077).toBe(0)
    expect((await stat(profilePath)).mode & 0o077).toBe(0)
    expect(await new ModelHost(await loadModelHostProfile(profilePath)).authenticated()).toBe(true)
  })

  it('preserves credentials for the other supported API providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-host-many-'))
    const path = join(root, 'backends.env')
    for (const provider of API_KEY_PROVIDERS) await writeApiKeyCredential(path, provider.id, `${provider.id}-secret`)
    for (const provider of API_KEY_PROVIDERS) expect(await readApiKeyCredential(path, provider.id)).toBe(`${provider.id}-secret`)
  })

  it('rejects public, symbolic, malformed, and whitespace-bearing credential files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-host-invalid-'))
    const path = join(root, 'backends.env')
    await expect(writeApiKeyCredential(path, 'openrouter', 'bad key')).rejects.toBeInstanceOf(ModelHostError)
    await writeFile(path, 'OPENROUTER_API_KEY=secret\n', { mode: 0o644 })
    await chmod(path, 0o644)
    await expect(readApiKeyCredential(path, 'openrouter')).rejects.toThrow('private regular file')
  })

  it('accepts a cancellation request while generation is streaming', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let captured = ''
    output.setEncoding('utf8').on('data', chunk => { captured += String(chunk) })
    const host = {
      profile: { provider: 'openrouter', authMethod: 'api_key' as const },
      authenticated: async () => true,
      models: () => [],
      async * generate(request: { signal?: AbortSignal }) {
        await new Promise<void>(resolve => {
          if (request.signal?.aborted === true) resolve()
          else request.signal?.addEventListener('abort', () => { resolve() }, { once: true })
        })
        throw new ModelHostError('CANCELLED', 'The model request was cancelled.')
      },
    }
    const serving = serveModelHost('/private/profile', input, output, async () => host as never)
    input.write(`${JSON.stringify({ v: 1, id: 'generation', method: 'generation/start', params: { caller: 'test', sessionId: 'one', messages: [] } })}\n`)
    input.write(`${JSON.stringify({ v: 1, id: 'cancel', method: 'generation/cancel', params: { id: 'generation' } })}\n`)
    input.end()
    await serving
    expect(captured).toContain('"id":"cancel","result":{"cancelled":true}')
    expect(captured).toContain('"id":"generation","error":{"code":"CANCELLED"')
  })

  it('keeps concurrent callers and sessions distinct across one host process', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let captured = ''
    output.setEncoding('utf8').on('data', chunk => { captured += String(chunk) })
    const observed: string[] = []
    const host = {
      profile: { provider: 'openrouter', authMethod: 'api_key' as const },
      authenticated: async () => true,
      models: () => [],
      async * generate(request: { caller: string; sessionId: string }) {
        observed.push(`${request.caller}:${request.sessionId}`)
        yield { type: 'text-delta' as const, index: 0, text: request.sessionId }
        yield { type: 'finish' as const, reason: 'stop' as const }
      },
    }
    const serving = serveModelHost('/private/profile', input, output, async () => host as never)
    input.write(`${JSON.stringify({ v: 1, id: 'installer-request', method: 'generation/start', params: { caller: 'installer', sessionId: 'installer-session', messages: [] } })}\n`)
    input.write(`${JSON.stringify({ v: 1, id: 'machtiani-request', method: 'generation/start', params: { caller: 'machtiani', sessionId: 'service-session', messages: [] } })}\n`)
    input.end()
    await serving
    expect(observed.sort()).toEqual(['installer:installer-session', 'machtiani:service-session'])
    expect(captured).toContain('"id":"installer-request"')
    expect(captured).toContain('"text":"installer-session"')
    expect(captured).toContain('"id":"machtiani-request"')
    expect(captured).toContain('"text":"service-session"')
  })

  it('does not expose upstream secret-bearing errors on the wire', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let captured = ''
    output.setEncoding('utf8').on('data', chunk => { captured += String(chunk) })
    const host = {
      profile: { provider: 'openrouter', authMethod: 'api_key' as const },
      authenticated: async () => true,
      models: () => [],
      async * generate() { throw new Error('upstream leaked test-secret-value') },
    }
    const serving = serveModelHost('/private/profile', input, output, async () => host as never)
    input.end(`${JSON.stringify({ v: 1, id: 'failure', method: 'generation/start', params: { caller: 'test', sessionId: 'redaction', messages: [] } })}\n`)
    await serving
    expect(captured).toContain('"code":"INTERNAL"')
    expect(captured).not.toContain('test-secret-value')
  })
})

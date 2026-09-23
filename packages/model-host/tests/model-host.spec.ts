import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CredentialFileAdapter } from '@dearmachine/machtiani-installer-credentials'
import {
  API_KEY_PROVIDERS,
  loadModelHostProfile,
  ModelHost,
  ModelHostError,
  readApiKeyCredential,
  removeApiKeyCredential,
  saveModelHostProfile,
  serveModelHost,
  validateCustomOpenAIEndpoint,
  verifyCustomOpenAIProfile,
  writeApiKeyCredential,
} from '../src/index.ts'

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return JSON.parse(body) as Record<string, unknown>
}

function streamEvents(response: ServerResponse, events: readonly Record<string, unknown>[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end('data: [DONE]\n\n')
}

describe('shared model host profile', () => {
  it('rejects missing caller and session identity before starting subscription runtimes', async () => {
    const host = new ModelHost({
      version: 1,
      driver: 'openai-codex-app-server',
      provider: 'openai-codex',
      authMethod: 'subscription',
      model: 'gpt-test',
      runtimeProfile: '/must-not-be-opened',
    })
    const consume = async () => {
      for await (const _event of host.generate({ caller: '', sessionId: '', role: 'planner', messages: [] })) {
        // No provider event is expected.
      }
    }
    await expect(consume()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('separates HTTPS remote endpoints from loopback-only local endpoints', () => {
    expect(validateCustomOpenAIEndpoint('https://models.example/v1/chat/completions', 'remote')).toBe('https://models.example/v1/chat/completions')
    expect(validateCustomOpenAIEndpoint('http://127.0.0.1:11434/v1/chat/completions/', 'local')).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(validateCustomOpenAIEndpoint('https://[::1]:8443/v1/chat/completions', 'local')).toBe('https://[::1]:8443/v1/chat/completions')
    expect(() => validateCustomOpenAIEndpoint('http://models.example/v1/chat/completions', 'remote')).toThrow('HTTPS')
    expect(() => validateCustomOpenAIEndpoint('https://localhost/v1/chat/completions', 'remote')).toThrow('local custom-provider')
    expect(() => validateCustomOpenAIEndpoint('http://192.168.1.10/v1/chat/completions', 'local')).toThrow('localhost')
    expect(() => validateCustomOpenAIEndpoint('http://127.0.0.1:11434/v1/models', 'local')).toThrow('/chat/completions')
    expect(() => validateCustomOpenAIEndpoint('https://models.example/v1/chat/completions?key=secret', 'remote')).toThrow('query parameters')
  })

  it('verifies keyless local streaming, tool calls, and tool-result continuation', async () => {
    const requests: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = []
    const server = createServer(async (request, response) => {
      requests.push({ body: await requestBody(request), authorization: request.headers.authorization })
      if (requests.length === 1) {
        streamEvents(response, [
          { id: 'one', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'compatibility_echo', arguments: '{"value":"ready"}' } }] }, finish_reason: null }] },
          { id: 'one', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ])
      } else {
        streamEvents(response, [
          { id: 'two', object: 'chat.completion.chunk', created: 2, model: 'local-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Compatibility confirmed.' }, finish_reason: null }] },
          { id: 'two', object: 'chat.completion.chunk', created: 2, model: 'local-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ])
      }
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      await verifyCustomOpenAIProfile({
        version: 1,
        driver: 'openai-compatible',
        provider: 'custom-openai-local',
        authMethod: 'optional_api_key',
        model: 'local-test',
        customProvider: {
          kind: 'openai-compatible', scope: 'local', name: 'Local test', usesApiKey: false,
          chatCompletionsEndpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        },
      })
    } finally { await new Promise<void>((resolve, reject) => { server.close(error => { if (error === undefined) resolve(); else reject(error) }) }) }
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.authorization)).toEqual([undefined, undefined])
    expect(requests[0]?.body).toMatchObject({ model: 'local-test', stream: true, tool_choice: 'required' })
    expect(requests[0]?.body).not.toHaveProperty('reasoning_effort')
    expect(requests[1]?.body.tools).toEqual([])
    expect(requests[1]?.body).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', tool_calls: expect.any(Array) }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'call-1' }),
      ]),
    })
  })

  it('sends a private custom-provider key and the optional reasoning level', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-custom-key-'))
    const credentials = join(root, 'backends.env')
    await writeApiKeyCredential(credentials, 'custom-openai-local', 'private-custom-key')
    const requests: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = []
    const server = createServer(async (request, response) => {
      requests.push({ body: await requestBody(request), authorization: request.headers.authorization })
      if (requests.length === 1) {
        streamEvents(response, [
          { id: 'one', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-2', type: 'function', function: { name: 'compatibility_echo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
        ])
      } else {
        streamEvents(response, [{ id: 'two', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }] }])
      }
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      await verifyCustomOpenAIProfile({
        version: 1, driver: 'openai-compatible', provider: 'custom-openai-local', authMethod: 'optional_api_key',
        model: 'reasoning-test', reasoningEffort: 'high',
        credential: { kind: 'environment-file', path: credentials, variable: 'MACHTIANI_CUSTOM_OPENAI_LOCAL_API_KEY' },
        customProvider: {
          kind: 'openai-compatible', scope: 'local', name: 'Reasoning test', usesApiKey: true,
          chatCompletionsEndpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        },
      })
    } finally { await new Promise<void>((resolve, reject) => { server.close(error => { if (error === undefined) resolve(); else reject(error) }) }) }
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.authorization)).toEqual(['Bearer private-custom-key', 'Bearer private-custom-key'])
    expect(requests.map(request => request.body.reasoning_effort)).toEqual(['high', 'high'])
    expect(JSON.stringify(requests)).not.toContain('MACHTIANI_CUSTOM_OPENAI_LOCAL_API_KEY')
  })

  it('rejects oversized context before the SDK can reduce the output limit to one token', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      streamEvents(response, [{ id: 'short', choices: [{ index: 0, delta: { content: 'Ready.' }, finish_reason: 'stop' }] }])
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const host = new ModelHost({
        version: 1, driver: 'openai-compatible', provider: 'custom-openai-local', authMethod: 'optional_api_key', model: 'context-test',
        customProvider: {
          kind: 'openai-compatible', scope: 'local', name: 'Context test', usesApiKey: false,
          chatCompletionsEndpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        },
      })
      const consume = async (content: string) => {
        const events = []
        for await (const event of host.generate({ caller: 'test', sessionId: 'context-test', messages: [{ role: 'user', content }] })) events.push(event)
        return events
      }
      await expect(consume('x'.repeat(600_000))).rejects.toMatchObject({ code: 'CONTEXT_LENGTH_EXCEEDED' })
      expect(requests).toBe(0)
      await expect(consume('A reduced prompt.')).resolves.toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Ready.' }))
      expect(requests).toBe(1)
    } finally { await new Promise<void>((resolve, reject) => { server.close(error => { if (error === undefined) resolve(); else reject(error) }) }) }
  })

  it('does not follow redirects from a custom endpoint', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(302, { location: '/different/chat/completions' })
      response.end()
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      await expect(verifyCustomOpenAIProfile({
        version: 1, driver: 'openai-compatible', provider: 'custom-openai-local', authMethod: 'optional_api_key', model: 'redirect-test',
        customProvider: {
          kind: 'openai-compatible', scope: 'local', name: 'Redirect test', usesApiKey: false,
          chatCompletionsEndpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        },
      })).rejects.toThrow('did not complete the compatibility test')
    } finally { await new Promise<void>((resolve, reject) => { server.close(error => { if (error === undefined) resolve(); else reject(error) }) }) }
    expect(requests).toBe(1)
  })

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

  it('preserves an existing backend credential when retrying assistant setup or removing its key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-model-backend-'))
    const adapter = new CredentialFileAdapter({ home })
    await adapter.prepare('backend-provider', 'Regional Gateway')
    await adapter.save('backend-provider', 'counterfeit-backend-key')
    const reference = adapter.reference('backend-provider')!
    const original = await readFile(reference.destination, 'utf8')
    await writeApiKeyCredential(reference.destination, 'custom-openai-remote', 'counterfeit-assistant-key')
    expect(await readApiKeyCredential(reference.destination, 'custom-openai-remote')).toBe('counterfeit-assistant-key')
    expect(await readFile(reference.destination, 'utf8')).toContain(original.trim())
    await removeApiKeyCredential(reference.destination, 'custom-openai-remote')
    expect(await readApiKeyCredential(reference.destination, 'custom-openai-remote')).toBeUndefined()
    expect(await readFile(reference.destination, 'utf8')).toBe(original)
    expect(await adapter.prepare('backend-provider', 'Regional Gateway')).toBe('ready')
  })

  it('refuses unsupported assignments without rewriting the shared credential store', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-model-unknown-'))
    const path = join(home, 'backends.env')
    const original = 'OPENROUTER_API_KEY=counterfeit-key\nNODE_OPTIONS=--inspect\n'
    await writeFile(path, original, { mode: 0o600 })
    await expect(writeApiKeyCredential(path, 'openrouter', 'replacement')).rejects.toThrow('unsupported assignments')
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(removeApiKeyCredential(path, 'openrouter')).rejects.toThrow('unsupported assignments')
    expect(await readFile(path, 'utf8')).toBe(original)
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
    const localHistories: string[][] = []
    const serving = serveModelHost('/private/profile', input, output, async () => {
      const instance = localHistories.length
      const localHistory: string[] = []
      localHistories.push(localHistory)
      return {
        profile: { provider: 'openrouter', authMethod: 'api_key' as const },
        authenticated: async () => true,
        models: () => [],
        async * generate(request: { caller: string; sessionId: string }) {
          const identity = `${request.caller}:${request.sessionId}`
          observed.push(identity)
          localHistory.push(identity)
          yield { type: 'text-delta' as const, index: 0, text: `${instance}:${localHistory.join(',')}` }
          yield { type: 'finish' as const, reason: 'stop' as const }
        },
      } as never
    })
    input.write(`${JSON.stringify({ v: 1, id: 'installer-request', method: 'generation/start', params: { caller: 'installer', sessionId: 'installer-session', messages: [] } })}\n`)
    input.write(`${JSON.stringify({ v: 1, id: 'machtiani-request', method: 'generation/start', params: { caller: 'machtiani', sessionId: 'service-session', messages: [] } })}\n`)
    input.end()
    await serving
    expect(observed.sort()).toEqual(['installer:installer-session', 'machtiani:service-session'])
    expect(localHistories).toHaveLength(2)
    expect(localHistories.every(history => history.length === 1)).toBe(true)
    expect(captured).toContain('"id":"installer-request"')
    expect(captured).toMatch(/"text":"[01]:installer:installer-session"/u)
    expect(captured).toContain('"id":"machtiani-request"')
    expect(captured).toMatch(/"text":"[01]:machtiani:service-session"/u)
  })

  it('preserves every actionable provider failure and retry hint over the wire', async () => {
    const failures = [
      ['AUTH_REQUIRED', undefined],
      ['AUTH_EXPIRED', undefined],
      ['RATE_LIMITED', 2750],
      ['QUOTA_EXHAUSTED', undefined],
      ['MODEL_UNAVAILABLE', undefined],
      ['UPSTREAM_CHANGED', undefined],
      ['TRANSIENT_ERROR', undefined],
      ['EMPTY_RESPONSE', undefined],
      ['CANCELLED', undefined],
    ] as const
    for (const [code, retryAfterMs] of failures) {
      const input = new PassThrough()
      const output = new PassThrough()
      let captured = ''
      output.setEncoding('utf8').on('data', chunk => { captured += String(chunk) })
      const host = {
        profile: { provider: 'openai-codex', authMethod: 'subscription' as const },
        async * generate() { throw new ModelHostError(code, 'provider detail', retryAfterMs) },
      }
      const serving = serveModelHost('/private/profile', input, output, async () => host as never)
      input.end(`${JSON.stringify({ v: 1, id: code, method: 'generation/start', params: { caller: 'machtiani', sessionId: `failure-${code}`, messages: [] } })}\n`)
      await serving
      const envelope = JSON.parse(captured) as { error: { code: string; message: string; retryAfterMs?: number } }
      expect(envelope.error).toEqual({ code, message: 'provider detail', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })
    }
  })

  it('forwards the selected subscription login mode over the private protocol', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let captured = ''
    output.setEncoding('utf8').on('data', chunk => { captured += String(chunk) })
    const modes: unknown[] = []
    const host = {
      profile: { provider: 'openai-codex', authMethod: 'subscription' as const },
      authenticated: async () => false,
      models: () => [],
      login: async (_interaction: unknown, mode: unknown) => { modes.push(mode) },
      logout: async () => {},
      async * generate() {},
    }
    const serving = serveModelHost('/private/profile', input, output, async () => host as never)
    input.end(`${JSON.stringify({ v: 1, id: 'login', method: 'auth/login', params: { mode: 'device_code' } })}\n`)
    await serving
    expect(modes).toEqual(['device_code'])
    expect(captured).toContain('"id":"login","result":{"authenticated":true}')
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

import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { InstallerModelSetup } from '../src/model-setup.ts'

it('rechecks a saved provider with its credential file and leaves that file unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'machtiani-saved-provider-'))
  const credentials = join(root, 'backends.env')
  const authorization: Array<string | undefined> = []
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request */ }
    authorization.push(request.headers.authorization)
    const delta = authorization.length === 1
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'echo', type: 'function', function: { name: 'compatibility_echo', arguments: '{"value":"ready"}' } }] }
      : { role: 'assistant', content: 'Ready.' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'saved-check', choices: [{ index: 0, delta, finish_reason: authorization.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const setup = await InstallerModelSetup.open(join(root, 'dsh'), {}, { home: root, credentialPath: credentials })
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind')
    const selection = {
      provider: 'custom-openai-local', model: 'saved-model', reasoningEffort: 'high',
      customProvider: {
        kind: 'openai-compatible' as const, scope: 'local' as const, name: 'Test',
        usesApiKey: true, chatCompletionsEndpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      },
    }
    await setup.prepareCustomProvider(selection, 'saved-test-key')
    const before = await readFile(credentials)
    await setup.verifySavedCustomProvider(selection)
    expect(authorization).toEqual(['Bearer saved-test-key', 'Bearer saved-test-key'])
    expect(await readFile(credentials)).toEqual(before)
  } finally {
    await setup.close()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
  }
})

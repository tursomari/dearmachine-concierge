import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as pty from 'node-pty'
import { saveModelHostProfile } from '@dearmachine/machtiani-model-host'
import { assistantModelPath, sharedModelPath } from '../src/assistant-model.ts'

it('switches a real concierge through /model, preserves history, and cancels from the provider menu', async () => {
  const home = await mkdtemp(join(tmpdir(), 'model-pty-'))
  const requests: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const wire = JSON.parse(body)
    requests.push(wire)
    // The custom-provider wizard requires one tool round trip before committing.
    const probe = JSON.stringify(wire.messages).includes('compatibility_echo')
    const tool = probe && !wire.messages.some((message: { role: string }) => message.role === 'tool')
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'probe', type: 'function',
      function: { name: 'compatibility_echo', arguments: '{"value":"ok"}' } }] }
      : { role: 'assistant', content: probe ? 'ok' : `ANSWER_${wire.model}` }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let child: pty.IPty | undefined
  try {
    await saveModelHostProfile(sharedModelPath(home), {
      version: 1, driver: 'openai-compatible', provider: 'custom-openai-local', authMethod: 'optional_api_key', model: 'before',
      customProvider: { kind: 'openai-compatible', scope: 'local', name: 'Fixture', usesApiKey: false,
        chatCompletionsEndpoint: `http://127.0.0.1:${port}/v1/chat/completions` },
    })
    const shared = await readFile(sharedModelPath(home), 'utf8')
    child = pty.spawn(process.execPath, [resolve('packages/app/dist/bin.mjs')], {
      cols: 160, rows: 50, cwd: home,
      env: { PATH: process.env.PATH!, HOME: home, XDG_STATE_HOME: join(home, 'state'), XDG_CONFIG_HOME: join(home, '.config'),
        TERM: 'xterm-256color', NO_COLOR: '1', MACHTIANI_MOTION: 'none', DEARMACHINE_NATIVE_BIN: '/nonexistent-fixture-cli' },
    })
    let output = ''
    child.onData(chunk => { output += chunk })
    const exited = new Promise<number>(resolve => child!.onExit(({ exitCode }) => resolve(exitCode)))
    let offset = 0
    const waitFor = async (text: string) => {
      await expect.poll(() => output.slice(offset), { timeout: 25_000 }).toContain(text)
      offset = output.length
    }
    const answer = async (text: string, input: string) => { await waitFor(text); child!.write(input) }
    await answer('Tell me what you need', 'Remember HISTORY_MARKER.\r')
    await answer('ANSWER_before', '/model\r')
    await answer('Choose the AI service', 'Custom OpenAI-compatible provider (local)\r')
    await answer('What should I call', 'Fixture\r')
    await answer('What local URL', `http://127.0.0.1:${port}\r`)
    await answer('What exact model name', 'after\r')
    await answer('Does this endpoint require', 'No\r')
    await answer('Should the assistant send', '\r')
    await answer('Assistant model saved', 'Continue HISTORY_MARKER.\r')
    await answer('ANSWER_after', '/model\r')
    await answer('Choose the AI service', '\x1b')
    await answer('Model change cancelled', '/quit\r')
    expect(await exited).toBe(0)
    child = undefined
    expect(JSON.parse(await readFile(assistantModelPath(home), 'utf8')).model).toBe('after')
    expect(await readFile(sharedModelPath(home), 'utf8')).toBe(shared)
    const next = requests.find(request => request.model === 'after' && JSON.stringify(request.messages).includes('Continue HISTORY_MARKER'))
    expect(next).toBeDefined()
    expect(JSON.stringify(next!.messages)).toContain('Remember HISTORY_MARKER')
    expect(JSON.stringify(next!.messages)).toContain('ANSWER_before')
  } finally {
    child?.kill()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
}, 90_000)

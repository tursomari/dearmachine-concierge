// Real DSH retry behavior against a loopback fixture; no credentials or products.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass an absolute built installer runtime root.')
const { DshAgentSession } = await import(join(runtime, 'packages/dsh-adapter/dist/index.mjs'))
const { saveModelHostProfile } = await import(join(runtime, 'packages/model-host/dist/index.mjs'))
const root = await mkdtemp(join(tmpdir(), 'empty-response-wire-'))
try {
  for (const mode of ['installer', 'management']) {
    const home = join(root, mode)
    await mkdir(home)
    const contract = join(home, 'INSTALL.md')
    await writeFile(contract, 'Local response fixture only. Do not install any product.\n')
    const marker = join(home, 'tool-count')
    let requests = 0
    let exhaust = false
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      requests++
      const call = !exhaust && requests === 2
      const answer = !exhaust && requests === 4
      const delta = call
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'count-once', type: 'function', function: {
          name: 'bash', arguments: JSON.stringify({ command: 'printf x >> tool-count', description: 'Count fixture execution' }),
        } }] }
        : answer ? { role: 'assistant', content: 'RESPONSE_READY' }
          : { role: 'assistant', reasoning_content: 'Fixture deliberation without an answer.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const profile = join(home, 'profile.json')
    await saveModelHostProfile(profile, { version: 1, driver: 'openai-compatible', provider: 'custom-openai-local',
      authMethod: 'optional_api_key', model: 'fixture-model', customProvider: { kind: 'openai-compatible', scope: 'local',
        name: 'Fixture', usesApiKey: false, chatCompletionsEndpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` } })
    let finish
    let publicText = ''
    const session = new DshAgentSession({ mode, dshHome: join(home, 'dsh'), workspace: home,
      modelProfilePath: profile, outcomePath: join(home, 'outcome.json'),
      selection: { provider: 'custom-openai-local', model: 'fixture-model' },
      environment: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
        XDG_DATA_HOME: join(home, '.local/share'), MACHTIANI_INSTALLER_CONTRACT: contract },
      onEvent(event) {
        if (event.type === 'assistant') publicText += event.text
        if (event.type === 'turn-end') finish?.(event)
      },
    })
    const turn = async text => {
      let timer
      const complete = new Promise((resolve, reject) => {
        finish = resolve
        timer = setTimeout(() => reject(new Error('Response fixture timed out.')), 30_000)
      })
      try { await session.prompt(text); return await complete }
      finally { clearTimeout(timer) }
    }
    try {
      await session.start()
      assert.equal((await turn('Run the harmless local fixture.')).outcome, 'completed')
      assert.equal(requests, 4, 'Retry each silent response without replaying the tool')
      assert.equal(await readFile(marker, 'utf8'), 'x')
      assert.equal(publicText, 'RESPONSE_READY')
      exhaust = true
      const result = await turn('Check bounded empty-response failure.')
      assert.equal(result.outcome, 'error')
      assert.equal(result.failureCode, 'EMPTY_RESPONSE')
      assert.equal(requests, 8, 'Stop after the initial request and three retries')
      console.log(`${mode}: reasoning-only recovery, no tool replay, and bounded failure PASS`)
    } finally {
      await session.shutdown()
      await new Promise(resolve => server.close(resolve))
    }
  }
} finally { await rm(root, { recursive: true, force: true }) }

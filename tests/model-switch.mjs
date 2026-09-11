// Real DSH profile switching and interruption; loopback only, no credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass an absolute built installer runtime root.')
const { DshAgentSession } = await import(join(runtime, 'packages/dsh-adapter/dist/index.mjs'))
const { saveModelHostProfile } = await import(join(runtime, 'packages/model-host/dist/index.mjs'))
const root = await mkdtemp(join(tmpdir(), 'model-switch-wire-'))
try {
  for (const mode of ['installer', 'management']) {
    const home = join(root, mode)
    await mkdir(home)
    const contract = join(home, 'INSTALL.md')
    await writeFile(contract, 'Local fixture only. Do not install anything.\n')
    const requests = []
    let hang = false
    let requested
    const servers = [0, 1].map(provider => createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const wire = JSON.parse(body)
      requests.push({ provider, ...wire })
      requested?.()
      if (hang) return
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: `ANSWER_${provider}` }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    }))
    for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const profile = join(home, 'profile.json')
    const select = (provider, model, reasoningEffort) => saveModelHostProfile(profile, {
      version: 1, driver: 'openai-compatible', provider: 'custom-openai-local', authMethod: 'optional_api_key', model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      customProvider: { kind: 'openai-compatible', scope: 'local', name: `Fixture ${provider}`, usesApiKey: false,
        chatCompletionsEndpoint: `http://127.0.0.1:${servers[provider].address().port}/v1/chat/completions` },
    })
    await select(0, 'before', 'high')
    let finish
    const session = new DshAgentSession({ mode, dshHome: join(home, 'dsh'), workspace: home,
      modelProfilePath: profile, outcomePath: join(home, 'outcome.json'),
      selection: { provider: 'custom-openai-local', model: 'before', reasoningEffort: 'high' },
      environment: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, 'state'),
        XDG_DATA_HOME: join(home, 'data'), MACHTIANI_INSTALLER_CONTRACT: contract },
      onEvent: event => { if (event.type === 'turn-end') finish?.(event) },
    })
    const turn = async text => {
      let timer
      const done = new Promise((resolve, reject) => {
        finish = resolve
        timer = setTimeout(() => reject(new Error(`${mode}: turn timed out`)), 20_000)
      })
      try { await session.prompt(text); return await done } finally { clearTimeout(timer) }
    }
    try {
      await session.start()
      const first = await turn('Remember HISTORY_MARKER.')
      assert.equal(first.outcome, 'completed', JSON.stringify({ first, requests, diagnostic: session.privateDiagnostic() }))
      hang = true
      const reached = new Promise(resolve => { requested = resolve })
      const cancelled = turn('Wait for the unavailable provider.')
      await reached
      await session.pause()
      assert.equal((await cancelled).outcome, 'aborted')
      hang = false
      await select(1, 'after')
      assert.equal((await turn('Continue HISTORY_MARKER.')).outcome, 'completed')
      const next = requests.at(-1)
      assert.equal(next.provider, 1)
      assert.equal(next.model, 'after')
      assert.equal(next.reasoning_effort, undefined, 'The old reasoning level must not leak into the new selection')
      assert.ok(JSON.stringify(next.messages).includes('Remember HISTORY_MARKER.'))
      assert.ok(JSON.stringify(next.messages).includes('ANSWER_0'))
      console.log(`${mode}: provider/model switch, cleared reasoning, interruption, and preserved history PASS`)
    } finally {
      await session.shutdown()
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
    }
  }
} finally { await rm(root, { recursive: true, force: true }) }

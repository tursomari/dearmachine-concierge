// Opt-in real Forge 2.13.21 gate. Run in the disposable container documented
// in TESTING.md, never with a real user HOME. No subscription authentication.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareForge21321 } from '/helper/index.mjs'
import { CredentialFileAdapter } from '/credentials/index.mjs'

function execute(command, args, options) {
  const request = promisify(execFile)(command, args, options)
  request.child.stdin?.end()
  return request
}

const home = await mkdtemp(join(tmpdir(), 'forge-custom-gate-'))
// This gate never calls an external provider or loads a real key. Explicit
// reasoning levels are rejected by the adapter: the pinned custom transport
// drops them. Do not silently run a human-approved high-reasoning model at its
// provider default just to turn this test into a credentialed live gate.
const key = 'fake-gateway-key'
const model = 'fixture-model'
const requests = []
let invalidRequest = false
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const data = JSON.parse(body)
    const reasoning = data.reasoning_effort ?? data.reasoning?.effort
    if (req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${key}` || data.model !== model || reasoning !== undefined) invalidRequest = true
    requests.push({ model: data.model, reasoning, path: req.url })
    console.log(`Local request ${requests.length}: model=${data.model}, reasoning=${reasoning}, stream=${Boolean(data.stream)}`)
    if (data.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'READY' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model, ...chunk })}\n\n`)
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  } catch { invalidRequest = true; res.writeHead(400); res.end('{}') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
try {
  const adapter = new CredentialFileAdapter({ home })
  await adapter.prepare('backend-provider', 'OpenAI')
  await adapter.save('backend-provider', 'unrelated-fixture')
  assert.equal(await adapter.prepare('backend-provider', 'Loopback gateway'), 'pending')
  await adapter.save('backend-provider', key)
  const reference = adapter.reference('backend-provider')
  const credential = reference.destination
  assert.equal(await adapter.prepare('backend-provider', 'Loopback gateway'), 'ready')
  await mkdir(join(home, '.forge'), { mode: 0o700 })
  const existing = { id: 'existing_gateway', api_key_vars: 'UNRELATED_API_KEY', url: 'https://example.invalid/chat/completions', auth_methods: ['api_key'] }
  await writeFile(join(home, '.forge', 'provider.json'), JSON.stringify([existing]), { mode: 0o600 })
  const receipt = await prepareForge21321({ home, providerEnvironmentPath: credential, provider: 'custom_gateway', model,
    customProvider: { endpoint, credentialVariable: reference.variable }, timeoutMs: 90_000 })
  assert.equal(receipt.probe, 'passed')
  console.log('Custom provider preparation passed; checking independent reuse.')
  assert.equal(receipt.provider, 'machtiani_custom_gateway')
  assert.deepEqual(JSON.parse(await readFile(join(home, '.forge', 'provider.json'), 'utf8'))[0], existing)
  const store = join(home, '.forge', '.credentials.json')
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')).map(value => value.id), ['machtiani_custom_gateway'])
  assert.equal((await lstat(store)).mode & 0o077, 0)
  await assert.rejects(lstat(join(home, '.env')), { code: 'ENOENT' })
  // Independent subsequent process, with no key environment or compatibility
  // file: proves ordinary backend invocations reuse Forge's private store.
  const env = { PATH: process.env.PATH, HOME: home, FORGE_TERM: 'false', SSL_CERT_FILE: process.env.SSL_CERT_FILE }
  const probe = await mkdtemp(join(tmpdir(), 'forge-reopen-gate-'))
  try {
    await execute('git', ['init', '--quiet', probe], { env })
    for (const args of [['config', 'path'], ['config', 'get', 'provider', '--porcelain'], ['config', 'get', 'model', '--porcelain']]) {
      console.log((await execute('forge', args, { env, timeout: 10_000 })).stdout.trim())
    }
    const reply = await execute('forge', ['-C', probe, '--prompt', 'Reply with exactly READY. Do not run tools or alter files.'], { env, timeout: 45_000, killSignal: 'SIGKILL' })
    assert.match(reply.stdout, /READY/u)
    assert.ok(!reply.stdout.includes(key) && !reply.stderr.includes(key))
  } finally { await rm(probe, { recursive: true, force: true }) }
  assert.ok(requests.length >= 2); assert.equal(invalidRequest, false)
  console.log('PASS: generic credential reference, loopback wire contract, real Forge custom provider, provider-default reasoning, preserved configuration, secret-free receipt, independent credential reuse')
} catch (error) {
  // Provider/CLI failures may contain upstream output: never emit it with keys.
  console.error('FAIL: custom Forge gate; private provider output suppressed')
  console.error(String(error).replaceAll(key, '[fixture key redacted]'))
  process.exitCode = 1
} finally {
  await new Promise(resolve => server.close(resolve))
  await rm(home, { recursive: true, force: true })
}

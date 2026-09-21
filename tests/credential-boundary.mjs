// Real DSH process, loopback-only model, disposable HOME and counterfeit keys.
// Never point this gate at a real credential store.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeZstdFrames } from './zstd-frames.mjs'
import { randomUUID } from 'node:crypto'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass an absolute installer runtime root containing packages/.')
const { DshAgentSession } = await import(join(runtime, 'packages/dsh-adapter/dist/index.mjs'))
const { saveModelHostProfile } = await import(join(runtime, 'packages/model-host/dist/index.mjs'))
const root = await mkdtemp(join(tmpdir(), 'credential-boundary-wire-'))
const keys = [0, 1, 2].map(() => `fixture-${randomUUID()}-not-a-provider-key`)
let failed = false
const clean = value => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  assert.ok(!keys.some(key => serialized.includes(key)), 'Credential reached a model request or retained event (value suppressed).')
}
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await scan(child)
    else if (entry.isFile()) {
      const bytes = await readFile(child)
      const compressed = entry.name.endsWith('.zstd')
      const text = (compressed ? decodeZstdFrames(bytes) : bytes).toString()
      if (compressed) for (const line of text.split('\n').filter(Boolean)) JSON.parse(line)
      clean(text)
    }
  }
}
try {
  for (const mode of ['management', 'installer']) {
    const home = join(root, mode)
    const workspace = join(home, 'workspace')
    const credentials = join(home, '.config/dearmachine/machtiani/credentials.env')
    await mkdir(join(home, '.config/dearmachine/machtiani'), { recursive: true, mode: 0o700 })
    await mkdir(workspace)
    await writeFile(credentials, `OPENROUTER_API_KEY=${keys[0]}\nDEEPSEEK_API_KEY=${keys[1]}\n`, { mode: 0o600 })
    await symlink(credentials, join(workspace, 'alias'))
    await link(credentials, join(workspace, 'hardlink'))
    await writeFile(join(workspace, 'copy.txt'), `Copied value: ${keys[0]}\n`, { mode: 0o600 })
    await writeFile(join(workspace, 'ordinary.toml'), 'backends = ["forge", "omp"]\n')
    const contract = join(workspace, 'INSTALL.md')
    await writeFile(contract, 'Credential-free security fixture; never install products or contact external services.\n')
    const calls = [
      ['read', { file_path: credentials }],
      ['read', { file_path: join(workspace, 'alias') }],
      ['read', { file_path: join(workspace, 'hardlink') }],
      ['read', { file_path: join(workspace, 'copy.txt') }],
      ['bash', { command: 'cat "$HOME/.config/dearmachine/machtiani/credentials.env"', description: 'Counterfeit stdout fixture' }],
      ['bash', { command: 'cat "$HOME/.config/dearmachine/machtiani/credentials.env" >&2; exit 1', description: 'Counterfeit stderr fixture' }],
      ['bash', { command: 'base64 "$HOME/.config/dearmachine/machtiani/credentials.env"', description: 'Counterfeit encoded fixture' }],
      ['bash', { command: 'fold -w 12 "$HOME/.config/dearmachine/machtiani/credentials.env"', description: 'Counterfeit split fixture' }],
      ['bash', { command: 'cat "$HOME/.config/dearmachine/machtiani/credentials.env"', description: 'Newly saved counterfeit credential' }],
      ['read', { file_path: join(workspace, 'ordinary.toml') }],
    ]
    let requests = 0
    let resolveTurn, rejectTurn
    const complete = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject })
    complete.catch(() => {})
    const server = createServer(async (request, response) => {
      try {
        let raw = ''
        for await (const chunk of request) raw += chunk
        clean(raw)
        assert.equal(request.headers.authorization, undefined)
        const body = JSON.parse(raw)
        if (requests > 0) {
          const result = body.messages.findLast(message => message.role === 'tool')
          assert.ok(result, 'Expected a tool result')
          assert.match(JSON.stringify(result.content), requests === calls.length ? /forge.*omp/s : /Credential access or output was blocked/)
        }
        // Simulate a trusted masked-field save, never an agent tool argument.
        if (requests === 8) await writeFile(credentials, `CUSTOM_API_KEY=${keys[2]}\n`, { mode: 0o600 })
        const call = calls[requests++]
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${requests}`, type: 'function',
          function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: 'assistant', content: 'CREDENTIAL_BOUNDARY_READY' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      } catch {
        failed = true
        rejectTurn(new Error('Credential boundary wire assertion failed; sensitive details suppressed.'))
        response.writeHead(400)
        response.end('Fixture security assertion failed.')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const profile = join(home, 'profile.json')
    await saveModelHostProfile(profile, { version: 1, driver: 'openai-compatible', provider: 'custom-openai-local',
      authMethod: 'optional_api_key', model: 'fixture-model', customProvider: { kind: 'openai-compatible', scope: 'local',
        name: 'Fixture', usesApiKey: false, chatCompletionsEndpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` } })
    const dshHome = join(home, 'dsh')
    const session = new DshAgentSession({ mode, dshHome, workspace, modelProfilePath: profile,
      outcomePath: join(home, 'outcome.json'), selection: { provider: 'custom-openai-local', model: 'fixture-model' },
      environment: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
        XDG_DATA_HOME: join(home, '.local/share'), MACHTIANI_INSTALLER_CONTRACT: contract },
      onEvent(event) {
        try {
          clean(event)
          if (event.type === 'turn-end') {
            assert.equal(event.outcome, 'completed')
            resolveTurn()
          }
        } catch { rejectTurn(new Error('Unsafe or incomplete session event; details suppressed.')) }
      },
    })
    const timer = setTimeout(() => rejectTurn(new Error('Credential gate timed out.')), 45_000)
    try {
      await session.start()
      await session.prompt('Run the local counterfeit security fixtures, then read the ordinary backend configuration.')
      await complete
      assert.equal(requests, calls.length + 1)
    } finally {
      clearTimeout(timer)
      await session.shutdown()
      await new Promise(resolve => server.close(resolve))
    }
    clean(session.privateDiagnostic())
    await scan(dshHome)
    console.log(`${mode}: protected reads, aliases, copies, stdout/stderr, encoding, mid-session save, ordinary config, wire and decoded trajectory PASS`)
  }
  assert.equal(failed, false)
} finally { await rm(root, { recursive: true, force: true }) }

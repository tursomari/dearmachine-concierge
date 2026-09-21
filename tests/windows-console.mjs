// Native Windows, real DSH and PowerShell, loopback model, no credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32', 'Run this gate on native Windows')
const runtime = process.argv[2]
assert.ok(runtime && isAbsolute(runtime), 'Pass an absolute built installer runtime')
const { DshAgentSession } = await import(pathToFileURL(join(runtime, 'packages/dsh-adapter/dist/index.mjs')))
const { saveModelHostProfile } = await import(pathToFileURL(join(runtime, 'packages/model-host/dist/index.mjs')))
const { runBounded } = await import(pathToFileURL(join(runtime, 'packages/backend-adapter/dist/index.mjs')))
const { SpawnCommandRunner } = await import(pathToFileURL(join(runtime, 'packages/product-adapter/dist/index.mjs')))
const root = await mkdtemp(join(tmpdir(), 'windows-console-'))
try {
  for (const mode of ['installer', 'management']) {
    const home = join(root, mode)
    await mkdir(home)
    const contract = join(home, 'INSTALL.md')
    await writeFile(contract, 'Local console fixture only. Do not install products or contact external services.\n')
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleFixture { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
Write-Output ('CONSOLE_HANDLE=' + [ConsoleFixture]::GetConsoleWindow().ToInt64())
Write-Progress -Activity 'WINDOWS_CONSOLE_PROGRESS_FIXTURE' -Status 'Synthetic work' -PercentComplete 50
Write-Output 'CAPTURED_TOOL_OUTPUT'
Write-Progress -Activity 'WINDOWS_CONSOLE_PROGRESS_FIXTURE' -Completed`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    if (mode === 'installer') {
      const command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
      const backend = await runBounded(command, home, process.env, 30_000)
      const product = await new SpawnCommandRunner().run({ label: 'Console fixture', command, cwd: home, environment: process.env })
      for (const [name, result] of [['backend probe', backend], ['product command', product]]) {
        assert.equal(result.code, 0)
        assert.match(result.stdout, /CONSOLE_HANDLE=0(?:\r|\n|$)/, `${name} must not have a console handle`)
        assert.match(result.stdout, /CAPTURED_TOOL_OUTPUT/)
        console.log(`${name}: native console absent and output captured PASS`)
      }
    }
    let requests = 0
    let rejectTurn, resolveTurn
    const complete = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject })
    complete.catch(() => {})
    const server = createServer(async (request, response) => {
      try {
        let raw = ''
        for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw)
        assert.equal(request.headers.authorization, undefined)
        if (requests > 0) {
          const result = JSON.stringify(body.messages.findLast(message => message.role === 'tool')?.content)
          assert.match(result, /CONSOLE_HANDLE=0(?:\\[rn]|\s|"|$)/, 'Tool must not have a console handle')
          assert.match(result, /CAPTURED_TOOL_OUTPUT/, 'Ordinary tool output must remain captured')
        }
        const call = requests++ === 0
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'console-fixture', type: 'function', function: {
          name: 'bash', arguments: JSON.stringify({ command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, description: 'Check native console isolation' }),
        } }] } : { role: 'assistant', content: 'CONSOLE_ISOLATION_READY' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      } catch (error) { rejectTurn(error); response.writeHead(400); response.end('Console fixture failed') }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const profile = join(home, 'profile.json')
    await saveModelHostProfile(profile, { version: 1, driver: 'openai-compatible', provider: 'custom-openai-local',
      authMethod: 'optional_api_key', model: 'fixture-model', customProvider: { kind: 'openai-compatible', scope: 'local',
        name: 'Fixture', usesApiKey: false, chatCompletionsEndpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` } })
    const session = new DshAgentSession({ mode, dshHome: join(home, 'dsh'), workspace: home, modelProfilePath: profile,
      outcomePath: join(home, 'outcome.json'), environment: { HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_DATA_HOME: join(home, '.local/share'),
        MACHTIANI_INSTALLER_CONTRACT: contract },
      onEvent(event) { if (event.type === 'turn-end') event.outcome === 'completed' ? resolveTurn() : rejectTurn(new Error('Console fixture turn failed')) },
    })
    const timer = setTimeout(() => rejectTurn(new Error('Console fixture timed out')), 90_000)
    try {
      await session.start()
      await session.prompt('Run the harmless local console fixture.')
      await complete
      assert.equal(requests, 2)
      console.log(`${mode}: native tool has no console and captured output survives PASS`)
    } finally { clearTimeout(timer); await session.shutdown(); await new Promise(resolve => server.close(resolve)) }
  }
} finally { await rm(root, { recursive: true, force: true }) }

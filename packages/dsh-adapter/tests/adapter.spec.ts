import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { describe, expect, it } from 'vitest'
import {
  DSH_NPM_VERSION,
  DSH_INTERRUPT_METHOD,
  DSH_SOURCE_REVISION,
  DshAgentSession,
  InstallerModelSetup,
  DshTaskExecutionError,
  INSTALLER_MODEL,
  INSTALLER_REASONING_EFFORT,
  normalizeDshSessionEvent,
  prepareIsolatedDshHome,
  loadInstallerModelSelection,
  saveInstallerModelSelection,
} from '../src/index.ts'

describe('pinned DSH compatibility boundary', () => {
  it('pins both package and reviewed source revisions', () => {
    expect(DSH_NPM_VERSION).toBe('0.1.2-rc.1')
    expect(DSH_SOURCE_REVISION).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('carries the installer-owned turn interruption extension in the pinned runtime', async () => {
    expect(DSH_INTERRUPT_METHOD).toBe('session/interrupt')
    const require = createRequire(import.meta.url)
    const runtimePackage = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-server/package.json')
    const runtime = await readFile(join(runtimePackage, '../lib/index.js'), 'utf8')
    expect(runtime).toContain('case "session/interrupt"')
    expect(runtime).toContain('agent.cancel({ kind: "user" })')

    const cancellations: unknown[] = []
    const agent = { id: 'agent-test', cancel: (cause: unknown) => { cancellations.push(cause) } }
    const server = new HarnessSdkJsonRpcServer({
      agents: { get: () => agent },
      on: () => () => {},
    } as never, { notify: () => {} } as never)
    Object.assign(server, { initialized: true })
    const sessions = (server as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set('session-test', { handle: { agent } })
    expect(server.interrupt({ sessionId: 'session-test' })).toEqual({})
    expect(cancellations).toEqual([{ kind: 'user' }])
  })

  it('writes a private isolated profile without credential values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-test-'))
    await prepareIsolatedDshHome(root)
    const patch = await readFile(join(root, 'profiles/machtiani-installer/cordis.patch.yml'), 'utf8')
    const profile = await readFile(join(root, 'profiles/machtiani-installer/package.json'), 'utf8')
    const storedSettings = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(patch).toContain(`model: ${JSON.stringify(INSTALLER_MODEL)}`)
    expect(patch).not.toContain('apiKeyEnv:')
    expect(patch).toContain('id: machtiani-model-host')
    expect(patch).toContain('id: machtiani-credential-policy')
    expect(patch).toContain('enableRunInBackground: false')
    expect(patch).toContain('id: tool-jobs\n  disabled: true')
    expect(patch).toContain('id: machtiani-installer-tools')
    expect(patch).toContain('id: goal\n  disabled: true')
    expect(patch).toContain('timeoutMs: 3600000')
    expect(patch).toContain('\n- id: sdk-app-startup\n')
    expect(patch).not.toContain('\n  - id: sdk-app-startup\n')
    expect(storedSettings).toContain(`reasoningEffort: "${INSTALLER_REASONING_EFFORT}"`)
    expect(profile).toContain('@deepseek-ai/dsh-sdk-app')
    expect(profile).not.toContain('@deepseek-ai/dsh-headless')
    expect(patch).toContain('profile: machtiani-installer')
    expect(`${patch}\n${storedSettings}`).not.toMatch(/(?:sk-or-v1-|api[_-]?key\s*:\s*[^A-Z\s])/iu)
    expect((await stat(join(root, 'settings.yaml'))).mode & 0o077).toBe(0)
  })

  it('writes a selected catalog route without placing credentials in configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-selection-'))
    await prepareIsolatedDshHome(root, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })
    const patch = await readFile(join(root, 'profiles/machtiani-installer/cordis.patch.yml'), 'utf8')
    const settings = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(patch).toContain('provider: "machtiani-model-host"')
    expect(settings).toContain('model: "deepseek-v4-flash"')
    expect(settings).toContain('reasoningEffort: "high"')
    expect(`${patch}\n${settings}`).not.toContain('API_KEY')
  })

  it('uses the pinned provider catalog and DSH private credential store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-model-setup-'))
    const secret = 'model-setup-private-value'
    const setup = await InstallerModelSetup.open(root, {})
    try {
      const providers = setup.providers()
      expect(providers.some(provider => provider.id === 'openrouter')).toBe(true)
      expect(providers.some(provider => provider.id === 'deepseek')).toBe(true)
      expect(providers.some(provider => provider.id === 'openai' && !provider.authMethods[0]?.subscription)).toBe(true)
      expect(providers.find(provider => provider.id === 'custom-openai-remote')).toMatchObject({ customScope: 'remote', authMethods: [] })
      expect(providers.find(provider => provider.id === 'custom-openai-local')).toMatchObject({ customScope: 'local', authMethods: [] })
      expect(providers.find(provider => provider.id === 'openai-codex')).toEqual({
        id: 'openai-codex',
        name: 'OpenAI Codex subscription',
        authMethods: [
          { id: 'oauth', label: 'Sign in with ChatGPT in your browser', description: 'Best for a local desktop install', subscription: true },
          { id: 'device_code', label: 'Sign in with a device code', description: 'Best for SSH, containers, or headless installs', subscription: true },
        ],
      })
      expect(providers.some(provider => provider.id === 'github-copilot' && provider.authMethods[0]?.subscription)).toBe(true)
      expect(providers.find(provider => provider.id === 'anthropic-claude')).toEqual({
        id: 'anthropic-claude',
        name: 'Anthropic Claude Pro/Max subscription',
        authMethods: [{ id: 'oauth', label: 'Sign in with Claude', subscription: true }],
      })
      expect(providers.some(provider => provider.id === 'radius')).toBe(false)
      expect((await setup.modelsFor('openrouter')).find(model => model.id === 'z-ai/glm-5.3-flash')?.reasoningEfforts)
        .toEqual(['low', 'high', 'max'])
      expect((await setup.modelsFor('deepseek')).find(model => model.id === 'deepseek-v4-flash')?.reasoningEfforts)
        .toEqual(['off', 'low', 'high', 'max'])
      expect(await setup.isAuthenticated('openrouter')).toBe(false)
      await setup.authenticate('openrouter', 'api_key', {
        prompt: async prompt => {
          expect(prompt.type).toBe('secret')
          return secret
        },
        notify: () => {},
      })
      expect(await setup.isAuthenticated('openrouter')).toBe(true)
    } finally {
      await setup.close()
    }
    const credentials = join(root, 'backends.env')
    expect((await stat(credentials)).mode & 0o077).toBe(0)
    expect(await readFile(credentials, 'utf8')).toContain(secret)

    const restarted = await InstallerModelSetup.open(root, {})
    try {
      expect(await restarted.isAuthenticated('openrouter')).toBe(true)
    } finally {
      await restarted.close()
    }
  })

  it('builds official-runtime profiles without copying subscription credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-subscription-'))
    const home = join(root, 'home')
    const setup = await InstallerModelSetup.open(join(root, 'dsh'), { HOME: home, CODEX_HOME: join(home, 'standalone-codex') }, { home })
    expect(setup.profileFor({ provider: 'openai-codex', model: 'gpt-test', reasoningEffort: 'high' })).toEqual({
      version: 1, driver: 'openai-codex-app-server', provider: 'openai-codex', authMethod: 'subscription',
      model: 'gpt-test', reasoningEffort: 'high', runtimeProfile: join(home, '.config', 'machtiani', 'codex'),
    })
    expect(setup.profileFor({ provider: 'github-copilot', model: 'copilot-test' })).toEqual({
      version: 1, driver: 'github-copilot-sdk', provider: 'github-copilot', authMethod: 'subscription',
      model: 'copilot-test', runtimeProfile: join(home, '.copilot'),
    })
    expect(setup.profileFor({ provider: 'anthropic-claude', model: 'sonnet', reasoningEffort: 'high' })).toEqual({
      version: 1, driver: 'anthropic-claude-agent-sdk', provider: 'anthropic-claude', authMethod: 'subscription',
      model: 'sonnet', reasoningEffort: 'high', runtimeProfile: join(home, '.config', 'machtiani', 'claude'),
    })
  })

  it('builds distinct remote and local custom profiles with optional credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-custom-profile-'))
    const setup = await InstallerModelSetup.open(root, {})
    expect(setup.profileFor({
      provider: 'custom-openai-remote', model: 'remote-model', reasoningEffort: 'high',
      customProvider: {
        kind: 'openai-compatible', scope: 'remote', name: 'Remote Models', usesApiKey: true,
        chatCompletionsEndpoint: 'https://models.example/v1/chat/completions',
      },
    })).toEqual({
      version: 1, driver: 'openai-compatible', provider: 'custom-openai-remote', authMethod: 'optional_api_key',
      model: 'remote-model', reasoningEffort: 'high',
      credential: { kind: 'environment-file', path: join(root, 'backends.env'), variable: 'MACHTIANI_CUSTOM_OPENAI_REMOTE_API_KEY' },
      customProvider: {
        kind: 'openai-compatible', scope: 'remote', name: 'Remote Models', usesApiKey: true,
        chatCompletionsEndpoint: 'https://models.example/v1/chat/completions',
      },
    })
    expect(setup.profileFor({
      provider: 'custom-openai-local', model: 'local-model',
      customProvider: {
        kind: 'openai-compatible', scope: 'local', name: 'Local Models', usesApiKey: false,
        chatCompletionsEndpoint: 'http://localhost:11434/v1/chat/completions',
      },
    })).toEqual({
      version: 1, driver: 'openai-compatible', provider: 'custom-openai-local', authMethod: 'optional_api_key',
      model: 'local-model',
      customProvider: {
        kind: 'openai-compatible', scope: 'local', name: 'Local Models', usesApiKey: false,
        chatCompletionsEndpoint: 'http://localhost:11434/v1/chat/completions',
      },
    })
  })

  it('persists only non-secret model selection in a private restart file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-model-selection-'))
    const selection = { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', reasoningEffort: 'high' }
    await saveInstallerModelSelection(root, selection)
    expect(await loadInstallerModelSelection(root)).toEqual(selection)
    expect((await stat(join(root, 'installer-model.json'))).mode & 0o077).toBe(0)
    await chmod(join(root, 'installer-model.json'), 0o644)
    await expect(loadInstallerModelSelection(root)).rejects.toThrow('private regular file')
  })

  it('imports an existing environment credential into the shared private store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-dsh-environment-auth-'))
    await chmod(root, 0o755)
    const setup = await InstallerModelSetup.open(root, { OPENROUTER_API_KEY: 'ambient-private-value' })
    try {
      expect(await setup.isAuthenticated('openrouter')).toBe(true)
    } finally {
      await setup.close()
    }
    expect((await stat(root)).mode & 0o077).toBe(0)
    const credentials = join(root, 'backends.env')
    expect((await stat(credentials)).mode & 0o077).toBe(0)
    expect(await readFile(credentials, 'utf8')).toContain('ambient-private-value')
  })

  it('normalizes only presentation-safe session events', () => {
    expect(normalizeDshSessionEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'considering' }, { type: 'text', text: 'Welcome.' }] } },
    })).toEqual({ type: 'assistant', text: 'Welcome.', reasoning: 'considering' })
    expect(normalizeDshSessionEvent({
      type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: 'private token' } },
    })).toEqual({ type: 'assistant-stream', channel: 'internal' })
    expect(normalizeDshSessionEvent({
      type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 1, text: 'visible token' } },
    })).toEqual({ type: 'assistant-stream', channel: 'visible' })
    expect(normalizeDshSessionEvent({
      type: 'assistant/chunk', data: { chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: 'private arguments' } },
    })).toEqual({ type: 'assistant-stream', channel: 'internal' })
    expect(JSON.stringify(normalizeDshSessionEvent({
      type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: 'private token' } },
    }))).not.toContain('private token')
    expect(normalizeDshSessionEvent({
      type: 'tool/call',
      data: {
        callId: 'call-1',
        name: 'bash',
        arguments: JSON.stringify({
          command: 'curl -H "Authorization: Bearer private-token" https://example.invalid',
          description: 'Check the installation environment',
        }),
      },
    })).toEqual({ type: 'tool-start', id: 'call-1', name: 'bash', detail: 'Check the installation environment' })
    expect(JSON.stringify(normalizeDshSessionEvent({
      type: 'tool/call',
      data: {
        callId: 'call-private',
        name: 'bash',
        arguments: JSON.stringify({ command: 'true', description: 'Use sk-private-value-now' }),
      },
    }))).not.toContain('sk-private-value-now')
    expect(normalizeDshSessionEvent({
      type: 'tool/call', data: { callId: 'call-read', name: 'read', arguments: '{"file_path":"docs/installation/01-environment.md"}' },
    })).toEqual({ type: 'tool-start', id: 'call-read', name: 'read', detail: 'docs/installation/01-environment.md' })
    expect(normalizeDshSessionEvent({
      type: 'tool/call', data: { callId: 'call-search', name: 'web_search', arguments: '{"queries":["one","two"]}' },
    })).toEqual({ type: 'tool-start', id: 'call-search', name: 'web_search', detail: '2 queries' })
    expect(normalizeDshSessionEvent({
      type: 'tool/call', data: { callId: 'call-unknown', name: 'custom', arguments: '{"private":"omitted"}' },
    })).toEqual({ type: 'tool-start', id: 'call-unknown', name: 'custom', detail: 'Working' })
    expect(normalizeDshSessionEvent({
      type: 'tool/call', data: { callId: 'call-update', name: 'request_dearmachine_update', arguments: '{"action":"check"}' },
    })).toEqual({ type: 'local-action', action: 'check-update' })
    expect(normalizeDshSessionEvent({
      type: 'tool/call', data: { callId: 'call-install', name: 'request_dearmachine_update', arguments: '{"action":"install"}' },
    })).toEqual({ type: 'local-action', action: 'install-update' })
    expect(normalizeDshSessionEvent({
      type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] } },
    })).toEqual({ type: 'tool-end', id: 'call-1', failed: false })
    expect(normalizeDshSessionEvent({
      type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: '[exit code: 124]' }] }] } },
    })).toEqual({ type: 'tool-end', id: 'call-2', failed: true })
    expect(normalizeDshSessionEvent({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })).toEqual({ type: 'turn-end', outcome: 'completed' })
    expect(normalizeDshSessionEvent({
      type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'private upstream detail', code: 'TIMEOUT' } } },
    })).toEqual({ type: 'turn-end', outcome: 'error', failureCode: 'TIMEOUT' })
    expect(JSON.stringify(normalizeDshSessionEvent({
      type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'private upstream detail', code: 'UNRECOGNIZED' } } },
    }))).not.toContain('private upstream detail')
  })

  it('keeps failed-task output out of the public error message', () => {
    const credential = 'adapter-test-secret'
    const error = new DshTaskExecutionError(1, {
      stdout: `response containing ${credential}`,
      stderr: `diagnostic containing ${credential}`,
    })
    expect(String(error)).not.toContain(credential)
    expect(error.privateDiagnostic()).toEqual({
      stdout: `response containing ${credential}`,
      stderr: `diagnostic containing ${credential}`,
    })
  })

  it('exposes session stderr only through the private diagnostic accessor', () => {
    const session = new DshAgentSession({
      dshHome: '/tmp/dsh-home', workspace: '/tmp/workspace',
      modelProfilePath: '/tmp/model-profile.json', outcomePath: '/tmp/outcome.json',
    })
    expect(session.privateDiagnostic()).toEqual({ stderr: '' })
    expect(JSON.stringify(session)).not.toContain('stderr')
  })
})

it('uses the shared model host with only the non-mutating concierge request tool in management mode', async () => {
 const root=await mkdtemp(join(tmpdir(), 'concierge-dsh-'))
 await prepareIsolatedDshHome(root, undefined, 'management')
 const patch=await readFile(join(root,'profiles','machtiani-installer','cordis.patch.yml'),'utf8')
 expect(patch).toContain('machtiani-model-host')
 expect(patch).toContain('management-system-prompt')
 expect(patch).toContain('machtiani-management-tools')
 expect(patch).not.toContain('machtiani-installer-tools')
 expect(patch).not.toContain('installer-system-prompt')
})

it('loads the installer system prompt before installer-only mutation tools', async () => {
 const root=await mkdtemp(join(tmpdir(), 'installer-dsh-prompt-'))
 await prepareIsolatedDshHome(root)
 const patch=await readFile(join(root,'profiles','machtiani-installer','cordis.patch.yml'),'utf8')
 expect(patch).toContain('installer-system-prompt')
 expect(patch.indexOf('installer-system-prompt')).toBeLessThan(patch.indexOf('machtiani-installer-tools'))
 expect(patch).not.toContain('management-system-prompt')
})

it('keeps one-shot task profiles free of installer and concierge role policy', async () => {
 const root=await mkdtemp(join(tmpdir(), 'task-dsh-prompt-'))
 await prepareIsolatedDshHome(root, undefined, 'task')
 const patch=await readFile(join(root,'profiles','machtiani-installer','cordis.patch.yml'),'utf8')
 expect(patch).toContain('machtiani-model-host')
 expect(patch).not.toContain('system-prompt')
 expect(patch).not.toContain('machtiani-installer-tools')
})

it.each([false, true])('bounds management shutdown when the provider protocol stops responding or fails (%s)', async fails => {
 const root=await mkdtemp(join(tmpdir(), 'concierge-shutdown-'))
 const session=new DshAgentSession({dshHome:root,workspace:root,modelProfilePath:join(root,'profile.json'),outcomePath:join(root,'unused.json'),mode:'management'})
 let stopped!:()=>void
 const exit=new Promise<number>(resolve=>{stopped=()=>resolve(0)})
 const signals:string[]=[]
 Object.assign(session,{child:{stdin:{write:(_data: string, callback: (error: Error | null) => void)=>{ if(fails) callback(new Error("protocol failed")) }},kill:(signal:string)=>{signals.push(signal);stopped()},stdout:{destroy:()=>{}},stderr:{destroy:()=>{}}},exit})
 await session.shutdown()
 expect(signals).toEqual(['SIGKILL'])
}, 1_500)

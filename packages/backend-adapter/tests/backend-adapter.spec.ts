import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentManagerBackendAdapter, loadPrivateEnvironment, prepareForge21321, type ProcessResult } from '../src/index.ts'

describe('backend adapter', () => {
  it('registers an arbitrary Chat Completions provider, imports only its key, and preserves other providers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-custom-'))
    await mkdir(join(home, '.forge'), { mode: 0o700 })
    const configuration = join(home, '.forge', 'provider.json')
    const existing = { id: 'existing', url: 'https://existing.invalid/chat/completions', auth_methods: ['api_key'] }
    await writeFile(configuration, JSON.stringify([existing]), { mode: 0o600 })
    const credential = join(home, 'backends.env')
    await writeFile(credential, 'GATEWAY_API_KEY=custom-fixture\nOPENAI_API_KEY=preserve-fixture\n', { mode: 0o600 })
    const run = async (command: readonly string[], _cwd: string, env: NodeJS.ProcessEnv): Promise<ProcessResult> => {
      expect(env.OPENAI_API_KEY).toBeUndefined()
      if (command.length === 1) {
        expect(env.GATEWAY_API_KEY).toBe('custom-fixture')
        const provider = JSON.parse(await readFile(configuration, 'utf8'))[1]
        expect(provider).toMatchObject({ id: 'machtiani_regional_gateway', api_key_vars: 'GATEWAY_API_KEY', response_type: 'OpenAI', url: 'https://gateway.invalid/v1/chat/completions' })
        await writeFile(join(home, '.forge', '.credentials.json'), JSON.stringify([{ id: 'machtiani_regional_gateway', type: 'api_key', api_key: 'custom-fixture' }]), { mode: 0o600 })
      } else expect(env.GATEWAY_API_KEY).toBeUndefined()
      const stdout = command.includes('--version') ? '2.13.21'
        : command.includes('get') ? command.includes('provider') ? 'MachtianiRegionalGateway' : command.includes('model') ? 'some/model' : 'high'
        : command.includes('--prompt') ? 'READY' : ''
      return { code: 0, stdout, stderr: '' }
    }
    const result = await prepareForge21321({ home, providerEnvironmentPath: credential, provider: 'regional_gateway', model: 'some/model',
      customProvider: { endpoint: 'https://gateway.invalid/v1/chat/completions', credentialVariable: 'GATEWAY_API_KEY' }, run })
    expect(result.probe).toBe('passed')
    expect(JSON.parse(await readFile(configuration, 'utf8'))[0]).toEqual(existing)
    expect(await readFile(configuration, 'utf8')).not.toContain('custom-fixture')
    await expect(lstat(join(home, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not claim high reasoning for a Forge custom provider when the pinned transport drops it', async () => {
    let called = false
    await expect(prepareForge21321({ home: '/unused', providerEnvironmentPath: '/unused', provider: 'gateway', model: 'model', reasoningEffort: 'high',
      customProvider: { endpoint: 'https://gateway.invalid/chat/completions', credentialVariable: 'GATEWAY_API_KEY' },
      run: async () => { called = true; return { code: 0, stdout: '', stderr: '' } } })).rejects.toThrow('does not forward reasoning effort')
    expect(called).toBe(false)
  })

  it.each(['https://user:secret@gateway.invalid/chat/completions', 'https://gateway.invalid/chat/completions?key=secret', 'file:///tmp/provider', 'http://remote.invalid/chat/completions'])('rejects unsafe custom endpoints before running Forge: %s', async endpoint => {
    const home = await mkdtemp(join(tmpdir(), 'forge-custom-url-'))
    const credential = join(home, 'backends.env')
    await writeFile(credential, 'GATEWAY_API_KEY=fixture\n', { mode: 0o600 })
    let called = false
    await expect(prepareForge21321({ home, providerEnvironmentPath: credential, provider: 'gateway', model: 'model',
      customProvider: { endpoint, credentialVariable: 'GATEWAY_API_KEY' }, run: async () => { called = true; return { code: 0, stdout: '2.13.21', stderr: '' } } })).rejects.toThrow('endpoint')
    expect(called).toBe(false)
  })

  it('refuses to replace an existing custom provider definition', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-custom-preserve-'))
    await mkdir(join(home, '.forge'))
    const path = join(home, '.forge', 'provider.json')
    const original = '[{"id":"machtiani_gateway","url":"https://existing.invalid/chat/completions","auth_methods":[]}]\n'
    await writeFile(path, original, { mode: 0o600 })
    const credential = join(home, 'backends.env')
    await writeFile(credential, 'GATEWAY_API_KEY=fixture\n', { mode: 0o600 })
    await expect(prepareForge21321({ home, providerEnvironmentPath: credential, provider: 'gateway', model: 'model',
      customProvider: { endpoint: 'https://new.invalid/chat/completions', credentialVariable: 'GATEWAY_API_KEY' },
      run: async () => ({ code: 0, stdout: '2.13.21', stderr: '' }) })).rejects.toThrow('different Forge custom provider')
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(lstat(join(home, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discovers only supported executable names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-discovery-'))
    for (const command of ['codex', 'omp']) {
      const path = join(root, command)
      await writeFile(path, '#!/bin/sh\nexit 0\n')
      await chmod(path, 0o700)
    }
    const adapter = new AgentManagerBackendAdapter({ environment: { PATH: `${root}:${process.env.PATH ?? ''}` } })
    const result = await adapter.discover()
    expect(result.map(candidate => candidate.name)).toEqual(expect.arrayContaining(['Codex', 'OMP']))
    expect(result.map(candidate => candidate.name)).not.toContain('Unknown')
  })

  it('runs an isolated functional health probe for every permitted candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-check-'))
    const manager = join(root, 'agent-manager')
    await writeFile(manager, `#!/usr/bin/env bash
set -euo pipefail
test "$1 $2" = 'backend health'
test -n "$DEARMACHINE_BACKENDS"
printf 'backend=%s\\nresult=ok\\n' "$3"
`)
    await chmod(manager, 0o700)
    const adapter = new AgentManagerBackendAdapter({ managerCommand: [manager] })
    const candidates = [
      { name: 'Codex', id: 'codex-yolo', executable: '/test/codex' },
      { name: 'Forge', id: 'forge', executable: '/test/forge' },
    ]
    await expect(adapter.check(candidates)).resolves.toEqual([
      { ...candidates[0], status: 'ready', summary: 'functional probe passed' },
      { ...candidates[1], status: 'ready', summary: 'functional probe passed' },
    ])
  })

  it('loads private assignments without accepting loose file permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-env-'))
    const path = join(root, 'backends.env')
    await writeFile(path, 'OPENROUTER_API_KEY=test-value\n', { mode: 0o600 })
    await expect(loadPrivateEnvironment(path)).resolves.toEqual({ OPENROUTER_API_KEY: 'test-value' })
    await chmod(path, 0o644)
    await expect(loadPrivateEnvironment(path)).rejects.toThrow('private regular file')
  })

  it('does not expose a provider credential to a backend unless its ID is explicitly compatible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-backend-env-boundary-'))
    const manager = join(root, 'agent-manager')
    const providerEnvironmentPath = join(root, 'backends.env')
    await writeFile(providerEnvironmentPath, 'OPENROUTER_API_KEY=backend-test-secret\n', { mode: 0o600 })
    await writeFile(manager, `#!/usr/bin/env bash
set -euo pipefail
test -z "\${OPENROUTER_API_KEY:-}"
test -z "\${GITHUB_TOKEN:-}"
test -z "\${AGENTMAIL_API_KEY:-}"
printf 'result=ok\n'
`)
    await chmod(manager, 0o700)
    const candidate = { name: 'Forge', id: 'forge', executable: '/test/forge' }
    const adapter = new AgentManagerBackendAdapter({
      managerCommand: [manager],
      providerEnvironmentPath,
      environment: {
        OPENROUTER_API_KEY: 'ambient-provider-secret',
        GITHUB_TOKEN: 'ambient-login-secret',
        AGENTMAIL_API_KEY: 'ambient-email-secret',
      },
    })
    await expect(adapter.check([candidate])).resolves.toEqual([
      { ...candidate, status: 'ready', summary: 'functional probe passed' },
    ])
  })

  it('prepares only the verified Forge version and always removes its temporary credential surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-forge-prepare-'))
    const home = join(root, 'home')
    const credential = join(root, 'backends.env')
    await mkdir(home)
    await writeFile(credential, 'OPENROUTER_API_KEY=forge-private-test-value\n', { mode: 0o600 })
    const commands: string[][] = []
    const run = async (command: readonly string[], _cwd: string, environment: NodeJS.ProcessEnv): Promise<ProcessResult> => {
      commands.push([...command])
      const isCredentialImport = command.length === 1 && command[0] === 'forge'
      if (!isCredentialImport) expect(environment.OPENROUTER_API_KEY).toBeUndefined()
      if (command.includes('--version')) return { code: 0, stdout: 'forge 2.13.21\n', stderr: '' }
      if (isCredentialImport) {
        expect(environment.OPENROUTER_API_KEY).toBe('forge-private-test-value')
        await mkdir(join(home, '.forge'), { recursive: true })
        await writeFile(join(home, '.forge', '.credentials.json'), '{}\n', { mode: 0o600 })
        return { code: 1, stdout: '', stderr: 'input closed after credential import' }
      }
      if (command.join(' ') === 'forge config get provider --porcelain') {
        return { code: 0, stdout: 'OpenRouter\n', stderr: '' }
      }
      if (command.join(' ') === 'forge config get model --porcelain') {
        return { code: 0, stdout: 'z-ai/glm-5.3-flash\n', stderr: '' }
      }
      if (command[0] === 'git') return { code: 0, stdout: '', stderr: '' }
      if (command.includes('--prompt')) return { code: 0, stdout: 'READY\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(prepareForge21321({
      home, providerEnvironmentPath: credential, provider: 'openrouter', model: 'z-ai/glm-5.3-flash', run,
    })).resolves.toEqual({
      version: '2.13.21', provider: 'openrouter', model: 'z-ai/glm-5.3-flash',
      credentialMigration: 'performed', probe: 'passed', compatibilitySurfaceCleanup: 'removed',
    })
    await expect(lstat(join(home, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(commands.find(command => command.includes('model'))).toEqual([
      'forge', 'config', 'set', 'model', 'open_router', 'z-ai/glm-5.3-flash',
    ])
    expect(commands).toContainEqual(['forge'])
    expect(commands).toContainEqual(['forge', 'config', 'get', 'provider', '--porcelain'])
    expect(commands).toContainEqual(['forge', 'config', 'get', 'model', '--porcelain'])
    expect(JSON.stringify(commands)).not.toContain('forge-private-test-value')
  })

  it.each(['high', 'medium'])('verifies requested reasoning before probing (readback %s)', async retained => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-forge-reasoning-'))
    const credential = join(home, 'backends.env')
    await writeFile(credential, 'OPENROUTER_API_KEY=forge-private-test-value\n', { mode: 0o600 })
    const commands: string[][] = []
    const run = async (command: readonly string[]): Promise<ProcessResult> => {
      commands.push([...command])
      if (command.length === 1) {
        await mkdir(join(home, '.forge'))
        await writeFile(join(home, '.forge', '.credentials.json'), '{}', { mode: 0o600 })
      }
      const stdout = command.includes('--version') ? '2.13.21'
        : command.includes('get') ? command.includes('provider') ? 'OpenRouter'
          : command.includes('model') ? 'model' : retained
        : command.includes('--prompt') ? 'READY' : ''
      return { code: 0, stdout, stderr: '' }
    }
    const result = prepareForge21321({
      home, providerEnvironmentPath: credential, provider: 'openrouter', model: 'model', reasoningEffort: 'high', run,
    })
    if (retained === 'high') {
      await expect(result).resolves.toMatchObject({ reasoningEffort: 'high', probe: 'passed' })
    } else {
      await expect(result).rejects.toThrow('did not retain the selected reasoning effort')
    }
    expect(commands).toContainEqual(['forge', 'config', 'set', 'reasoning-effort', 'high'])
    expect(commands).toContainEqual(['forge', 'config', 'get', 'reasoning-effort', '--porcelain'])
    expect(commands.some(command => command.includes('--prompt'))).toBe(retained === 'high')
    await expect(lstat(join(home, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects Forge authentication cancellation before attempting a live probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-forge-cancelled-auth-'))
    const home = join(root, 'home')
    const credential = join(root, 'backends.env')
    await mkdir(home)
    await writeFile(credential, 'OPENROUTER_API_KEY=forge-private-test-value\n', { mode: 0o600 })
    let liveProbeAttempted = false
    const cancelled = async (command: readonly string[]): Promise<ProcessResult> => {
      if (command.includes('--version')) return { code: 0, stdout: '2.13.21\n', stderr: '' }
      if (command.includes('--prompt')) {
        liveProbeAttempted = true
        return { code: 0, stdout: 'READY\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: 'API key input cancelled\n' }
    }

    await expect(prepareForge21321({
      home, providerEnvironmentPath: credential, provider: 'openrouter', model: 'model', run: cancelled,
    })).rejects.toThrow('did not import the selected provider credential')
    expect(liveProbeAttempted).toBe(false)
  })

  it('rejects a zero-exit Forge configuration command unless the selection was retained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-forge-unretained-config-'))
    const home = join(root, 'home')
    const credential = join(root, 'backends.env')
    await mkdir(home)
    await writeFile(credential, 'OPENROUTER_API_KEY=forge-private-test-value\n', { mode: 0o600 })
    let liveProbeAttempted = false
    const unretained = async (command: readonly string[]): Promise<ProcessResult> => {
      if (command.includes('--version')) return { code: 0, stdout: '2.13.21\n', stderr: '' }
      if (command.length === 1 && command[0] === 'forge') {
        await mkdir(join(home, '.forge'), { recursive: true })
        await writeFile(join(home, '.forge', '.credentials.json'), '{}\n', { mode: 0o600 })
        return { code: 1, stdout: '', stderr: 'input closed after credential import' }
      }
      if (command.includes('--prompt')) {
        liveProbeAttempted = true
        return { code: 0, stdout: 'READY\n', stderr: '' }
      }
      if (command.includes('get')) return { code: 0, stdout: 'Not set\n', stderr: '' }
      return { code: 0, stdout: '', stderr: 'API key input cancelled\n' }
    }

    await expect(prepareForge21321({
      home, providerEnvironmentPath: credential, provider: 'openrouter', model: 'model', run: unretained,
    })).rejects.toThrow('did not retain the selected provider and model')
    expect(liveProbeAttempted).toBe(false)
  })

  it('cleans the Forge compatibility link after a failed probe and refuses an existing path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-forge-cleanup-'))
    const home = join(root, 'home')
    const credential = join(root, 'backends.env')
    await mkdir(home)
    await writeFile(credential, 'OPENROUTER_API_KEY=forge-private-test-value\n', { mode: 0o600 })
    const failing = async (command: readonly string[]): Promise<ProcessResult> => {
      if (command.includes('--version')) return { code: 0, stdout: '2.13.21\n', stderr: '' }
      if (command.length === 1 && command[0] === 'forge') {
        await mkdir(join(home, '.forge'), { recursive: true })
        await writeFile(join(home, '.forge', '.credentials.json'), '{}\n', { mode: 0o600 })
        return { code: 1, stdout: '', stderr: 'input closed after credential import' }
      }
      if (command.join(' ') === 'forge config get provider --porcelain') {
        return { code: 0, stdout: 'open_router\n', stderr: '' }
      }
      if (command.join(' ') === 'forge config get model --porcelain') {
        return { code: 0, stdout: 'model\n', stderr: '' }
      }
      if (command[0] === 'git') return { code: 0, stdout: '', stderr: '' }
      if (command.includes('--prompt')) return { code: 1, stdout: '', stderr: 'private diagnostic' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(prepareForge21321({
      home, providerEnvironmentPath: credential, provider: 'openrouter', model: 'model', run: failing,
    })).rejects.toThrow('functional model probe failed')
    await expect(lstat(join(home, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(join(home, '.env'), 'preserve=true\n', { mode: 0o600 })
    await expect(prepareForge21321({
      home, providerEnvironmentPath: credential, provider: 'openrouter', model: 'model', run: failing,
    })).rejects.toThrow('refused to replace')
  })
})

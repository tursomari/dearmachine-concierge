import { appendFile, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandExecutionError, NativeProductInstaller, SpawnCommandRunner, type CommandRequest, type CommandRunner } from '../src/index.ts'

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = []

  constructor(protected readonly home: string) {}

  async run(request: CommandRequest) {
    this.requests.push(request)
    if (request.label === 'Verify Machtiani model roles') {
      return {
        code: 0,
        stdout: JSON.stringify({
          version: 1, status: 'ok',
          roles: ['planner', 'shell-agent', 'answer', 'file-discovery'].map(role => ({ role })),
        }),
        stderr: '',
      }
    }
    if ((request.command[0] === 'dearmachine' || request.command[0]?.endsWith('/dearmachine')) && request.command[1] === 'status') {
      return { code: 0, stdout: 'Dear Machine: running\nSupervisor: running\n\nInbox: inbox@example.test\nAuthorized sender: sender@example.test\nTransport: agentmail\n', stderr: '' }
    }
    if (request.label === 'Verify selected backend') return { code: 0, stdout: 'result=ok\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'machtiani-products-'))
  const home = join(root, 'home')
  const sourceRoot = join(root, 'source')
  const workspace = join(root, 'workspace')
  const journalPath = join(root, 'state', 'product-installation.json')
  await mkdir(join(home, '.config', 'dearmachine'), { recursive: true })
  await mkdir(join(home, '.config', 'machtiani'), { recursive: true })
  await mkdir(join(sourceRoot, 'machtiani-harness'), { recursive: true })
  await mkdir(join(sourceRoot, 'dearmachine'), { recursive: true })
  await mkdir(join(sourceRoot, 'machtiani-installer'), { recursive: true })
  await writeFile(join(sourceRoot, '.git'), 'fixture git marker')
  await writeFile(join(home, '.config', 'dearmachine', 'backends.env'), 'OPENROUTER_API_KEY=product-test-secret\n', { mode: 0o600 })
  await writeFile(join(home, '.config', 'machtiani', 'model-profile.json'), `${JSON.stringify({
    version: 1,
    driver: 'pi-ai',
    provider: 'openrouter',
    authMethod: 'api_key',
    model: 'z-ai/glm-5.3-flash',
    credential: {
      kind: 'environment-file',
      path: join(home, '.config', 'dearmachine', 'backends.env'),
      variable: 'OPENROUTER_API_KEY',
    },
  })}\n`, { mode: 0o600 })
  await writeFile(join(home, '.config', 'dearmachine', 'agentmail-api-key'), 'email-test-secret\n', { mode: 0o600 })
  const runner = new RecordingRunner(home)
  const installer = new NativeProductInstaller({ home, sourceRoot, workspace, journalPath, runner, environment: { PATH: '/usr/bin:/bin' } })
  return { home, sourceRoot, workspace, journalPath, runner, installer }
}

const selection = {
  provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', transport: 'AgentMail',
  authorizedSender: 'sender@example.test', detectedBackends: ['Codex'],
  backend: { name: 'Codex', id: 'codex-yolo', executable: '/usr/bin/codex', status: 'ready' as const, summary: 'functional probe passed' },
}

describe('native product installer', () => {
  it('matches one complete labeled inbox block from the current native status', async () => {
    const test = await fixture()
    class CurrentStatusRunner extends RecordingRunner {
      override async run(request: CommandRequest) {
        const result = await super.run(request)
        if (request.command[1] !== 'status') return result
        return { ...result, stdout: 'Dear Machine: running\nSupervisor: running\n\n' +
          'Inbox: unrelated@example.test\nAuthorized sender: other@example.test\nTransport: agentmail\n\n' +
          'Inbox: inbox@example.test\nAuthorized sender: SENDER@example.test\nTransport: agentmail\n' }
      }
    }
    await expect(new NativeProductInstaller({ ...test, runner: new CurrentStatusRunner(test.home) }).install(selection))
      .resolves.toEqual({ inboxAddress: 'inbox@example.test' })
  })

  it.each([
    ['Dear Machine: stopped\nSupervisor: running\n', 'sender@example.test', 'agentmail', 'running native client'],
    ['Dear Machine: running\n', 'other@example.test', 'agentmail', 'inbox could not be verified'],
    ['Dear Machine: running\n', 'sender@example.test', 'openmail', 'inbox could not be verified'],
  ])('rejects mismatched native status: %s %s %s', async (header, sender, transport, message) => {
    const test = await fixture()
    class InvalidStatusRunner extends RecordingRunner {
      override async run(request: CommandRequest) {
        const result = await super.run(request)
        if (request.command[1] !== 'status') return result
        return { ...result, stdout: `${header}\nInbox: inbox@example.test\nAuthorized sender: ${sender}\nTransport: ${transport}\n` }
      }
    }
    await expect(new NativeProductInstaller({ ...test, runner: new InvalidStatusRunner(test.home) }).install(selection))
      .rejects.toThrow(message)
  })

  it('verifies the correct inbox when native status includes labeled columns and other pairs', async () => {
    const test = await fixture()
    class LabeledStatusRunner extends RecordingRunner {
      override async run(request: CommandRequest) {
        const result = await super.run(request)
        if (request.command[1] !== 'status') return result
        return { ...result, stdout: 'DearMachine is running (PID 42).\n' +
          'Pair UUID\tAuthorized sender\tDear Machine inbox\tTransport\n' +
          'other-pair\tother@example.test\tunrelated@example.test\tagentmail\n' +
          'pair-id\tsender@example.test\tinbox@example.test\tagentmail\n' }
      }
    }
    const installer = new NativeProductInstaller({
      ...test, runner: new LabeledStatusRunner(test.home), environment: { PATH: '/usr/bin:/bin' },
    })
    await expect(installer.install(selection)).resolves.toEqual({ inboxAddress: 'inbox@example.test' })
  })

  it('configures supplied products without Nix and retains the exact model host path', async () => {
    const test = await fixture()
    const distribution = {
      manifestPath: join(test.sourceRoot, 'distribution.json'), sourceRoot: test.sourceRoot,
      binaries: { dearmachine: '/release/bin/dearmachine', machtiani: '/release/bin/machtiani',
        modelHost: '/release/bin/machtiani-model-host', agentManager: '/release/bin/agent-manager' },
    }
    const installer = new NativeProductInstaller({ ...test, distribution })
    expect(await installer.install(selection)).toEqual({ inboxAddress: 'inbox@example.test' })
    expect(test.runner.requests.some(request => request.command[0] === 'nix')).toBe(false)
    expect(test.runner.requests.some(request => request.command.includes('status') && request.command[0] === 'git')).toBe(false)
    expect(test.runner.requests.find(request => request.label === 'Verify Machtiani model roles')?.command[0]).toBe(distribution.binaries.machtiani)
    expect(await readFile(join(test.home, '.config/dearmachine/machtiani/config.toml'), 'utf8')).toContain('command = "/release/bin/machtiani-model-host"')
    await expect(new NativeProductInstaller(test).install(selection)).rejects.toThrow('installation method')
  })
  it('verifies only live email activity appended after its private baseline', async () => {
    const test = await fixture()
    const logDirectory = join(test.home, '.dearmachine', 'log')
    const logPath = join(logDirectory, 'dearmachine.log')
    await mkdir(logDirectory, { recursive: true })
    await writeFile(logPath, 'dearmachine: processed message=old result=answer\n', { mode: 0o600 })
    const installer = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner: test.runner, environment: { PATH: '/usr/bin:/bin' },
      liveEmailPollMs: 5, liveEmailTimeoutMs: 500,
    })
    const baseline = await installer.captureLiveEmailBaseline()
    const updates: string[] = []
    setTimeout(() => { void appendFile(logPath, 'dearmachine: poll: 1 unread messages\n') }, 10)
    setTimeout(() => { void appendFile(logPath, 'dearmachine: processed message=new result=answer\n') }, 30)
    await expect(installer.waitForLiveEmail(baseline, message => updates.push(message))).resolves.toBeUndefined()
    expect(updates).toContain('Dear Machine received your email')
    expect(updates.at(-1)).toBe('Dear Machine sent the reply')
  })

  it('rejects an invalid live email baseline before reading historical activity', async () => {
    const test = await fixture()
    const installer = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner: test.runner, environment: { PATH: '/usr/bin:/bin' },
    })
    await expect(installer.waitForLiveEmail('{"version":1}', () => {})).rejects.toThrow('baseline is invalid')
  })

  it('configures DearMachine without changing an existing standalone configuration', async () => {
    const test = await fixture()
    const personal = join(test.home, '.config/machtiani/config.toml')
    await writeFile(personal, 'personal sentinel\n')
    await mkdir(join(test.home, '.machtiani'), { recursive: true })
    const installer = new NativeProductInstaller({ home: test.home, sourceRoot: test.sourceRoot,
      workspace: test.workspace, journalPath: test.journalPath, runner: test.runner })
    await installer.install(selection)
    expect(await readFile(personal, 'utf8')).toBe('personal sentinel\n')
    expect(await readFile(join(test.home, '.config/dearmachine/machtiani/config.toml'), 'utf8')).toContain('dearmachine-host')
    for (const request of test.runner.requests) {
      expect(request.environment.MACHTIANI_CONFIG).toBe(join(test.home, '.config/dearmachine/machtiani/config.toml'))
    }
  })

  it('executes the canonical fresh-install order without placing credentials in arguments', async () => {
    const test = await fixture()
    const progress: string[] = []
    const installer = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner: test.runner, environment: { PATH: '/usr/bin:/bin' },
      progress: message => progress.push(message),
    })
    await expect(installer.install(selection)).resolves.toEqual({ inboxAddress: 'inbox@example.test' })
    expect(test.runner.requests.map(request => request.label)).toEqual([
      'Source checkout preflight',
      'Install coordinated release', 'Verify shared model host', 'Check Machtiani configuration',
      'Verify Machtiani model roles',
      'Verify installed commands', 'Configure selected backend', 'Create Dear Machine pair',
      'Verify Dear Machine status', 'Verify selected backend', 'Verify source checkout',
    ])
    expect(progress).toEqual(test.runner.requests.map(request => request.label))
    expect(test.runner.requests.flatMap(request => request.command).join('\n')).not.toContain('product-test-secret')
    expect(test.runner.requests.flatMap(request => request.command).join('\n')).not.toContain('email-test-secret')
    expect(test.runner.requests.find(request => request.label === 'Check Machtiani configuration')?.command).toEqual([
      'machtiani', 'config', 'check',
    ])
    expect(test.runner.requests.find(request => request.label === 'Verify shared model host')?.command).toEqual([
      'sh', '-c', 'test -x "$1"', 'verify-model-host', join(test.home, '.local', 'bin', 'machtiani-model-host'),
    ])
    expect(test.runner.requests.find(request => request.label === 'Verify Machtiani model roles')?.command).toEqual([
      'machtiani', 'verify', '--json',
    ])
    expect(test.runner.requests.find(request => request.label === 'Install coordinated release')?.command.slice(-3)).toEqual([
      'install', '--source-root', test.sourceRoot,
    ])
    expect(test.runner.requests.find(request => request.label === 'Verify Machtiani model roles')?.environment.MACHTIANI_CONFIG).toBe(
      join(test.home, '.config', 'dearmachine', 'machtiani', 'config.toml'),
    )
    expect(test.runner.requests.find(request => request.label === 'Configure selected backend')?.stdin).toBe('\n')
    expect(test.runner.requests.find(request => request.label === 'Create Dear Machine pair')?.command).toContain('--new-inbox')
    expect(test.runner.requests.find(request => request.label === 'Create Dear Machine pair')?.timeoutMs).toBeNull()
    expect(test.runner.requests.find(request => request.label === 'Verify selected backend')?.cwd).toBe(join(test.home, '.dearmachine', 'entrypoint', 'main'))
    const machtianiConfig = await readFile(join(test.home, '.config', 'dearmachine', 'machtiani', 'config.toml'), 'utf8')
    expect(machtianiConfig).toContain('[model_defaults]')
    expect(machtianiConfig).toContain('cache_enabled = true')
    expect(machtianiConfig).toContain('cache_control = { type = "ephemeral" }')
    expect(machtianiConfig).toContain(`command = ${JSON.stringify(join(test.home, '.local', 'bin', 'machtiani-model-host'))}`)
    expect(await readFile(join(test.home, '.dearmachine', 'config', 'dearmachine.toml'), 'utf8')).toBe(
      'version = 1\nbackends = ["codex-yolo"]\nresponse_tier = "formatted"\n',
    )
    const journal = await readFile(test.journalPath, 'utf8')
    expect(journal).toContain('"stage": "verified"')
    expect(journal).not.toContain('product-test-secret')
    expect(journal).not.toContain('email-test-secret')
    expect((await stat(test.journalPath)).mode & 0o077).toBe(0)
  })

  it.each([
    { provider: 'openai-codex', model: 'gpt-5.6-luna', driver: 'openai-codex-app-server' },
    { provider: 'anthropic-claude', model: 'sonnet', driver: 'anthropic-claude-agent-sdk' },
  ])('installs with provider-owned $provider authentication and no API-key file', async ({ provider, model, driver }) => {
    const test = await fixture()
    await unlink(join(test.home, '.config', 'dearmachine', 'backends.env'))
    const modelProfilePath = join(test.home, '.config', 'machtiani', 'model-profile.json')
    await mkdir(join(test.home, '.config', 'machtiani'), { recursive: true })
    await writeFile(modelProfilePath, `${JSON.stringify({
      version: 1, provider, model, driver, authMethod: 'subscription',
      runtimeProfile: join(test.home, '.config', 'machtiani', provider),
    })}\n`, { mode: 0o600 })
    const installer = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner: test.runner, environment: { PATH: '/usr/bin:/bin' }, modelProfilePath,
    })

    await expect(installer.install({ ...selection, provider, model })).resolves.toEqual({ inboxAddress: 'inbox@example.test' })
    const config = await readFile(join(test.home, '.config', 'dearmachine', 'machtiani', 'config.toml'), 'utf8')
    expect(config).toContain(`profile = ${JSON.stringify(modelProfilePath)}`)
    expect(config).toContain('model = "@machtiani/planner"')
    expect(test.runner.requests.filter(request => request.label === 'Verify Machtiani model roles')).toHaveLength(1)
  })

  it('installs every role through the wizard-owned custom Chat Completions profile', async () => {
    const test = await fixture()
    await unlink(join(test.home, '.config', 'dearmachine', 'backends.env'))
    const modelProfilePath = join(test.home, '.config', 'machtiani', 'model-profile.json')
    await writeFile(modelProfilePath, `${JSON.stringify({
      version: 1,
      driver: 'openai-compatible',
      provider: 'custom-openai-local',
      authMethod: 'optional_api_key',
      model: 'local-model',
      customProvider: {
        kind: 'openai-compatible',
        scope: 'local',
        name: 'Local model server',
        chatCompletionsEndpoint: 'http://localhost:11434/v1/chat/completions',
        usesApiKey: false,
      },
    })}\n`, { mode: 0o600 })

    await expect(test.installer.install({
      ...selection,
      provider: 'custom-openai-local',
      model: 'local-model',
    })).resolves.toEqual({ inboxAddress: 'inbox@example.test' })

    const config = await readFile(join(test.home, '.config', 'dearmachine', 'machtiani', 'config.toml'), 'utf8')
    expect(config).toContain(`profile = ${JSON.stringify(modelProfilePath)}`)
    expect(config).toContain('default_model = "dearmachine"')
    expect(config).toContain('shell_agent_model = "dearmachine-shell-agent"')
    expect(config).toContain('answer_model = "dearmachine"')
    expect(config).toContain('file_discovery_model = "dearmachine"')
    expect(test.runner.requests.filter(request => request.label === 'Verify Machtiani model roles')).toHaveLength(1)
  })

  it('refuses product installation when the wizard-owned model profile is absent', async () => {
    const test = await fixture()
    await unlink(join(test.home, '.config', 'machtiani', 'model-profile.json'))

    await expect(test.installer.install(selection)).rejects.toThrow('shared model profile')
    expect(test.runner.requests).toEqual([])
  })

  it('stops before Dear Machine installation when any Machtiani role is unverified', async () => {
    const test = await fixture()
    class IncompleteVerificationRunner extends RecordingRunner {
      override async run(request: CommandRequest) {
        if (request.label === 'Verify Machtiani model roles') {
          this.requests.push(request)
          return { code: 0, stdout: '{"version":1,"status":"ok","roles":[{"role":"planner"}]}', stderr: '' }
        }
        return await super.run(request)
      }
    }
    const runner = new IncompleteVerificationRunner(test.home)
    const installer = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner, environment: { PATH: '/usr/bin:/bin' },
    })

    await expect(installer.install(selection)).rejects.toThrow('did not verify every configured model role')
    expect(runner.requests.some(request => request.label === 'Install Dear Machine')).toBe(false)
  })

  it('uses an explicitly pre-provisioned inbox for the live disposable-resource gate', async () => {
    const test = await fixture()
    const installer = new NativeProductInstaller({
      home: test.home,
      sourceRoot: test.sourceRoot,
      workspace: test.workspace,
      journalPath: test.journalPath,
      runner: test.runner,
      environment: { PATH: '/usr/bin:/bin' },
      existingInboxId: 'inbox-qse-owned',
      reasoningEffort: 'high',
    })
    await installer.install(selection)
    const command = test.runner.requests.find(request => request.label === 'Create Dear Machine pair')?.command
    expect(command).toContain('--inbox')
    expect(command).toContain('inbox-qse-owned')
    expect(command).not.toContain('--new-inbox')
    expect(await readFile(join(test.home, '.config', 'dearmachine', 'machtiani', 'config.toml'), 'utf8')).not.toContain('effort =')
    const journal = await readFile(test.journalPath, 'utf8')
    expect(journal).toContain('"existingInboxIdHash"')
    expect(journal).toContain('"reasoningEffort": "high"')
    expect(journal).not.toContain('inbox-qse-owned')
  })

  it('refuses an existing Dear Machine state tree before running any command', async () => {
    const test = await fixture()
    await mkdir(join(test.home, '.dearmachine'), { recursive: true })
    await writeFile(join(test.home, '.dearmachine', 'existing-state'), 'preserve me\n')
    await expect(test.installer.install(selection)).rejects.toThrow('will not change its pairs, inboxes, or running client')
    expect(test.runner.requests).toEqual([])
  })

  it('does not expose captured command diagnostics through thrown errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-command-redaction-'))
    const runner = new SpawnCommandRunner()
    const request = {
      label: 'Private provider check',
      command: ['sh', '-c', 'printf "%s" "$PRIVATE_TEST_VALUE" >&2; exit 19'],
      cwd: root,
      environment: { ...process.env, PRIVATE_TEST_VALUE: 'command-test-secret' },
    }
    await expect(runner.run(request)).rejects.toThrow('Private provider check failed with status 19')
    try {
      await runner.run(request)
    } catch (error) {
      expect(String(error)).not.toContain('command-test-secret')
      expect(error).toBeInstanceOf(CommandExecutionError)
      expect((error as CommandExecutionError).privateDiagnostic().stderr).toBe('command-test-secret')
    }
  })

  it('retains a private redacted command diagnostic when requested', async () => {
    const test = await fixture()
    class FailingRunner extends RecordingRunner {
      override async run(request: CommandRequest) {
        if (request.label === 'Check Machtiani configuration') {
          this.requests.push(request)
          throw new CommandExecutionError(request.label, 1, {
            code: 1,
            stdout: 'safe provider detail product-test-secret',
            stderr: 'safe transport detail email-test-secret',
          })
        }
        return await super.run(request)
      }
    }
    const diagnosticPath = join(test.home, '.local', 'state', 'machtiani-installer', 'product-command-diagnostic.json')
    const installer = new NativeProductInstaller({
      home: test.home,
      sourceRoot: test.sourceRoot,
      workspace: test.workspace,
      journalPath: test.journalPath,
      diagnosticPath,
      runner: new FailingRunner(test.home),
      environment: { PATH: '/usr/bin:/bin' },
    })
    await expect(installer.install(selection)).rejects.toThrow('Check Machtiani configuration failed')
    const diagnostic = await readFile(diagnosticPath, 'utf8')
    expect(diagnostic).toContain('safe provider detail [REDACTED]')
    expect(diagnostic).toContain('safe transport detail [REDACTED]')
    expect(diagnostic).not.toContain('product-test-secret')
    expect(diagnostic).not.toContain('email-test-secret')
    expect((await stat(diagnosticPath)).mode & 0o077).toBe(0)
  })

  it('recovers a proven matching pair after interruption without creating another inbox', async () => {
    const test = await fixture()
    class InterruptedPairRunner extends RecordingRunner {
      override async run(request: CommandRequest) {
        if (request.label === 'Create Dear Machine pair') {
          this.requests.push(request)
          throw new CommandExecutionError(request.label, 1, { code: 1, stdout: '', stderr: 'private interrupted diagnostic' })
        }
        return await super.run(request)
      }
    }
    const interrupted = new InterruptedPairRunner(test.home)
    const first = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner: interrupted, environment: { PATH: '/usr/bin:/bin' },
    })
    await expect(first.install(selection)).rejects.toThrow('Create Dear Machine pair failed')
    expect(await readFile(test.journalPath, 'utf8')).toContain('"stage": "pair-creation-started"')

    const resumedRunner = new RecordingRunner(test.home)
    const resumed = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner: resumedRunner, environment: { PATH: '/usr/bin:/bin' },
    })
    await expect(resumed.install(selection)).resolves.toEqual({ inboxAddress: 'inbox@example.test' })
    expect(resumedRunner.requests.some(request => request.label === 'Create Dear Machine pair')).toBe(false)
    expect(resumedRunner.requests[0]?.label).toBe('Inspect interrupted pair creation')
  })

  it('refuses to request a second inbox when interrupted pair creation is ambiguous', async () => {
    const test = await fixture()
    class InterruptedPairRunner extends RecordingRunner {
      override async run(request: CommandRequest) {
        if (request.label === 'Create Dear Machine pair') {
          this.requests.push(request)
          throw new CommandExecutionError(request.label, 1, { code: 1, stdout: '', stderr: 'private interrupted diagnostic' })
        }
        return await super.run(request)
      }
    }
    const first = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner: new InterruptedPairRunner(test.home), environment: { PATH: '/usr/bin:/bin' },
    })
    await expect(first.install(selection)).rejects.toThrow('Create Dear Machine pair failed')

    class NoPairRunner extends RecordingRunner {
      override async run(request: CommandRequest) {
        if (request.label === 'Inspect interrupted pair creation') {
          this.requests.push(request)
          return { code: 0, stdout: 'DearMachine is stopped.\nNo pairs are registered.\n', stderr: '' }
        }
        return await super.run(request)
      }
    }
    const resumedRunner = new NoPairRunner(test.home)
    const resumed = new NativeProductInstaller({
      home: test.home, sourceRoot: test.sourceRoot, workspace: test.workspace,
      journalPath: test.journalPath, runner: resumedRunner, environment: { PATH: '/usr/bin:/bin' },
    })
    await expect(resumed.install(selection)).rejects.toThrow('will not request another remote inbox automatically')
    expect(resumedRunner.requests.some(request => request.label === 'Create Dear Machine pair')).toBe(false)
  })
})

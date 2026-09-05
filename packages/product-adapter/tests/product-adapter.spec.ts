import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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
    if (request.command[0] === 'dearmachine' && request.command[1] === 'status') {
      return { code: 0, stdout: 'DearMachine is running (PID 42).\npair-id\tsender@example.test\tinbox@example.test\tagentmail\n', stderr: '' }
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
  await mkdir(join(sourceRoot, 'machtiani-harness'), { recursive: true })
  await mkdir(join(sourceRoot, 'dearmachine'), { recursive: true })
  await mkdir(join(sourceRoot, 'machtiani-installer'), { recursive: true })
  await writeFile(join(home, '.config', 'dearmachine', 'backends.env'), 'OPENROUTER_API_KEY=product-test-secret\n', { mode: 0o600 })
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
      'Install Machtiani', 'Install shared model host', 'Verify shared model host', 'Check Machtiani configuration',
      'Verify Machtiani model roles',
      'Install Dear Machine', 'Verify installed commands', 'Configure selected backend', 'Create Dear Machine pair',
      'Verify Dear Machine status', 'Verify selected backend', 'Verify source checkout',
    ])
    expect(progress).toEqual(test.runner.requests.map(request => request.label))
    expect(test.runner.requests.flatMap(request => request.command).join('\n')).not.toContain('product-test-secret')
    expect(test.runner.requests.flatMap(request => request.command).join('\n')).not.toContain('email-test-secret')
    expect(test.runner.requests.find(request => request.label === 'Check Machtiani configuration')?.command).toEqual([
      'machtiani', 'config', 'check',
    ])
    expect(test.runner.requests.find(request => request.label === 'Verify shared model host')?.command).toEqual([
      'sh', '-c', 'test -x "$1"', 'verify-model-host', join(test.home, '.nix-profile', 'bin', 'machtiani-model-host'),
    ])
    expect(test.runner.requests.find(request => request.label === 'Verify Machtiani model roles')?.command).toEqual([
      'machtiani', 'verify', '--json',
    ])
    expect(test.runner.requests.find(request => request.label === 'Verify Machtiani model roles')?.environment.MACHTIANI_CONFIG).toBe(
      join(test.home, '.machtiani', 'config.toml'),
    )
    expect(test.runner.requests.find(request => request.label === 'Configure selected backend')?.stdin).toBe('\n')
    expect(test.runner.requests.find(request => request.label === 'Create Dear Machine pair')?.command).toContain('--new-inbox')
    expect(test.runner.requests.find(request => request.label === 'Create Dear Machine pair')?.timeoutMs).toBeNull()
    expect(test.runner.requests.find(request => request.label === 'Verify selected backend')?.cwd).toBe(join(test.home, '.dearmachine', 'entrypoint', 'main'))
    const machtianiConfig = await readFile(join(test.home, '.machtiani', 'config.toml'), 'utf8')
    expect(machtianiConfig).toContain('[model_defaults]')
    expect(machtianiConfig).toContain('cache_enabled = true')
    expect(machtianiConfig).toContain('cache_control = { type = "ephemeral" }')
    expect(machtianiConfig).toContain(`command = ${JSON.stringify(join(test.home, '.nix-profile', 'bin', 'machtiani-model-host'))}`)
    expect(await readFile(join(test.home, '.dearmachine', 'config', 'dearmachine.toml'), 'utf8')).toBe(
      'version = 1\nbackends = ["codex-yolo"]\nresponse_tier = "formatted"\n',
    )
    const journal = await readFile(test.journalPath, 'utf8')
    expect(journal).toContain('"stage": "verified"')
    expect(journal).not.toContain('product-test-secret')
    expect(journal).not.toContain('email-test-secret')
    expect((await stat(test.journalPath)).mode & 0o077).toBe(0)
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
    expect(await readFile(join(test.home, '.machtiani', 'config.toml'), 'utf8')).toContain('effort = "high"')
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

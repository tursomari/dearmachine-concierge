import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandExecutionError, NativeProductInstaller, SpawnCommandRunner, type CommandRequest, type CommandRunner } from '../src/index.ts'

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = []

  constructor(protected readonly home: string) {}

  async run(request: CommandRequest) {
    this.requests.push(request)
    if (request.label === 'Configure Machtiani') {
      await mkdir(join(this.home, '.machtiani'), { recursive: true })
      await writeFile(join(this.home, '.machtiani', 'config.toml'), `default_model = "dearmachine"
model = "z-ai/glm-5.3-flash"
provider = "openrouter"
api_key = "\${OPENROUTER_API_KEY}"
`, { mode: 0o600 })
    }
    if (request.label === 'Check Machtiani provider') return { code: 0, stdout: 'MACHTIANI_PROVIDER_OK\n', stderr: '' }
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
  it('executes the canonical fresh-install order without placing credentials in arguments', async () => {
    const test = await fixture()
    await expect(test.installer.install(selection)).resolves.toEqual({ inboxAddress: 'inbox@example.test' })
    expect(test.runner.requests.map(request => request.label)).toEqual([
      'Source checkout preflight',
      'Install Machtiani', 'Configure Machtiani',
      'Initialize provider-check workspace', 'Configure provider-check identity', 'Configure provider-check email',
      'Stage provider-check workspace', 'Commit provider-check workspace',
      'Synchronize Machtiani provider check', 'Check Machtiani provider',
      'Install Dear Machine', 'Verify installed commands', 'Configure selected backend', 'Create Dear Machine pair',
      'Verify Dear Machine status', 'Verify selected backend', 'Verify source checkout',
    ])
    expect(test.runner.requests.flatMap(request => request.command).join('\n')).not.toContain('product-test-secret')
    expect(test.runner.requests.flatMap(request => request.command).join('\n')).not.toContain('email-test-secret')
    expect(test.runner.requests.find(request => request.label === 'Configure Machtiani')?.command).toEqual([
      'machtiani', 'init', '--no-interactive', '--config-scope', 'global', '--preset', 'openrouter',
      '--model', 'z-ai/glm-5.3-flash', '--alias', 'dearmachine', '--api-key-env', 'OPENROUTER_API_KEY',
    ])
    expect(test.runner.requests.find(request => request.label === 'Configure selected backend')?.stdin).toBe('\n')
    expect(test.runner.requests.find(request => request.label === 'Create Dear Machine pair')?.command).toContain('--new-inbox')
    expect(test.runner.requests.find(request => request.label === 'Verify selected backend')?.cwd).toBe(join(test.home, '.dearmachine', 'entrypoint', 'main'))
    expect(await readFile(join(test.home, '.dearmachine', 'config', 'dearmachine.toml'), 'utf8')).toBe(
      'version = 1\nbackends = ["codex-yolo"]\nresponse_tier = "formatted"\n',
    )
    const journal = await readFile(test.journalPath, 'utf8')
    expect(journal).toContain('"stage": "verified"')
    expect(journal).not.toContain('product-test-secret')
    expect(journal).not.toContain('email-test-secret')
    expect((await stat(test.journalPath)).mode & 0o077).toBe(0)
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
    })
    await installer.install(selection)
    const command = test.runner.requests.find(request => request.label === 'Create Dear Machine pair')?.command
    expect(command).toContain('--inbox')
    expect(command).toContain('inbox-qse-owned')
    expect(command).not.toContain('--new-inbox')
    const journal = await readFile(test.journalPath, 'utf8')
    expect(journal).toContain('"existingInboxIdHash"')
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

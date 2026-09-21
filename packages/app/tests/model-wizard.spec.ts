import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  InstallerAuthInteraction,
  InstallerAuthMethodId,
  InstallerModelSetup,
} from '@dearmachine/machtiani-installer-dsh-adapter'
import { InstallerChoiceBackError, SecretInputCancelledError, type InstallerChoice } from '@dearmachine/machtiani-installer-tui'
import { runInstallerModelWizard } from '../src/model-wizard.ts'
import { ModelHostError } from '@dearmachine/machtiani-model-host'

class ScriptedTui {
  readonly messages: string[] = []
  readonly choices: Array<{ message: string; selected?: string }> = []
  readonly progress: Array<string | undefined> = []
  readonly externalWaits: string[] = []
  secretAttempts = 0
  private cancellation: (() => void) | undefined

  constructor(
    private readonly answers: Array<string | InstallerChoiceBackError>,
    private readonly cancelFirstSecret = false,
  ) {}

  addAssistant(message: string): void { this.messages.push(message) }
  setProgress(message: string | undefined): void { this.progress.push(message) }
  beginCancellationScope(onCancel: () => void): { close(): void } {
    this.cancellation = onCancel
    return { close: () => { if (this.cancellation === onCancel) this.cancellation = undefined } }
  }
  beginExternalWait(message: string): { close(): void } {
    this.externalWaits.push(message)
    return { close: () => {} }
  }
  cancelInteraction(): void { this.cancellation?.() }
  ask(question: { message: string }): Promise<string> {
    this.messages.push(question.message)
    const answer = this.answers.shift() ?? ''
    return answer instanceof InstallerChoiceBackError ? Promise.reject(answer) : Promise.resolve(answer)
  }
  choose(message: string, _choices: readonly InstallerChoice[], selected?: string): Promise<string> {
    this.choices.push({ message, ...(selected === undefined ? {} : { selected }) })
    const answer = this.answers.shift() ?? ''
    return answer instanceof InstallerChoiceBackError ? Promise.reject(answer) : Promise.resolve(answer)
  }
  captureSecret(): Promise<string> {
    this.secretAttempts += 1
    if (this.cancelFirstSecret && this.secretAttempts === 1) return Promise.reject(new SecretInputCancelledError())
    return Promise.resolve('wizard-private-value')
  }
}

function fakeSetup(dshHome: string, authenticated = false): {
  setup: Pick<InstallerModelSetup, 'authenticate' | 'dshHome' | 'isAuthenticated' | 'modelsFor' | 'providers'>
  authentications: InstallerAuthMethodId[]
} {
  let ready = authenticated
  const authentications: InstallerAuthMethodId[] = []
  return {
    authentications,
    setup: {
      dshHome,
      providers: () => [{
        id: 'openrouter',
        name: 'OpenRouter',
        authMethods: [
          { id: 'oauth', label: 'OpenRouter OAuth', subscription: false },
          { id: 'api_key', label: 'OpenRouter API key', subscription: false },
        ],
      }],
      modelsFor: async () => [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', reasoningEfforts: ['low', 'high', 'max'] }],
      isAuthenticated: async () => ready,
      authenticate: async (_provider: string, method: InstallerAuthMethodId, interaction: InstallerAuthInteraction) => {
        authentications.push(method)
        await interaction.prompt({ type: 'secret', message: 'Paste the private key.' })
        ready = true
      },
    },
  }
}

describe('installer model setup wizard', () => {
  it('returns Escape from the provider menu to its parent wizard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-parent-'))
    const { setup } = fakeSetup(root)
    const tui = new ScriptedTui([new InstallerChoiceBackError()])
    await expect(runInstallerModelWizard(tui as never, setup)).rejects.toBeInstanceOf(InstallerChoiceBackError)
    expect(tui.choices).toHaveLength(1)
  })
  it('configures and verifies a remote custom provider without exposing its key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-custom-remote-'))
    const verified: Array<{ selection: unknown; apiKey: string | undefined }> = []
    const setup = {
      dshHome: root,
      providers: () => [{
        id: 'custom-openai-remote', name: 'Custom OpenAI-compatible provider (remote)', authMethods: [], customScope: 'remote' as const,
      }],
      modelsFor: async () => [],
      isAuthenticated: async () => false,
      authenticate: async () => {},
      verifyCustomProvider: async (selection: unknown, apiKey: string | undefined) => { verified.push({ selection, apiKey }) },
    }
    const tui = new ScriptedTui([
      'custom-openai-remote',
      'Acme Models',
      'http://models.example/v1/chat/completions',
      'models.example/v1',
      'acme-reasoner',
      'yes',
      'high',
    ])
    const selection = await runInstallerModelWizard(tui as never, setup)
    expect(selection).toEqual({
      provider: 'custom-openai-remote',
      model: 'acme-reasoner',
      reasoningEffort: 'high',
      customProvider: {
        kind: 'openai-compatible', scope: 'remote', name: 'Acme Models', usesApiKey: true,
        chatCompletionsEndpoint: 'https://models.example/v1/chat/completions',
      },
    })
    expect(verified).toEqual([{ selection, apiKey: 'wizard-private-value' }])
    expect(tui.messages).toContain('Remote custom providers require an HTTPS endpoint.')
    expect(tui.messages).toContain('I’ll use https://models.example/v1/chat/completions.')
    expect(JSON.stringify(tui.messages)).not.toContain('wizard-private-value')
    expect(JSON.parse(await readFile(join(root, 'installer-model.json'), 'utf8'))).toEqual(selection)
  })

  it('supports a keyless loopback provider and retries a failed live test', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-custom-local-'))
    let attempts = 0
    const setup = {
      dshHome: root,
      providers: () => [{
        id: 'custom-openai-local', name: 'Custom OpenAI-compatible provider (local)', authMethods: [], customScope: 'local' as const,
      }],
      modelsFor: async () => [],
      isAuthenticated: async () => false,
      authenticate: async () => {},
      verifyCustomProvider: async (_selection: unknown, apiKey: string | undefined) => {
        expect(apiKey).toBeUndefined()
        attempts += 1
        if (attempts === 1) throw new Error('The endpoint is warming up.')
      },
    }
    const tui = new ScriptedTui([
      'custom-openai-local',
      'Laptop model',
      '192.168.1.5:11434',
      'localhost:11434',
      'local-model',
      'no',
      'default',
      'retry',
    ])
    await expect(runInstallerModelWizard(tui as never, setup)).resolves.toEqual({
      provider: 'custom-openai-local',
      model: 'local-model',
      customProvider: {
        kind: 'openai-compatible', scope: 'local', name: 'Laptop model', usesApiKey: false,
        chatCompletionsEndpoint: 'http://localhost:11434/v1/chat/completions',
      },
    })
    expect(attempts).toBe(2)
    expect(tui.secretAttempts).toBe(0)
    expect(tui.messages).toContain('Local custom providers must use localhost, 127.0.0.1, or [::1].')
    expect(tui.messages).toContain('I’ll use http://localhost:11434/v1/chat/completions.')
    expect(tui.messages).toContain('The endpoint is warming up.')
  })

  it('selects provider, private authentication, model, and reasoning before agent startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-'))
    const { setup, authentications } = fakeSetup(root)
    const tui = new ScriptedTui(['openrouter', 'api_key', 'z-ai/glm-5.3-flash', 'high'])
    const selection = await runInstallerModelWizard(tui as never, setup)
    expect(selection).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', reasoningEffort: 'high' })
    expect(authentications).toEqual(['api_key'])
    expect(tui.secretAttempts).toBe(1)
    expect(JSON.stringify(tui.messages)).not.toContain('wizard-private-value')
    expect(tui.choices.map(choice => choice.message)).toEqual([
      expect.stringContaining('AI service'),
      expect.stringContaining('How would you like to connect'),
      expect.stringContaining('model should conduct'),
      expect.stringContaining('How much reasoning'),
    ])
  })

  it('returns from a child menu to its parent when the human presses Escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-back-'))
    const { setup, authentications } = fakeSetup(root)
    const tui = new ScriptedTui([
      'openrouter',
      new InstallerChoiceBackError(),
      'openrouter',
      'api_key',
      'z-ai/glm-5.3-flash',
      new InstallerChoiceBackError(),
      'z-ai/glm-5.3-flash',
      'high',
    ])
    await expect(runInstallerModelWizard(tui as never, setup)).resolves.toEqual({
      provider: 'openrouter', model: 'z-ai/glm-5.3-flash', reasoningEffort: 'high',
    })
    expect(authentications).toEqual(['api_key'])
    expect(tui.choices.filter(choice => choice.message.includes('AI service'))).toHaveLength(2)
    expect(tui.choices.filter(choice => choice.message.includes('model should conduct'))).toHaveLength(2)
  })

  it('returns from cancelled secure entry to authentication choices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-cancel-'))
    const { setup, authentications } = fakeSetup(root)
    const tui = new ScriptedTui([
      'openrouter',
      'api_key',
      'api_key',
      'z-ai/glm-5.3-flash',
      'high',
    ], true)
    await expect(runInstallerModelWizard(tui as never, setup)).resolves.toMatchObject({ provider: 'openrouter' })
    expect(authentications).toEqual(['api_key', 'api_key'])
    expect(tui.messages).toContain('Key entry was cancelled. You can choose how to connect again, or press Ctrl+C to exit the installer.')
  })

  it('reuses existing authentication without opening a secure field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-existing-'))
    const { setup, authentications } = fakeSetup(root, true)
    const tui = new ScriptedTui(['openrouter', 'z-ai/glm-5.3-flash', 'high'])
    await runInstallerModelWizard(tui as never, setup)
    expect(authentications).toEqual([])
    expect(tui.secretAttempts).toBe(0)
    expect(tui.messages.some(message => message.includes('existing OpenRouter sign-in'))).toBe(true)
  })

  it('recovers from a failed existing-sign-in probe instead of exiting the wizard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-probe-'))
    const { setup, authentications } = fakeSetup(root)
    setup.isAuthenticated = async () => { throw new Error('official runtime could not start') }
    const tui = new ScriptedTui(['openrouter', 'api_key', 'z-ai/glm-5.3-flash', 'high'])
    await expect(runInstallerModelWizard(tui as never, setup)).resolves.toMatchObject({ provider: 'openrouter' })
    expect(authentications).toEqual(['api_key'])
    expect(tui.messages).toContain('I could not check the existing OpenRouter sign-in. official runtime could not start You can try signing in now or press Ctrl+C to exit.')
  })

  it('keeps device-code polling in a cancellable waiting state and returns to sign-in choices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-device-'))
    let attempts = 0
    const setup: Pick<InstallerModelSetup, 'authenticate' | 'dshHome' | 'isAuthenticated' | 'modelsFor' | 'providers'> = {
      dshHome: root,
      providers: () => [{
        id: 'openai-codex',
        name: 'OpenAI Codex',
        authMethods: [
          { id: 'oauth', label: 'Sign in with ChatGPT in your browser', subscription: true },
          { id: 'device_code', label: 'Sign in with a device code', subscription: true },
        ],
      }],
      modelsFor: async () => [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoningEfforts: ['low', 'high'] }],
      isAuthenticated: async () => false,
      authenticate: async (_provider, _method, interaction) => {
        attempts += 1
        if (attempts === 1) {
          interaction.notify({
            type: 'device_code',
            userCode: 'TEST-CODE',
            verificationUri: 'https://example.invalid/device',
          })
          await new Promise<void>((_resolve, reject) => {
            interaction.signal?.addEventListener('abort', () => { reject(new Error('Login cancelled')) }, { once: true })
            queueMicrotask(() => { tui.cancelInteraction() })
          })
        }
      },
    }
    const tui = new ScriptedTui([
      'openai-codex',
      'device_code',
      'device_code',
      'gpt-5.3-codex',
      'high',
    ])
    await expect(runInstallerModelWizard(tui as never, setup)).resolves.toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.3-codex',
      reasoningEffort: 'high',
    })
    expect(attempts).toBe(2)
    expect(tui.externalWaits).toEqual(['Waiting for browser sign-in…'])
    expect(tui.progress).toContain('Waiting for sign-in')
    expect(tui.messages).toContain('Sign-in was cancelled. You can choose how to connect again, or press Ctrl+C to exit the installer.')
  })

  it('keeps ChatGPT browser callback login in a cancellable waiting state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-browser-'))
    const authentications: InstallerAuthMethodId[] = []
    const setup: Pick<InstallerModelSetup, 'authenticate' | 'dshHome' | 'isAuthenticated' | 'modelsFor' | 'providers'> = {
      dshHome: root,
      providers: () => [{
        id: 'openai-codex',
        name: 'OpenAI Codex subscription',
        authMethods: [
          { id: 'oauth', label: 'Sign in with ChatGPT in your browser', description: 'Best for a local desktop install', subscription: true },
          { id: 'device_code', label: 'Sign in with a device code', description: 'Best for SSH, containers, or headless installs', subscription: true },
        ],
      }],
      modelsFor: async () => [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoningEfforts: ['high'] }],
      isAuthenticated: async () => false,
      authenticate: async (_provider, method, interaction) => {
        authentications.push(method)
        interaction.notify({
          type: 'auth_url',
          url: 'https://example.invalid/browser',
          instructions: 'Open this page and sign in with ChatGPT.',
          waitForCompletion: true,
        })
      },
    }
    const tui = new ScriptedTui(['openai-codex', 'oauth', 'gpt-5.3-codex', 'high'])
    await expect(runInstallerModelWizard(tui as never, setup)).resolves.toMatchObject({ provider: 'openai-codex' })
    expect(authentications).toEqual(['oauth'])
    expect(tui.messages).toContain('Open this page and sign in with ChatGPT.\n\nhttps://example.invalid/browser')
    expect(tui.externalWaits).toEqual(['Waiting for browser sign-in…'])
  })

  it('turns a device-code enablement failure into an actionable retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-enable-device-'))
    const { setup } = fakeSetup(root)
    let attempts = 0
    setup.authenticate = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('OpenAI Codex device code login is not enabled for this server.')
    }
    const tui = new ScriptedTui([
      'openrouter',
      'oauth',
      'oauth',
      'z-ai/glm-5.3-flash',
      'high',
    ])
    await runInstallerModelWizard(tui as never, setup)
    expect(attempts).toBe(2)
    expect(tui.messages).toContain('Device-code login is not enabled for this account yet. Enable it on the OpenAI page, then choose the sign-in method again.')
  })

  it('explains an incomplete sign-in runtime before allowing another attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-runtime-'))
    const { setup } = fakeSetup(root)
    let attempts = 0
    const message = 'The installed OpenAI sign-in runtime is incomplete. Repair or reinstall Dear Machine, then try signing in again.'
    setup.authenticate = async () => {
      if (++attempts === 1) throw new ModelHostError('RUNTIME_UNAVAILABLE', message)
    }
    const tui = new ScriptedTui(['openrouter', 'oauth', 'oauth', 'z-ai/glm-5.3-flash', 'high'])
    await runInstallerModelWizard(tui as never, setup)
    expect(attempts).toBe(2)
    expect(tui.messages).toContain(message)
    expect(tui.messages).not.toContain('Sign-in did not complete. Choose a sign-in method to try again, or press Ctrl+C to exit the installer.')
  })

  it('keeps Claude browser login inside the wizard and returns the pasted code only to Claude Code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-claude-'))
    let receivedCode = ''
    const setup: Pick<InstallerModelSetup, 'authenticate' | 'dshHome' | 'isAuthenticated' | 'modelsFor' | 'providers'> = {
      dshHome: root,
      providers: () => [{
        id: 'anthropic-claude',
        name: 'Anthropic Claude Pro/Max subscription',
        authMethods: [{ id: 'oauth', label: 'Sign in with Claude', subscription: true }],
      }],
      isAuthenticated: async () => false,
      modelsFor: async () => [{ id: 'sonnet', name: 'Sonnet', reasoningEfforts: ['low', 'high', 'max'] }],
      authenticate: async (_provider, _method, interaction) => {
        interaction.notify({
          type: 'auth_url',
          url: 'https://claude.example/authorize',
          instructions: 'Open this page and return with the code.',
        })
        receivedCode = await interaction.prompt({ type: 'manual_code', message: 'Paste the Claude authorization code.' })
      },
    }
    const tui = new ScriptedTui(['anthropic-claude', 'oauth', 'sonnet', 'high'])
    tui.captureSecret = async () => {
      tui.secretAttempts += 1
      return 'temporary-code'
    }
    await expect(runInstallerModelWizard(tui as never, setup)).resolves.toEqual({
      provider: 'anthropic-claude', model: 'sonnet', reasoningEffort: 'high',
    })
    expect(receivedCode).toBe('temporary-code')
    expect(tui.messages).toContain('Open this page and return with the code.\n\nhttps://claude.example/authorize')
    expect(tui.messages).toContain('Paste the Claude authorization code.')
    expect(tui.messages).not.toContain('temporary-code')
    expect(tui.secretAttempts).toBe(1)
    expect(tui.externalWaits).toEqual([])
  })

  it('returns a cancelled Claude code field to the sign-in choice instead of exiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-model-wizard-claude-cancel-'))
    let attempts = 0
    const setup: Pick<InstallerModelSetup, 'authenticate' | 'dshHome' | 'isAuthenticated' | 'modelsFor' | 'providers'> = {
      dshHome: root,
      providers: () => [{
        id: 'anthropic-claude', name: 'Anthropic Claude Pro/Max subscription',
        authMethods: [{ id: 'oauth', label: 'Sign in with Claude', subscription: true }],
      }],
      isAuthenticated: async () => false,
      modelsFor: async () => [{ id: 'sonnet', name: 'Sonnet', reasoningEfforts: ['high'] }],
      authenticate: async (_provider, _method, interaction) => {
        attempts += 1
        await interaction.prompt({ type: 'manual_code', message: 'Paste the Claude authorization code.' })
      },
    }
    const tui = new ScriptedTui(['anthropic-claude', 'oauth', 'oauth', 'sonnet', 'high'], true)
    await expect(runInstallerModelWizard(tui as never, setup)).resolves.toMatchObject({ provider: 'anthropic-claude' })
    expect(attempts).toBe(2)
    expect(tui.messages).toContain('Sign-in was cancelled. You can choose how to connect again, or press Ctrl+C to exit the installer.')
  })
})

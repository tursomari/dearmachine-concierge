import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  InstallerAuthInteraction,
  InstallerAuthMethodId,
  InstallerModelSetup,
} from '@dearmachine/machtiani-installer-dsh-adapter'
import { SecretInputCancelledError, type InstallerChoice } from '@dearmachine/machtiani-installer-tui'
import { runInstallerModelWizard } from '../src/model-wizard.ts'

class ScriptedTui {
  readonly messages: string[] = []
  readonly choices: Array<{ message: string; selected?: string }> = []
  readonly progress: Array<string | undefined> = []
  secretAttempts = 0

  constructor(
    private readonly answers: string[],
    private readonly cancelFirstSecret = false,
  ) {}

  addAssistant(message: string): void { this.messages.push(message) }
  setProgress(message: string | undefined): void { this.progress.push(message) }
  ask(question: { message: string }): Promise<string> { this.messages.push(question.message); return Promise.resolve(this.answers.shift() ?? '') }
  choose(message: string, _choices: readonly InstallerChoice[], selected?: string): Promise<string> {
    this.choices.push({ message, ...(selected === undefined ? {} : { selected }) })
    return Promise.resolve(this.answers.shift() ?? '')
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
      modelsFor: () => [{ id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', reasoningEfforts: ['low', 'high', 'max'] }],
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
})

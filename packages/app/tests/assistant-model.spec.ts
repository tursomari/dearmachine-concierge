import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstallerModelSetup } from '@dearmachine/machtiani-installer-dsh-adapter'
import { loadModelHostProfile, readApiKeyCredential, saveModelHostProfile, writeApiKeyCredential } from '@dearmachine/machtiani-model-host'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { assistantModelPath, changeAssistantModel, ensureAssistantModel, loadAssistantModel, sharedModelPath } from '../src/assistant-model.ts'
import type { WizardTui } from '../src/model-wizard.ts'

const homes: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'assistant-model-')); homes.push(home)
  const credentials = join(home, '.config', 'dearmachine', 'backends.env')
  await writeApiKeyCredential(credentials, 'openrouter', 'fixture-private-key')
  await saveModelHostProfile(sharedModelPath(home), {
    version: 1, driver: 'pi-ai', provider: 'openrouter', authMethod: 'api_key', model: 'first-model', reasoningEffort: 'high',
    credential: { kind: 'environment-file', path: credentials, variable: 'OPENROUTER_API_KEY' },
  })
  vi.spyOn(InstallerModelSetup.prototype, 'modelsFor').mockResolvedValue([
    { id: 'first-model', name: 'First Model', reasoningEfforts: ['low', 'high'] },
    { id: 'second-model', name: 'Second Model', reasoningEfforts: ['low', 'high'] },
  ])
  const signal = new AbortController().signal
  return { home, credentials, signal, pause: vi.fn(async () => {}), environment: {} }
}

function interaction(answers: Array<string | Error>, beforeAnswer?: () => void): WizardTui & { messages: string[] } {
  const messages: string[] = []
  const choose = vi.fn(async () => {
    beforeAnswer?.()
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    if (answer === undefined) throw new Error('No fixture answer')
    return answer
  })
  return {
    messages, addAssistant: text => { messages.push(text) }, setProgress: () => {}, choose,
    ask: choose, captureSecret: async () => 'fixture-replacement-key',
    beginCancellationScope: () => ({ close() {} }), beginExternalWait: () => ({ close() {} }),
  }
}

it('inherits old installations, then changes only the assistant profile and persists across reopening', async () => {
  const options = await fixture()
  const old = await readFile(sharedModelPath(options.home), 'utf8')
  const credentialBytes = await readFile(options.credentials, 'utf8')
  const harness = join(options.home, 'harness-config.toml')
  await writeFile(harness, 'default_model="planner"\nshell_agent_model="shell"\n')
  const initial = await ensureAssistantModel(options.home)
  expect(initial.model).toBe('first-model')
  const tui = interaction(['openrouter', 'second-model', 'low'])
  await changeAssistantModel(tui, options)
  const changed = await loadAssistantModel(options.home)
  expect(changed).toMatchObject({ provider: 'openrouter', model: 'second-model', reasoningEffort: 'low' })
  expect(await ensureAssistantModel(options.home)).toEqual(changed)
  expect(await readFile(sharedModelPath(options.home), 'utf8')).toBe(old)
  expect(await readFile(options.credentials, 'utf8')).toBe(credentialBytes)
  expect(await readFile(harness, 'utf8')).toBe('default_model="planner"\nshell_agent_model="shell"\n')
  expect((await stat(assistantModelPath(options.home))).mode & 0o777).toBe(0o600)
  expect(changed?.credential?.path).not.toBe(options.credentials)
  expect(await readApiKeyCredential(changed!.credential!.path, 'openrouter')).toBe('fixture-private-key')
  expect(tui.messages.join('\n')).not.toContain('fixture-private-key')
  expect(tui.messages.join('\n')).not.toContain('Machtiani will use')
  expect(options.pause).toHaveBeenCalledOnce()
})

it.each(['cancel', 'catalogue failure', 'exit'])('keeps the selection and credentials on %s and removes its staging directory', async scenario => {
  const options = await fixture()
  await ensureAssistantModel(options.home)
  const old = await readFile(assistantModelPath(options.home), 'utf8')
  const controller = new AbortController()
  if (scenario === 'catalogue failure') vi.spyOn(InstallerModelSetup.prototype, 'modelsFor').mockRejectedValue(new Error('offline'))
  const tui = interaction(scenario === 'cancel' ? [new InstallerChoiceBackError()] : ['openrouter', 'second-model', 'low'],
    scenario === 'exit' ? () => controller.abort() : undefined)
  await changeAssistantModel(tui, { ...options, signal: controller.signal })
  expect(await readFile(assistantModelPath(options.home), 'utf8')).toBe(old)
  expect(await readApiKeyCredential(options.credentials, 'openrouter')).toBe('fixture-private-key')
  expect(await readdir(join(options.home, '.config', 'dearmachine', 'assistant-models'))).toEqual([])
})

it('can replace a corrupt assistant profile without opening the failed provider', async () => {
  const options = await fixture()
  await writeFile(assistantModelPath(options.home), 'invalid', { mode: 0o600 })
  const tui = interaction(['openrouter', 'second-model', 'high'])
  await changeAssistantModel(tui, options)
  expect((await loadModelHostProfile(assistantModelPath(options.home))).model).toBe('second-model')
  expect(tui.messages.join('\n')).toContain('Choose a replacement')
})

it('discards a newly entered API key when the user backs out after authentication', async () => {
  const options = await fixture()
  await ensureAssistantModel(options.home)
  const old = await readFile(assistantModelPath(options.home), 'utf8')
  await changeAssistantModel(interaction(['openai', 'api_key', new InstallerChoiceBackError(), new InstallerChoiceBackError()]), options)
  expect(await readFile(assistantModelPath(options.home), 'utf8')).toBe(old)
  expect(await readApiKeyCredential(options.credentials, 'openai')).toBeUndefined()
  expect(await readdir(join(options.home, '.config', 'dearmachine', 'assistant-models'))).toEqual([])
})

it('browses subscription models using the existing account runtime and saves another model', async () => {
  const options = await fixture()
  const runtimeProfile = join(options.home, 'existing-account')
  await saveModelHostProfile(assistantModelPath(options.home), {
    version: 1, driver: 'openai-codex-app-server', provider: 'openai-codex', authMethod: 'subscription',
    model: 'first-model', runtimeProfile,
  })
  vi.spyOn(InstallerModelSetup.prototype, 'isAuthenticated').mockResolvedValue(true)
  const models = vi.spyOn(InstallerModelSetup.prototype, 'modelsFor')
  await changeAssistantModel(interaction(['openai-codex', 'second-model', 'high']), options)
  expect(models).toHaveBeenCalledWith('openai-codex')
  expect(await loadAssistantModel(options.home)).toMatchObject({ provider: 'openai-codex', model: 'second-model', runtimeProfile })
})

import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { InstallerModelSetup, saveInstallerModelSelection } from '@dearmachine/machtiani-installer-dsh-adapter'
import { apiKeyProviders, loadModelHostProfile, readApiKeyCredential, saveModelHostProfile, writeApiKeyCredential, type ModelHostProfile } from '@dearmachine/machtiani-model-host'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { runInstallerModelWizard, type WizardTui } from './model-wizard.ts'

export const assistantModelPath = (home: string): string => join(home, '.config', 'dearmachine', 'assistant-model.json')
export const sharedModelPath = (home: string): string => join(home, '.config', 'machtiani', 'model-profile.json')

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Old installations inherit their shared profile until an assistant choice is saved. */
export async function loadAssistantModel(home: string): Promise<ModelHostProfile | undefined> {
  const path = await exists(assistantModelPath(home)) ? assistantModelPath(home) : sharedModelPath(home)
  return await exists(path) ? await loadModelHostProfile(path) : undefined
}

export async function ensureAssistantModel(home: string): Promise<ModelHostProfile> {
  const profile = await loadAssistantModel(home)
  if (profile === undefined) throw new Error('Use /model to choose an assistant model.')
  if (!await exists(assistantModelPath(home))) await saveModelHostProfile(assistantModelPath(home), profile)
  return profile
}

function describe(profile: ModelHostProfile): string {
  return `${profile.provider} — ${profile.model} — ${profile.reasoningEffort === undefined ? 'provider-default reasoning' : `${profile.reasoningEffort} reasoning`}`
}

/** Stage credentials and selection privately; the one atomic profile write commits. */
export async function changeAssistantModel(tui: WizardTui, options: {
  home: string
  signal: AbortSignal
  pause(): Promise<void>
  environment?: NodeJS.ProcessEnv
}): Promise<void> {
  const { home, signal } = options
  let current: ModelHostProfile | undefined
  try { current = await loadAssistantModel(home) } catch {
    tui.addAssistant('The saved assistant model could not be read. Choose a replacement to recover.')
  }
  tui.addAssistant(current === undefined ? 'No assistant model is configured.' : `Current assistant: ${describe(current)}.`)
  await options.pause()
  signal.throwIfAborted()
  const directory = join(home, '.config', 'dearmachine', 'assistant-models')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stage = await mkdtemp(join(directory, 'selection-'))
  let committed = false
  let setup: InstallerModelSetup | undefined
  const merge = (other?: AbortSignal) => other === undefined ? signal : AbortSignal.any([signal, other])
  const interaction: WizardTui = {
    addAssistant: text => tui.addAssistant(text), setProgress: text => tui.setProgress(text),
    ask: question => tui.ask({ ...question, signal: merge(question.signal) }),
    choose: (message, choices, selected, other) => tui.choose(message, choices, selected, merge(other)),
    captureSecret: (other, label, hint) => tui.captureSecret(merge(other), label, hint),
    beginExternalWait: label => tui.beginExternalWait(label),
    beginCancellationScope: cancel => {
      signal.addEventListener('abort', cancel, { once: true })
      const scope = tui.beginCancellationScope(cancel)
      return { close: () => { signal.removeEventListener('abort', cancel); scope.close() } }
    },
  }
  try {
    const credentialPath = join(stage, 'backends.env')
    // Copy only validated provider keys, never replace the current credential file.
    const sources = [join(home, '.config', 'dearmachine', 'backends.env')]
    if (current?.credential?.kind === 'environment-file') sources.push(current.credential.path)
    for (const source of sources) for (const provider of apiKeyProviders()) {
      const key = await readApiKeyCredential(source, provider.id).catch(() => undefined)
      if (key !== undefined) await writeApiKeyCredential(credentialPath, provider.id, key)
    }
    const environment = { ...(options.environment ?? process.env) }
    if (current?.runtimeProfile !== undefined) {
      const variable = { 'openai-codex': 'CODEX_HOME', 'anthropic-claude': 'CLAUDE_CONFIG_DIR', 'github-copilot': 'COPILOT_HOME' }[current.provider]
      if (variable !== undefined) environment[variable] = current.runtimeProfile
    }
    setup = await InstallerModelSetup.open(stage, environment, { credentialPath, home })
    if (current !== undefined) await saveInstallerModelSelection(stage, current)
    const selection = await runInstallerModelWizard(interaction, setup, true)
    signal.throwIfAborted()
    const profile = setup.profileFor(selection)
    await saveModelHostProfile(assistantModelPath(home), profile)
    committed = true
    tui.addAssistant(`Assistant model saved: ${describe(profile)}. Your next message will use it, with this conversation preserved.`)
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof InstallerChoiceBackError) tui.addAssistant('Model change cancelled. Your previous selection is unchanged.')
    else tui.addAssistant('The model change could not be saved. Your previous selection is unchanged. Use /model to try another provider or sign in again.')
  } finally {
    await setup?.close()
    if (!committed) await rm(stage, { recursive: true, force: true })
    tui.setProgress(undefined)
  }
}

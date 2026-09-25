import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { InstallerModelSetup, saveInstallerModelSelection } from '@dearmachine/machtiani-installer-dsh-adapter'
import { apiKeyProviders, effectiveModelProfile, modelComponents, readApiKeyCredential, saveModelHostProfile, writeApiKeyCredential, type ModelHostProfile } from '@dearmachine/machtiani-model-host'
import { configuredBackendModels } from './backend-models.ts'
import { ModelRoutingError } from './model-routing.ts'
import { ModelSaveRecoveryError, assistantModelPath, loadModelSettings, migrateModelSettings, saveModelSettings, type ModelTarget } from './model-settings.ts'
export { assistantModelPath, sharedModelPath } from './model-settings.ts'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { runInstallerModelWizard, type WizardTui } from './model-wizard.ts'

export async function loadAssistantModel(home: string): Promise<ModelHostProfile | undefined> {
  const settings = await loadModelSettings(home)
  return settings === undefined ? undefined : effectiveModelProfile(settings, 'concierge')
}

export async function ensureAssistantModel(home: string): Promise<ModelHostProfile> {
  await migrateModelSettings(home)
  const profile = await loadAssistantModel(home)
  if (profile === undefined) throw new Error('Use /model to choose a model.')
  // Compatibility snapshot for DSH. Shared settings remain authoritative.
  await saveModelHostProfile(assistantModelPath(home), profile)
  return profile
}

const labels = { concierge: 'Concierge — the thing you are looking at right now', planner: 'Machtiani planner', 'shell-agent': 'Machtiani shell-agent', sync: 'Machtiani sync' } as const

function authenticationUsage(target: ModelTarget): string {
  if (target === 'default') return 'It will be used for requests that inherit Default; existing component overrides will be kept.'
  if (target === 'all') return 'It will be used for Concierge, Machtiani planner, Machtiani shell-agent, and Machtiani sync requests.'
  return 'It will be used for ' + (target === 'concierge' ? 'Concierge' : labels[target]) + ' requests.'
}

function describe(profile: ModelHostProfile): string {
  return `${profile.provider} — ${profile.model} — ${profile.reasoningEffort === undefined ? 'provider-default reasoning' : `${profile.reasoningEffort} reasoning`}`
}

/** Stage credentials privately; restore the selection if harness routing cannot commit. */
export async function changeAssistantModel(tui: WizardTui, options: {
  home: string
  signal: AbortSignal
  pause(): Promise<void>
  environment?: NodeJS.ProcessEnv
}): Promise<void> {
  const { home, signal } = options
  let current: ModelHostProfile | undefined
  let target: ModelTarget
  let repairLegacyAssistant = false
  try {
    let settings: ModelHostProfile | undefined
    try { settings = await loadModelSettings(home) }
    catch {
      settings = await loadModelSettings(home, true)
      repairLegacyAssistant = true
      tui.addAssistant('The saved Concierge model could not be read. Choose a replacement to recover; Default and the other components will be preserved.')
    }
    tui.addAssistant(settings === undefined ? 'Default: not configured.' : `Default: ${describe(effectiveModelProfile(settings, 'planner', settings))}.`)
    for (const component of modelComponents) {
      tui.addAssistant(`${labels[component]}: ${repairLegacyAssistant && component === 'concierge' ? 'unreadable' : settings === undefined ? 'not configured' : `${settings.overrides?.[component] === undefined ? 'inherits Default' : 'override'} — ${describe(effectiveModelProfile(settings, component))}`}.`)
    }
    const backends = await configuredBackendModels(home, options.environment ?? process.env).catch(() => ['The configured backend list could not be read. Inspect dearmachine.toml.'])
    tui.addAssistant(`Configured backends (read-only)\n${backends.length === 0 ? 'None configured.' : backends.join('\n')}`)
    await options.pause()
    target = repairLegacyAssistant ? 'concierge' : await tui.choose('Models', [
      { value: 'default', label: 'Change Default', description: 'Keep component overrides.' },
      { value: 'all', label: 'Set all', description: 'Change Default and clear every override.' },
      ...modelComponents.map(component => ({ value: component, label: labels[component], description: 'Override or inherit Default.' })),
      { value: 'done', label: 'Done' },
    ], 'default', signal) as ModelTarget
    if (String(target) === 'done') return
    if (!['default', 'all', ...modelComponents].includes(target)) throw new Error('Invalid model target.')
    current = settings === undefined ? undefined : effectiveModelProfile(settings, target === 'default' || target === 'all' ? 'planner' : target,
      target === 'default' || target === 'all' ? settings : undefined)
    if (!repairLegacyAssistant && target !== 'default' && target !== 'all' && settings !== undefined) {
      const action = await tui.choose(labels[target], [
        { value: 'override', label: 'Choose override' },
        { value: 'inherit', label: 'Use Default' },
      ], settings.overrides?.[target] === undefined ? 'inherit' : 'override', signal)
      if (action === 'inherit') {
        signal.throwIfAborted()
        await saveModelSettings(home, target)
        tui.addAssistant(`${labels[target]} now inherits Default.`)
        return
      }
    }
    signal.throwIfAborted()
  } catch (error) {
    if (signal.aborted || error instanceof InstallerChoiceBackError) return
    tui.addAssistant(error instanceof ModelRoutingError || error instanceof ModelSaveRecoveryError ? error.message : 'Model settings could not be read or saved. Existing settings were kept. Check the saved configuration and its file permissions, then retry /model.')
    return
  }
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
      const variable = { 'openai-codex': 'MACHTIANI_CODEX_HOME', 'anthropic-claude': 'CLAUDE_CONFIG_DIR', 'github-copilot': 'COPILOT_HOME' }[current.provider]
      // Older profiles shared the standalone CLI's database. Reconfiguration
      // moves those profiles to Machtiani's private runtime without touching it.
      if (variable !== undefined && !(current.provider === 'openai-codex' &&
          (current.runtimeProfile === join(home, '.codex') || current.runtimeProfile === environment.CODEX_HOME))) {
        environment[variable] = current.runtimeProfile
      }
    }
    setup = await InstallerModelSetup.open(stage, environment, { credentialPath, home })
    if (current !== undefined) await saveInstallerModelSelection(stage, current)
    const selection = await runInstallerModelWizard(interaction, setup, { authenticationUsage: authenticationUsage(target) })
    signal.throwIfAborted()
    const profile = setup.profileFor(selection)
    await saveModelSettings(home, target, profile, repairLegacyAssistant)
    committed = true
    tui.addAssistant(`${target === 'default' ? 'Default' : target === 'all' ? 'Set all' : labels[target]} saved: ${describe(profile)}. New requests will use the saved selections.`)
  } catch (error) {
    if (signal.aborted) return
    if (error instanceof InstallerChoiceBackError) tui.addAssistant('Model change cancelled. Your previous selection is unchanged.')
    else if (error instanceof ModelSaveRecoveryError) {
      committed = true
      tui.addAssistant(error.message)
    } else if (error instanceof ModelRoutingError) tui.addAssistant('The model change could not be saved. Your previous selection is unchanged. ' + error.message)
    else tui.addAssistant('The model change could not be saved. Your previous selection is unchanged. Check file permissions and free disk space under ~/.config, then retry /model. If authentication failed, use the provider sign-in or API-key options.')
  } finally {
    await setup?.close()
    if (!committed) await rm(stage, { recursive: true, force: true })
    tui.setProgress(undefined)
  }
}

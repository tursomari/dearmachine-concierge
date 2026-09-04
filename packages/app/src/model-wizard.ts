import {
  isKnownInstallerModelSelection,
  loadInstallerModelSelection,
  saveInstallerModelSelection,
  type InstallerAuthEvent,
  type InstallerAuthMethodId,
  type InstallerAuthPrompt,
  type InstallerModelSelection,
  type InstallerModelSetup,
} from '@dearmachine/machtiani-installer-dsh-adapter'
import { SecretInputCancelledError, type InstallerChoice, type InstallerTui } from '@dearmachine/machtiani-installer-tui'

type WizardTui = Pick<InstallerTui, 'addAssistant' | 'ask' | 'captureSecret' | 'choose' | 'setProgress'>
type WizardSetup = Pick<InstallerModelSetup, 'authenticate' | 'dshHome' | 'isAuthenticated' | 'modelsFor' | 'providers'>

function authEvent(tui: WizardTui, event: InstallerAuthEvent): void {
  switch (event.type) {
    case 'progress':
      tui.setProgress(event.message)
      break
    case 'auth_url':
      tui.addAssistant(`${event.instructions ?? 'Open this address to continue signing in:'}\n\n${event.url}`)
      break
    case 'device_code':
      tui.addAssistant(`Open ${event.verificationUri} and enter this code: **${event.userCode}**`)
      break
    case 'info':
      tui.addAssistant([
        event.message,
        ...(event.links ?? []).map(link => `${link.label ?? 'Open'}: ${link.url}`),
      ].join('\n\n'))
      break
  }
}

async function authPrompt(tui: WizardTui, prompt: InstallerAuthPrompt): Promise<string> {
  if (prompt.type === 'secret') {
    tui.addAssistant(prompt.message)
    return await tui.captureSecret(prompt.signal)
  }
  if (prompt.type === 'select') {
    return await tui.choose(
      prompt.message,
      prompt.options.map(option => ({
        value: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
      undefined,
      prompt.signal,
    )
  }
  return await tui.ask({
    message: prompt.message,
    ...(prompt.signal === undefined ? {} : { signal: prompt.signal }),
  })
}

function providerChoices(setup: WizardSetup): InstallerChoice[] {
  return setup.providers().map(provider => {
    const subscription = provider.authMethods.some(method => method.subscription)
    const browserSignIn = provider.authMethods.some(method => method.id === 'oauth')
    const apiKey = provider.authMethods.some(method => method.id === 'api_key')
    const authentication = subscription && apiKey
      ? 'subscription sign-in or API credentials'
      : subscription
        ? 'subscription sign-in'
        : browserSignIn && apiKey
          ? 'browser sign-in or API credentials'
          : browserSignIn ? 'browser sign-in' : 'API credentials'
    return { value: provider.id, label: provider.name, description: `${provider.id} — ${authentication}` }
  })
}

function preferredEffort(efforts: readonly string[], current: string | undefined): string | undefined {
  if (current !== undefined && efforts.includes(current)) return current
  if (efforts.includes('high')) return 'high'
  return efforts[0]
}

async function ensureAuthentication(tui: WizardTui, setup: WizardSetup, providerId: string): Promise<void> {
  if (await setup.isAuthenticated(providerId)) {
    const provider = setup.providers().find(candidate => candidate.id === providerId)
    tui.addAssistant(`Your existing ${provider?.name ?? providerId} sign-in is available. It will be used only by this installer.`)
    return
  }

  const provider = setup.providers().find(candidate => candidate.id === providerId)
  if (provider === undefined) throw new Error(`unknown installer model provider: ${providerId}`)
  while (true) {
    const method = await tui.choose(
      `How would you like to connect ${provider.name}?`,
      provider.authMethods.map(candidate => ({
        value: candidate.id,
        label: candidate.label,
        description: candidate.subscription ? 'Uses your existing subscription' : 'Saved privately for this installer',
      })),
      provider.authMethods[0]?.id,
    ) as InstallerAuthMethodId
    try {
      await setup.authenticate(providerId, method, {
        prompt: prompt => authPrompt(tui, prompt),
        notify: event => { authEvent(tui, event) },
      })
      tui.setProgress(undefined)
      return
    } catch (error) {
      tui.setProgress(undefined)
      if (!(error instanceof SecretInputCancelledError)) throw error
      tui.addAssistant('Key entry was cancelled. You can choose how to connect again, or press Ctrl+C to exit the installer.')
    }
  }
}

/** Configure the model that conducts installation before that model is started. */
export async function runInstallerModelWizard(tui: WizardTui, setup: WizardSetup): Promise<InstallerModelSelection> {
  const stored = await loadInstallerModelSelection(setup.dshHome)
  const current = isKnownInstallerModelSelection(setup, stored) ? stored : undefined
  const providers = providerChoices(setup)
  const providerId = await tui.choose(
    'First, choose the AI service for this installation assistant. This choice is only for the installer; Dear Machine’s provider and backend are selected later.',
    providers,
    current?.provider,
  )
  await ensureAuthentication(tui, setup, providerId)

  const provider = setup.providers().find(candidate => candidate.id === providerId)
  const models = setup.modelsFor(providerId)
  const modelId = await tui.choose(
    `Which ${provider?.name ?? providerId} model should conduct the installation? Type to filter the model list.`,
    models.map(model => ({
      value: model.id,
      label: model.name,
      ...(model.name === model.id ? {} : { description: model.id }),
    })),
    current?.provider === providerId ? current.model : undefined,
  )
  const model = models.find(candidate => candidate.id === modelId)
  if (model === undefined) throw new Error(`unknown installer model: ${providerId}/${modelId}`)

  let reasoningEffort: string | undefined
  if (model.reasoningEfforts.length > 0) {
    reasoningEffort = await tui.choose(
      'How much reasoning should the installation assistant use?',
      model.reasoningEfforts.map(effort => ({
        value: effort,
        label: effort === 'off' ? 'Off' : `${effort[0]?.toLocaleUpperCase()}${effort.slice(1)}`,
        ...(effort === 'high' ? { description: 'Recommended for installation' } : {}),
      })),
      preferredEffort(model.reasoningEfforts, current?.provider === providerId && current.model === modelId
        ? current.reasoningEffort
        : undefined),
    )
  } else {
    tui.addAssistant('This model does not offer a separate reasoning setting, so there is nothing else to configure.')
  }

  const selection: InstallerModelSelection = {
    provider: providerId,
    model: modelId,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
  await saveInstallerModelSelection(setup.dshHome, selection)
  tui.addAssistant(`Ready. This installation will use ${provider?.name ?? providerId} — ${model.name}${reasoningEffort === undefined ? '' : ` — ${reasoningEffort} reasoning`}.`)
  return selection
}

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
import { ModelHostError, validateCustomOpenAIEndpoint, type CustomOpenAIProviderScope } from '@dearmachine/machtiani-model-host'
import { InstallerChoiceBackError, SecretInputCancelledError, type InstallerChoice, type InstallerTui } from '@dearmachine/machtiani-installer-tui'

export type WizardTui = Pick<InstallerTui,
  | 'addAssistant'
  | 'ask'
  | 'beginCancellationScope'
  | 'beginExternalWait'
  | 'captureSecret'
  | 'choose'
  | 'setProgress'
>
type WizardSetup = Pick<InstallerModelSetup, 'authenticate' | 'dshHome' | 'isAuthenticated' | 'modelsFor' | 'providers'> &
  Partial<Pick<InstallerModelSetup, 'verifyCustomProvider'>>

class SignInCodeCancelledError extends Error {
  constructor() {
    super('secure sign-in code entry was cancelled')
    this.name = 'SignInCodeCancelledError'
  }
}

export function authEvent(tui: WizardTui, event: InstallerAuthEvent): void {
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

function mergedSignal(prompt: InstallerAuthPrompt, authentication: AbortSignal): AbortSignal {
  return prompt.signal === undefined ? authentication : AbortSignal.any([prompt.signal, authentication])
}

export async function authPrompt(tui: WizardTui, prompt: InstallerAuthPrompt, authentication: AbortSignal): Promise<string> {
  const signal = mergedSignal(prompt, authentication)
  if (prompt.type === 'secret') {
    tui.addAssistant(prompt.message)
    return await tui.captureSecret(signal)
  }
  if (prompt.type === 'manual_code') {
    tui.addAssistant(prompt.message)
    try {
      return await tui.captureSecret(signal, 'Secure sign-in code — input hidden', 'Ctrl+C to cancel sign-in')
    } catch (error) {
      if (error instanceof SecretInputCancelledError) throw new SignInCodeCancelledError()
      throw error
    }
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
      signal,
    )
  }
  return await tui.ask({
    message: prompt.message,
    signal,
  })
}

function providerChoices(setup: WizardSetup): InstallerChoice[] {
  return setup.providers().map(provider => {
    if (provider.customScope === 'remote') return {
      value: provider.id,
      label: provider.name,
      description: 'Your HTTPS Chat Completions endpoint',
    }
    if (provider.customScope === 'local') return {
      value: provider.id,
      label: provider.name,
      description: 'A model server on this machine',
    }
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

const CUSTOM_REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function plainValue(value: string, label: string): string {
  const result = value.trim()
  if (result === '' || result.length > 256 || /[\r\n\0]/u.test(result)) throw new Error(`${label} must be one nonempty line of at most 256 characters.`)
  return result
}

async function customValue(tui: WizardTui, message: string, label: string): Promise<string> {
  while (true) {
    const value = await tui.ask({ message })
    try { return plainValue(value, label) }
    catch (error) { tui.addAssistant(error instanceof Error ? error.message : `Enter a valid ${label}.`) }
  }
}

function completedChatCompletionsEndpoint(value: string, scope: CustomOpenAIProviderScope): string {
  const input = value.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(input)
    ? input
    : `${scope === 'local' ? 'http' : 'https'}://${input}`
  let endpoint: URL
  try { endpoint = new URL(withScheme) } catch {
    throw new Error(scope === 'local'
      ? 'Enter a local model-server URL, such as http://localhost:11434.'
      : 'Enter the provider URL, such as https://api.provider.example/v1.')
  }
  const path = endpoint.pathname.replace(/\/+$/u, '')
  if (!path.endsWith('/chat/completions')) {
    endpoint.pathname = path === '' ? '/v1/chat/completions' : `${path}/chat/completions`
  }
  return validateCustomOpenAIEndpoint(endpoint.toString(), scope)
}

async function customEndpoint(tui: WizardTui, scope: CustomOpenAIProviderScope): Promise<string> {
  while (true) {
    const value = await tui.ask({
      message: scope === 'remote'
        ? 'What URL does this provider use? For example: https://api.provider.example/v1'
        : 'What local URL is your model server using? For example: http://localhost:11434',
    })
    try {
      const endpoint = completedChatCompletionsEndpoint(value, scope)
      if (endpoint !== value.trim()) tui.addAssistant(`I’ll use ${endpoint}.`)
      return endpoint
    }
    catch (error) { tui.addAssistant(error instanceof Error ? error.message : 'Enter a valid model-server URL.') }
  }
}

async function runCustomProviderWizard(
  tui: WizardTui,
  setup: WizardSetup,
  providerId: string,
  scope: CustomOpenAIProviderScope,
  stored: InstallerModelSelection | undefined,
  assistantOnly: boolean,
): Promise<InstallerModelSelection> {
  let previous = stored?.provider === providerId ? stored : undefined
  while (true) {
    const name = await customValue(tui, `What should I call this ${scope} provider?`, 'Provider name')
    const chatCompletionsEndpoint = await customEndpoint(tui, scope)
    const model = await customValue(tui, 'What exact model name should the endpoint receive?', 'Model name')
    const usesApiKey = await tui.choose(
      'Does this endpoint require an API key?',
      [
        { value: 'yes', label: 'Yes', description: 'Enter it in the secure field' },
        { value: 'no', label: 'No', description: scope === 'local' ? 'Common for a private local model server' : 'Only choose this if the remote endpoint is intentionally keyless' },
      ],
      previous?.customProvider?.usesApiKey === false ? 'no' : 'yes',
    ) === 'yes'
    let apiKey: string | undefined
    if (usesApiKey) {
      tui.addAssistant('Paste the API key into the secure field and press Enter. It is saved privately and never enters the conversation.')
      try { apiKey = await tui.captureSecret() }
      catch (error) {
        if (error instanceof SecretInputCancelledError) {
          tui.addAssistant('Key entry was cancelled. You can enter the custom provider details again, or press Ctrl+C to exit the installer.')
          previous = undefined
          continue
        }
        throw error
      }
    }
    const reasoning = await tui.choose(
      'Should the assistant send a reasoning level to this model?',
      [
        { value: 'default', label: 'No — provider default', description: 'Send no reasoning parameter' },
        ...CUSTOM_REASONING_LEVELS.map(level => ({
          value: level,
          label: `${level[0]!.toLocaleUpperCase()}${level.slice(1)}`,
          ...(level === 'high' ? { description: 'Recommended when the model supports it' } : {}),
        })),
      ],
      previous?.reasoningEffort ?? 'default',
    )
    const selection: InstallerModelSelection = {
      provider: providerId,
      model,
      ...(reasoning === 'default' ? {} : { reasoningEffort: reasoning }),
      customProvider: {
        kind: 'openai-compatible',
        scope,
        name,
        chatCompletionsEndpoint,
        usesApiKey,
      },
    }
    tui.addAssistant('I’ll send a tiny live request now to verify streaming, tool calling, and continuation after a tool result. This confirms the configuration works now; it cannot guarantee the provider will never change.')
    while (true) {
      const controller = new AbortController()
      const cancellation = tui.beginCancellationScope(() => { controller.abort() })
      try {
        tui.setProgress('Testing the custom provider')
        if (setup.verifyCustomProvider === undefined) throw new Error('Custom provider verification is unavailable.')
        await setup.verifyCustomProvider(selection, apiKey, controller.signal)
        tui.setProgress(undefined)
        await saveInstallerModelSelection(setup.dshHome, selection)
        if (!assistantOnly) tui.addAssistant(`Ready. The installation assistant and Machtiani will use ${name} — ${model}${reasoning === 'default' ? '' : ` — ${reasoning} reasoning`}.`)
        return selection
      } catch (error) {
        tui.setProgress(undefined)
        if (controller.signal.aborted) tui.addAssistant('The compatibility test was cancelled.')
        else tui.addAssistant(error instanceof Error ? error.message : 'The compatibility test failed.')
      } finally { cancellation.close() }
      const next = await tui.choose(
        'What would you like to do?',
        [
          { value: 'retry', label: 'Try the test again', description: 'Use the same settings' },
          { value: 'edit', label: 'Edit provider settings', description: 'Enter the endpoint, model, or key again' },
        ],
        'retry',
      )
      if (next === 'edit') { previous = selection; break }
    }
  }
}

function preferredEffort(efforts: readonly string[], current: string | undefined): string | undefined {
  if (current !== undefined && efforts.includes(current)) return current
  if (efforts.includes('high')) return 'high'
  return efforts[0]
}

async function ensureAuthentication(tui: WizardTui, setup: WizardSetup, providerId: string, assistantOnly: boolean): Promise<void> {
  const provider = setup.providers().find(candidate => candidate.id === providerId)
  try {
    if (await setup.isAuthenticated(providerId)) {
      tui.addAssistant(`Your existing ${provider?.name ?? providerId} sign-in is available. ${assistantOnly ? 'It will be used by this assistant.' : 'It will be used by this installer and by Machtiani for Dear Machine.'}`)
      return
    }
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : ''
    tui.addAssistant(`I could not check the existing ${provider?.name ?? providerId} sign-in.${detail} You can try signing in now or press Ctrl+C to exit.`)
  }

  if (provider === undefined) throw new Error(`unknown installer model provider: ${providerId}`)
  while (true) {
    const method = await tui.choose(
      `How would you like to connect ${provider.name}?`,
      provider.authMethods.map(candidate => ({
        value: candidate.id,
        label: candidate.label,
        description: candidate.description ?? (candidate.subscription ? 'Uses your existing subscription' : 'Saved privately for this installer'),
      })),
      provider.authMethods[0]?.id,
    ) as InstallerAuthMethodId
    const controller = new AbortController()
    const cancellation = tui.beginCancellationScope(() => { controller.abort() })
    let externalWait: ReturnType<WizardTui['beginExternalWait']> | undefined
    try {
      await setup.authenticate(providerId, method, {
        signal: controller.signal,
        prompt: prompt => authPrompt(tui, prompt, controller.signal),
        notify: event => {
          authEvent(tui, event)
          if ((event.type === 'device_code' || (event.type === 'auth_url' && event.waitForCompletion === true)) && externalWait === undefined) {
            tui.setProgress('Waiting for sign-in')
            externalWait = tui.beginExternalWait('Waiting for browser sign-in…')
          }
        },
      })
      tui.setProgress(undefined)
      return
    } catch (error) {
      tui.setProgress(undefined)
      if (error instanceof SignInCodeCancelledError) {
        tui.addAssistant('Sign-in was cancelled. You can choose how to connect again, or press Ctrl+C to exit the installer.')
      } else if (error instanceof SecretInputCancelledError) {
        tui.addAssistant('Key entry was cancelled. You can choose how to connect again, or press Ctrl+C to exit the installer.')
      } else if (controller.signal.aborted) {
        tui.addAssistant('Sign-in was cancelled. You can choose how to connect again, or press Ctrl+C to exit the installer.')
      } else if (error instanceof ModelHostError && error.code === 'RUNTIME_UNAVAILABLE') {
        tui.addAssistant(error.message)
      } else if (error instanceof Error && /device code login is not enabled/iu.test(error.message)) {
        tui.addAssistant('Device-code login is not enabled for this account yet. Enable it on the OpenAI page, then choose the sign-in method again.')
      } else if (error instanceof Error && /timed out/iu.test(error.message)) {
        tui.addAssistant('Sign-in timed out. Choose the sign-in method again when you are ready.')
      } else {
        tui.addAssistant('Sign-in did not complete. Choose a sign-in method to try again, or press Ctrl+C to exit the installer.')
      }
    } finally {
      externalWait?.close()
      cancellation.close()
    }
  }
}

/** Configure the model that conducts installation before that model is started. */
export async function runInstallerModelWizard(tui: WizardTui, setup: WizardSetup, assistantOnly = false): Promise<InstallerModelSelection> {
  const stored = await loadInstallerModelSelection(setup.dshHome)
  const preliminary = stored !== undefined && setup.providers().some(provider => provider.id === stored.provider) ? stored : undefined
  const providers = providerChoices(setup)
  let selectedProvider = preliminary?.provider
  while (true) {
    const providerId = await tui.choose(
        assistantOnly ? 'Choose the AI service for this assistant. Press Escape here to cancel.' : 'First, choose the AI service for the installation assistant and Machtiani. Dear Machine’s backend agent is a separate choice later.',
        providers,
        selectedProvider,
      )
    selectedProvider = providerId
    const chosenProvider = setup.providers().find(candidate => candidate.id === providerId)
    try {
      if (chosenProvider?.customScope !== undefined) {
        return await runCustomProviderWizard(tui, setup, providerId, chosenProvider.customScope, preliminary, assistantOnly)
      }
      await ensureAuthentication(tui, setup, providerId, assistantOnly)

      const provider = setup.providers().find(candidate => candidate.id === providerId)
      const models = await setup.modelsFor(providerId)
      const current = preliminary?.provider === providerId && await isKnownInstallerModelSelection(setup, preliminary) ? preliminary : undefined
      let selectedModel = current?.model
      while (true) {
        let modelId: string
        try {
          modelId = await tui.choose(
            assistantOnly ? `Choose a ${provider?.name ?? providerId} model for this assistant. Type to filter the model list.` : `Which ${provider?.name ?? providerId} model should conduct the installation and power Dear Machine’s reasoning? Type to filter the model list.`,
            models.map(model => ({
              value: model.id,
              label: model.name,
              ...(model.name === model.id ? {} : { description: model.id }),
            })),
            selectedModel,
          )
        } catch (error) {
          if (error instanceof InstallerChoiceBackError) break
          throw error
        }
        selectedModel = modelId
        const model = models.find(candidate => candidate.id === modelId)
        if (model === undefined) throw new Error(`unknown installer model: ${providerId}/${modelId}`)

        let reasoningEffort: string | undefined
        if (model.reasoningEfforts.length > 0) {
          try {
            reasoningEffort = await tui.choose(
              assistantOnly ? 'How much reasoning should this assistant use?' : 'How much reasoning should the installation assistant use?',
              model.reasoningEfforts.map(effort => ({
                value: effort,
                label: effort === 'off' ? 'Off' : `${effort[0]?.toLocaleUpperCase()}${effort.slice(1)}`,
                ...(effort === 'high' ? { description: assistantOnly ? 'Recommended' : 'Recommended for installation' } : {}),
              })),
              preferredEffort(model.reasoningEfforts, current?.provider === providerId && current.model === modelId
                ? current.reasoningEffort
                : undefined),
            )
          } catch (error) {
            if (error instanceof InstallerChoiceBackError) continue
            throw error
          }
        } else {
          tui.addAssistant('This model does not offer a separate reasoning setting, so there is nothing else to configure.')
        }

        const selection: InstallerModelSelection = {
          provider: providerId,
          model: modelId,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }
        await saveInstallerModelSelection(setup.dshHome, selection)
        if (!assistantOnly) tui.addAssistant(`Ready. The installation assistant and Machtiani will use ${provider?.name ?? providerId} — ${model.name}${reasoningEffort === undefined ? '' : ` — ${reasoningEffort} reasoning`}.`)
        return selection
      }
    } catch (error) {
      if (!(error instanceof InstallerChoiceBackError)) throw error
    }
  }
}

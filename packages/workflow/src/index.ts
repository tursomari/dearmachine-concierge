import { messages } from './messages.ts'

export interface ConversationPort {
  ask(message: string): Promise<string>
  askSecret(message: string): Promise<string>
  say(message: string): void
  progress(message: string | undefined): void
  tool(name: string, detail: string): {
    succeed(summary?: string): void
    fail(summary: string): void
  }
}

export interface EnvironmentReport {
  missingFoundations: readonly string[]
  detectedBackends: readonly string[]
}

export interface EnvironmentPort {
  inspect(): Promise<EnvironmentReport>
  installFoundations(names: readonly string[]): Promise<void>
}

export type CredentialKind = 'llm' | 'email'

export interface CredentialPort {
  prepare(kind: CredentialKind, selection: string): Promise<'ready' | 'pending'>
  save(kind: CredentialKind, value: string): Promise<void>
}

export interface BackendCandidate {
  name: string
  id: string
  executable: string
}

export interface BackendReadiness extends BackendCandidate {
  status: 'ready' | 'authentication-required' | 'unhealthy'
  summary: string
}

export interface BackendPort {
  discover(): Promise<readonly BackendCandidate[]>
  check(candidates: readonly BackendCandidate[]): Promise<readonly BackendReadiness[]>
}

export interface WorkflowCheckpoint {
  stage: 'welcome' | 'environment' | 'provider' | 'model' | 'llm-credential' | 'email-transport' | 'email-credential' | 'authorized-sender' | 'complete' | 'backend-discovery' | 'backend-choice' | 'ready-to-install' | 'installing' | 'awaiting-test-email' | 'verifying-email' | 'success'
  provider?: string
  model?: string
  transport?: string
  authorizedSender?: string
  detectedBackends?: readonly string[]
  backendReadiness?: readonly BackendReadiness[]
  backend?: BackendReadiness
  inboxAddress?: string
  liveEmailBaseline?: string
}

export interface CheckpointPort {
  load(): Promise<WorkflowCheckpoint | undefined>
  save(checkpoint: WorkflowCheckpoint): Promise<void>
}

export interface InstallationSelection {
  provider: string
  model: string
  transport: string
  authorizedSender: string
  detectedBackends: readonly string[]
}

export interface WorkflowPorts {
  conversation: ConversationPort
  environment: EnvironmentPort
  credentials: CredentialPort
  checkpoint: CheckpointPort
}

export interface GuidedWorkflowPorts extends WorkflowPorts {
  backends: BackendPort
}

export interface ProductPort {
  install(selection: ReadyInstallationSelection): Promise<{ inboxAddress: string }>
  captureLiveEmailBaseline(): Promise<string>
  waitForLiveEmail(baseline: string, progress: (message: string) => void): Promise<void>
}

export interface CompleteWorkflowPorts extends GuidedWorkflowPorts {
  products: ProductPort
}

export interface ReadyInstallationSelection extends InstallationSelection {
  backend: BackendReadiness
}

const yes = (answer: string): boolean => /^(?:y|yes|continue|start|ok|okay|sure)$/iu.test(answer.trim())
const agentMail = (answer: string): boolean => /^agent\s*mail$/iu.test(answer.trim())

async function awaitCredential(
  ports: WorkflowPorts,
  kind: CredentialKind,
  selection: string,
  prompt: string,
): Promise<void> {
  if (await ports.credentials.prepare(kind, selection) === 'ready') return
  let value = await ports.conversation.askSecret(prompt)
  try {
    await ports.credentials.save(kind, value)
    ports.conversation.say('Credential saved securely.')
  } finally {
    value = ''
  }
}

/**
 * Runs the no-product-mutation slice of the canonical procedure: consent and
 * environment preparation, provider/model selection, and email setup. Secret
 * values cross only the dedicated secret-input and credential ports. They are
 * never sent through ordinary conversation, checkpoints, or transcripts.
 */
export async function runFirstThreeStages(ports: WorkflowPorts): Promise<InstallationSelection | undefined> {
  let state = await ports.checkpoint.load() ?? { stage: 'welcome' as const }

  if (state.stage === 'welcome') {
    const consent = await ports.conversation.ask(messages.welcome)
    if (!yes(consent)) {
      ports.conversation.say(messages.notNow)
      return undefined
    }
    state = { stage: 'environment' }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'environment') {
    ports.conversation.progress('Checking this computer')
    const activity = ports.conversation.tool('Environment', 'Checking basic installation requirements')
    try {
      const report = await ports.environment.inspect()
      if (report.missingFoundations.length > 0) {
        const names = report.missingFoundations.join(', ')
        const answer = await ports.conversation.ask(`Dear Machine needs ${names} before setup can continue. May I install ${names}?`)
        if (!yes(answer)) return undefined
        await ports.environment.installFoundations(report.missingFoundations)
      }
      activity.succeed('Ready')
      ports.conversation.progress(undefined)
      state = { stage: 'provider', detectedBackends: report.detectedBackends }
      await ports.checkpoint.save(state)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      activity.fail(detail)
      ports.conversation.progress(undefined)
      throw error
    }
  }

  if (state.stage === 'provider') {
    const provider = (await ports.conversation.ask(messages.provider)).trim()
    state = { ...state, stage: 'model', provider }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'model') {
    const model = (await ports.conversation.ask(messages.model(state.provider!))).trim()
    state = { ...state, stage: 'llm-credential', model }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'llm-credential') {
    await awaitCredential(ports, 'llm', state.provider!, messages.llmCredential(state.provider!, state.model!))
    state = { ...state, stage: 'email-transport' }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'email-transport') {
    const transport = (await ports.conversation.ask(messages.emailTransport)).trim()
    if (agentMail(transport)) await ports.conversation.ask(messages.agentMailHelp)
    state = { ...state, stage: 'email-credential', transport }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'email-credential') {
    await awaitCredential(ports, 'email', state.transport!, messages.emailCredential(state.transport!))
    state = { ...state, stage: 'authorized-sender' }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'authorized-sender') {
    const authorizedSender = (await ports.conversation.ask(messages.authorizedSender)).trim()
    state = { ...state, stage: 'complete', authorizedSender }
    await ports.checkpoint.save(state)
  }

  return {
    provider: state.provider!,
    model: state.model!,
    transport: state.transport!,
    authorizedSender: state.authorizedSender!,
    detectedBackends: state.detectedBackends ?? [],
  }
}

function readinessSummary(readiness: readonly BackendReadiness[]): string {
  return readiness.map(candidate => {
    switch (candidate.status) {
      case 'ready': return `${candidate.name} is ready.`
      case 'authentication-required': return `${candidate.name} is installed but needs sign-in.`
      case 'unhealthy': return `${candidate.name} is installed but its readiness check failed: ${candidate.summary}`
    }
  }).join('\n')
}

/** Extends the deterministic configuration flow through explicit backend selection. */
export async function runThroughBackendSelection(ports: GuidedWorkflowPorts): Promise<ReadyInstallationSelection | undefined> {
  const configuration = await runFirstThreeStages(ports)
  if (configuration === undefined) return undefined
  let state = (await ports.checkpoint.load())!

  if (state.stage === 'complete') {
    state = { ...state, stage: 'backend-discovery' }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'backend-discovery') {
    const candidates = await ports.backends.discover()
    if (candidates.length === 0) {
      await ports.conversation.ask("Dear Machine needs a backend agent, but I didn't find Codex, Forge, or OMP installed. Would you like help installing the agent you prefer, or would you rather install one yourself?")
      return undefined
    }
    const permission = await ports.conversation.ask(messages.backendReadiness(candidates.map(candidate => candidate.name).join(', ')))
    if (!yes(permission)) return undefined
    ports.conversation.progress('Checking the installed backend agents')
    const activity = ports.conversation.tool('Backend readiness', 'Checking only the agents you permitted')
    try {
      const readiness = await ports.backends.check(candidates)
      activity.succeed('Checks complete')
      ports.conversation.progress(undefined)
      state = { ...state, stage: 'backend-choice', backendReadiness: readiness }
      await ports.checkpoint.save(state)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      activity.fail(detail)
      ports.conversation.progress(undefined)
      throw error
    }
  }

  if (state.stage === 'backend-choice') {
    const readiness = state.backendReadiness ?? []
    const answer = (await ports.conversation.ask(messages.backendChoice(readinessSummary(readiness)))).trim()
    const selected = readiness.find(candidate => candidate.name.localeCompare(answer, undefined, { sensitivity: 'accent' }) === 0)
    if (selected === undefined) throw new Error(`The selected backend ${answer || '(empty)'} was not one of the checked agents.`)
    if (selected.status !== 'ready') throw new Error(`${selected.name} is not ready yet: ${selected.summary}`)
    state = { ...state, stage: 'ready-to-install', backend: selected }
    await ports.checkpoint.save(state)
  }

  const postSelectionStages: readonly WorkflowCheckpoint['stage'][] = [
    'ready-to-install', 'installing', 'awaiting-test-email', 'verifying-email', 'success',
  ]
  if (!postSelectionStages.includes(state.stage) || state.backend === undefined) {
    throw new Error(`cannot install from workflow stage ${state.stage}`)
  }
  return { ...configuration, backend: state.backend }
}

/** Completes product installation and proves one new human-sent email received a reply. */
export async function runCompleteInstallation(ports: CompleteWorkflowPorts): Promise<{ inboxAddress: string } | undefined> {
  const selection = await runThroughBackendSelection(ports)
  if (selection === undefined) return undefined
  let state = (await ports.checkpoint.load())!

  if (state.stage === 'ready-to-install') {
    ports.conversation.say(messages.productInstallation)
    state = { ...state, stage: 'installing' }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'installing') {
    ports.conversation.progress('Installing Machtiani and Dear Machine')
    const activity = ports.conversation.tool('Installation', 'Installing, configuring, and checking the native client')
    try {
      const installed = await ports.products.install(selection)
      const liveEmailBaseline = await ports.products.captureLiveEmailBaseline()
      activity.succeed('Native client is ready')
      ports.conversation.progress(undefined)
      state = { ...state, stage: 'awaiting-test-email', inboxAddress: installed.inboxAddress, liveEmailBaseline }
      await ports.checkpoint.save(state)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      activity.fail(detail)
      ports.conversation.progress(undefined)
      throw error
    }
  }

  if (state.stage === 'awaiting-test-email') {
    if (state.inboxAddress === undefined || state.liveEmailBaseline === undefined) {
      throw new Error('the saved live email verification state is incomplete')
    }
    await ports.conversation.ask(messages.testEmail(state.inboxAddress))
    state = { ...state, stage: 'verifying-email' }
    await ports.checkpoint.save(state)
  }

  if (state.stage === 'verifying-email') {
    if (state.liveEmailBaseline === undefined) throw new Error('the saved live email baseline is missing')
    ports.conversation.progress('Waiting for Dear Machine to receive your email')
    const activity = ports.conversation.tool('Live email', 'Waiting for a new message and its reply')
    try {
      await ports.products.waitForLiveEmail(state.liveEmailBaseline, message => ports.conversation.progress(message))
      activity.succeed('Reply sent')
      ports.conversation.progress(undefined)
      state = { ...state, stage: 'success' }
      await ports.checkpoint.save(state)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      activity.fail(detail)
      ports.conversation.progress(undefined)
      throw error
    }
  }

  if (state.stage !== 'success' || state.inboxAddress === undefined) {
    throw new Error(`cannot complete installation from workflow stage ${state.stage}`)
  }
  ports.conversation.say(messages.installationOutcome(selection.backend.name, state.inboxAddress))
  return { inboxAddress: state.inboxAddress }
}

export { messages } from './messages.ts'

import type { InstallerAgentEvent } from '@dearmachine/machtiani-installer-dsh-adapter'
import type { SourceReference } from './source-reference.ts'
import { credentialRuntimeContext, type CredentialRuntimeContext } from './credential-context.ts'
import { CredentialBridge, credentialSocketPath } from './credential-bridge.ts'
import { CredentialFileAdapter } from '@dearmachine/machtiani-installer-credentials'
import type { InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { loadDistribution, type ProductDistribution } from '@dearmachine/machtiani-installer-products'
import { loadInterfacePreferences } from './interface-preferences.ts'
import { assistantModelPath, ensureAssistantModel, sharedModelPath } from './assistant-model.ts'

interface ManagementRuntimeContext extends CredentialRuntimeContext {
  sharedModelSelection?: { provider: string; model: string; reasoningEffort?: string; profile: string }
  installation?: { method: 'standard' | 'container'; distribution: ProductDistribution }
}

export function managementAgentPrompt(text: string, sourceReference?: SourceReference, credentials?: ManagementRuntimeContext): string {
  if (sourceReference === undefined && credentials === undefined) return text
  return `<runtime_context_json>\n${JSON.stringify({ documentation: sourceReference, ...credentials }, undefined, 2)}\n</runtime_context_json>\n\nHuman message:\n${text}`
}

export interface ManagementAgent {
  runtimeContext?: ManagementRuntimeContext
  start(): Promise<void>
  prompt(text: string): Promise<void>
  interrupt(): Promise<void>
  pause?(): Promise<void>
  shutdown(): Promise<void>
}

/** Lazy DSH ownership is independent of the deterministic shell's operation queue. */
export class ManagementConversation {
  private opening: Promise<ManagementAgent> | undefined
  private agent: ManagementAgent | undefined
  private closed = false
  private contextSent = false
  private started = false
  private generation = 0
  private turns: Promise<void> = Promise.resolve()
  constructor(private readonly open: () => Promise<ManagementAgent>, private readonly sourceReference?: SourceReference) {}
  submit(text: string): Promise<void> {
    // Begin opening synchronously, so close can also account for a pending opener.
    if (this.closed) return Promise.resolve()
    this.opening ??= this.open().then(async agent => {
      if (this.closed) { await agent.shutdown(); return agent }
      this.agent = agent
      await agent.start()
      this.started = true
      return agent
    }).catch(async error => {
      await this.agent?.shutdown().catch(() => {})
      this.agent = undefined
      this.started = false
      this.opening = undefined
      throw error
    })
    const opening = this.opening
    const generation = this.generation
    const turn = this.turns.then(async () => {
      const agent = await opening
      if (this.closed || generation !== this.generation) return
      await agent.prompt(this.contextSent ? text : managementAgentPrompt(text, this.sourceReference, agent.runtimeContext))
      this.contextSent = true
    })
    this.turns = turn.catch(() => {})
    return turn
  }
  async interrupt(): Promise<void> { this.generation++; await this.agent?.interrupt() }
  async pause(): Promise<void> {
    this.generation++
    if (this.started) {
      if (this.agent?.pause) await this.agent.pause()
      else await this.agent?.interrupt()
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.agent?.shutdown()
  }
}

/** Called only after natural-language input. Reuses the profile; no model wizard. */
export async function openManagementAgent(ports: {
  event(event: InstallerAgentEvent): void
  status(status: 'running' | 'idle'): void
  askSecret: InstallerTui['askSecret']
}, sourceReference?: SourceReference): Promise<ManagementAgent> {
  const [{ DshAgentSession }, { loadModelHostProfile }, { mkdir, mkdtemp, rm }, { join }] = await Promise.all([
    import('@dearmachine/machtiani-installer-dsh-adapter'), import('@dearmachine/machtiani-model-host'),
    import('node:fs/promises'), import('node:path'),
  ])
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required.')
  const modelProfilePath = assistantModelPath(home)
  // This validates profile metadata; the model host alone resolves referenced secrets.
  const profile = await ensureAssistantModel(home)
  const shared = await loadModelHostProfile(sharedModelPath(home)).catch(() => undefined)
  const distribution = await loadDistribution(process.env)
  const preferences = await loadInterfacePreferences(home)
  const credentialsContext = credentialRuntimeContext()
  const state = join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'machtiani-installer')
  await mkdir(state, { recursive: true, mode: 0o700 })
  const dshHome = await mkdtemp(join(state, 'concierge-'))
  const workspace = sourceReference?.sourceRoot ?? join(dshHome, 'workspace')
  if (sourceReference === undefined) await mkdir(workspace, { mode: 0o700 })
  const socketPath = credentialSocketPath(state)
  const bridge = new CredentialBridge({ socketPath, tui: ports, credentials: new CredentialFileAdapter({ home }) })
  try { await bridge.start() } catch (error) {
    await bridge.close().catch(() => {})
    await rm(dshHome, { recursive: true, force: true })
    throw error
  }
  const session = new DshAgentSession({
    showCommands: preferences.showCommands,
    dshHome, workspace, modelProfilePath, outcomePath: join(dshHome, 'unused-outcome.json'),
    mode: 'management',
    environment: { MACHTIANI_INSTALLER_CREDENTIAL_SOCKET: socketPath },
    selection: { provider: profile.provider, model: profile.model, ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }) },
    onEvent: ports.event, onStatus: ports.status,
  })
  return {
    runtimeContext: {
      ...credentialsContext,
      ...(shared === undefined ? {} : { sharedModelSelection: {
        provider: shared.provider, model: shared.model, profile: sharedModelPath(home),
        ...(shared.reasoningEffort === undefined ? {} : { reasoningEffort: shared.reasoningEffort }),
      } }),
      ...(distribution === undefined ? {} : { installation: { method: 'standard', distribution } }),
    },
    start: () => session.start(), prompt: text => session.prompt(text), interrupt: () => session.interrupt(), pause: () => session.pause(),
    shutdown: async () => {
      try { await session.shutdown() }
      finally { try { await bridge.close() } finally { await rm(dshHome, { recursive: true, force: true }) } }
    },
  }
}

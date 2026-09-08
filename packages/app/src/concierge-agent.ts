import type { InstallerAgentEvent } from '@dearmachine/machtiani-installer-dsh-adapter'
import type { SourceReference } from './source-reference.ts'

export function managementAgentPrompt(text: string, sourceReference?: SourceReference): string {
  if (sourceReference === undefined) return text
  return `<runtime_context_json>\n${JSON.stringify({ documentation: sourceReference }, undefined, 2)}\n</runtime_context_json>\n\nHuman message:\n${text}`
}

export interface ManagementAgent {
  start(): Promise<void>
  prompt(text: string): Promise<void>
  interrupt(): Promise<void>
  shutdown(): Promise<void>
}

/** Lazy DSH ownership is independent of the deterministic shell's operation queue. */
export class ManagementConversation {
  private opening: Promise<ManagementAgent> | undefined
  private agent: ManagementAgent | undefined
  private closed = false
  private contextSent = false
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
      return agent
    }).catch(async error => {
      await this.agent?.shutdown().catch(() => {})
      this.agent = undefined
      this.opening = undefined
      throw error
    })
    const opening = this.opening
    const generation = this.generation
    const turn = this.turns.then(async () => {
      const agent = await opening
      if (this.closed || generation !== this.generation) return
      await agent.prompt(this.contextSent ? text : managementAgentPrompt(text, this.sourceReference))
      this.contextSent = true
    })
    this.turns = turn.catch(() => {})
    return turn
  }
  async interrupt(): Promise<void> { this.generation++; await this.agent?.interrupt() }
  async close(): Promise<void> {
    this.closed = true
    await this.agent?.shutdown()
  }
}

/** Called only after natural-language input. No model wizard or secret collection. */
export async function openManagementAgent(ports: {
  event(event: InstallerAgentEvent): void
  status(status: 'running' | 'idle'): void
}, sourceReference?: SourceReference): Promise<ManagementAgent> {
  const [{ DshAgentSession }, { loadModelHostProfile }, { mkdir, mkdtemp, rm }, { join }] = await Promise.all([
    import('@dearmachine/machtiani-installer-dsh-adapter'), import('@dearmachine/machtiani-model-host'),
    import('node:fs/promises'), import('node:path'),
  ])
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required.')
  const modelProfilePath = join(home, '.config', 'machtiani', 'model-profile.json')
  // This validates profile metadata; the model host alone resolves referenced secrets.
  const profile = await loadModelHostProfile(modelProfilePath)
  const state = join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'machtiani-installer')
  await mkdir(state, { recursive: true, mode: 0o700 })
  const dshHome = await mkdtemp(join(state, 'concierge-'))
  const workspace = sourceReference?.sourceRoot ?? join(dshHome, 'workspace')
  if (sourceReference === undefined) await mkdir(workspace, { mode: 0o700 })
  const session = new DshAgentSession({
    dshHome, workspace, modelProfilePath, outcomePath: join(dshHome, 'unused-outcome.json'),
    mode: 'management',
    selection: { provider: profile.provider, model: profile.model, ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }) },
    onEvent: ports.event, onStatus: ports.status,
  })
  return {
    start: () => session.start(), prompt: text => session.prompt(text), interrupt: () => session.interrupt(),
    shutdown: async () => { try { await session.shutdown() } finally { await rm(dshHome, { recursive: true, force: true }) } },
  }
}

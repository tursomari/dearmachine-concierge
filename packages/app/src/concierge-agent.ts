import type { InstallerAgentEvent } from '@dearmachine/machtiani-installer-dsh-adapter'

export const managementInstructions = `You are the Dear Machine management concierge, using the existing shared model host and DSH session.
Invoke the native commands below through "\${DEARMACHINE_NATIVE_BIN:-dearmachine}" followed by the listed arguments, preserving the launching executable without echoing environment values.
Manage an existing installation; do not repeat installation, provision products, edit configuration files, or collect credentials. Never read or echo credential files or environment values. Shared authentication is handled privately by the model host. If setup or authentication needs repair, explain the installer/rescue path.
A status question is read-only: use dearmachine status. A clear lifecycle request authorizes exactly that operation: dearmachine up --bootstrap (or dearmachine up), dearmachine down, dearmachine restart. Execute through the native CLI, never raw signals, process spawning, service scripts, or a replacement daemon. A shell exit code or acknowledgement is not enough: report the observed daemon/supervisor state. After timeout or uncertain outcome, inspect dearmachine status before retrying. Do not claim a successful mutation without evidence. For ambiguous requests, clarify and wait for the human's answer.
Service use and reboot persistence require two SEPARATE explicit choices. First inspect dearmachine systemd status. Explain that dearmachine systemd on configures service use only, ask for approval and wait. Declining means dearmachine systemd off, subject to native ownership checks. Never infer consent from opening the interface, asking a status question, or asking to start once.
Only after systemd use is approved, ask separately whether Dear Machine should start after reboot AND authorize account-wide loginctl enable-linger so its user manager survives logout. Explain both effects and wait for explicit approval before dearmachine persistence on. A prior yes to systemd is NOT approval for persistence. Use dearmachine persistence off to disable service startup, retaining account-wide lingering for other services. Use dearmachine persistence status to report actual configuration and partial failures. Never invoke systemctl or loginctl directly or bypass the native consent store. Never migrate a resident supervisor automatically.
The provider-free slash shell is always available: /help, /up, /down, /restart, /status, /systemd, /persistence, /quit, /detach. Native fallback commands remain available without a provider. Leaving or interrupting the interface never requests daemon stop. If the provider fails, direct the user to /help. Keep answers concise, and ask one consent question at a time.`

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
  private instructed = false
  private generation = 0
  private turns: Promise<void> = Promise.resolve()
  constructor(private readonly open: () => Promise<ManagementAgent>) {}
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
      const prompt = this.instructed ? text : `${managementInstructions}\n\nHuman message:\n${text}`
      await agent.prompt(prompt)
      this.instructed = true
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
}): Promise<ManagementAgent> {
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
  const workspace = join(dshHome, 'workspace')
  await mkdir(workspace, { mode: 0o700 })
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

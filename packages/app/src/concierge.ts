import { ManagementConversation, openManagementAgent } from './concierge-agent.ts'
import { InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { nativeSupervisionChoice, defaultConciergeControl, type DaemonControl } from './concierge-control.ts'
import { inspectInstallation, runConciergeEntry, type InstallationDiagnosis } from './concierge-entry.ts'
import { ConciergeShell, readDaemonStatusReport, conciergeInterruptHint, conciergeWelcome } from './concierge-shell.ts'
import { renderAgentEvent, type AgentToolActivityState } from './index.ts'
import { loadSourceReference, resolveSourceReference, type SourceReference } from './source-reference.ts'
import { changeAssistantModel } from './assistant-model.ts'

export { defaultConciergeControl } from './concierge-control.ts'

export async function runLocalConcierge(control: DaemonControl, diagnosis: InstallationDiagnosis, sourceReference?: SourceReference): Promise<void> {
  let requestExit!: () => void
  const exited = new Promise<void>(resolve => { requestExit = resolve })
  const lifetime = new AbortController()
  let modelChange: Promise<void> | undefined
  let shell!: ConciergeShell
  const tools = new Map<string, AgentToolActivityState>()
  const conversation: ManagementConversation = new ManagementConversation(() => openManagementAgent({
    askSecret: (message, signal) => tui.askSecret(message, signal),
    event: event => {
      if (event.type !== 'turn-end') renderAgentEvent(tui, tools, event.type === 'assistant' ? { ...event, reasoning: '' } : event)
      if (event.type === 'turn-end' && event.outcome !== 'completed') {
        tui.setProgress(undefined)
        tui.addAssistant('The management assistant could not complete that turn. Use /help for local controls; inspect dearmachine status for any unconfirmed operation.')
      }
    },
    status: status => tui.setProgress(status === 'running' ? 'Thinking' : undefined),
  }, sourceReference), sourceReference)
  const tui = new InstallerTui({
    title: 'Dear Machine Concierge', exitWindowMs: 2_000, interruptHint: conciergeInterruptHint,
    onSubmit: text => shell.submit(text),
    onLocalCommand: text => shell.submit(text),
    onInterrupt: () => conversation.interrupt(),
    onExit: () => { void shell.submit('/quit') },
  })
  shell = new ConciergeShell({
    chooseSupervision: nativeSupervisionChoice,
    converse: text => conversation.submit(text),
    changeModel: async () => {
      const home = process.env.HOME
      if (!home) throw new Error('HOME is required.')
      modelChange = changeAssistantModel(tui, { home, signal: lifetime.signal, pause: () => conversation.pause() })
      await modelChange
    },
    control, say: text => tui.addAssistant(text),
    // Native control owns daemon startup; this interface has no daemon attachment or log subscription.
    ensureIndependent: async () => {}, unsubscribe: async () => {},
    close: async () => { lifetime.abort(); requestExit() },
  })
  try {
    const statusReport = diagnosis.status === undefined ? `Installation: ${diagnosis.installation}.`
      : await readDaemonStatusReport(control, diagnosis.status)
    tui.start()
    tui.addAssistant(conciergeWelcome)
    tui.addAssistant(statusReport)
    if (diagnosis.guidance !== undefined) tui.addAssistant(diagnosis.guidance)
    await exited
  } finally {
    lifetime.abort()
    try { await conversation.close() } finally { await tui.dispose(); await modelChange?.catch(() => {}) }
  }
}

export async function launchConcierge(sourceRoot?: string): Promise<void> {
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required to locate installation state.')
  const control = defaultConciergeControl()
  const managementReference = async () => sourceRoot === undefined
    ? await loadSourceReference(home).catch(() => undefined)
    : await resolveSourceReference(sourceRoot)
  await runConciergeEntry({
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    inspect: () => inspectInstallation(home, control),
    install: async () => {
      if (sourceRoot === undefined) {
        await runLocalConcierge(control, { installation: 'absent', guidance: 'To begin guided installation, run dearmachine --source-root /absolute/path/to/machtiani. Use /help for local controls.' })
        return
      }
      const { runInstaller } = await import('./index.ts')
      await runInstaller(sourceRoot)
    },
    manage: async diagnosis => runLocalConcierge(control, diagnosis, await managementReference()),
    write: text => { process.stdout.write(text) },
  })
}

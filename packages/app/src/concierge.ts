import { handoffInstalledConcierge } from './concierge-handoff.ts'
import type { InstallationMethod } from '@dearmachine/machtiani-installer-products'
import { ManagementConversation, openManagementAgent } from './concierge-agent.ts'
import { InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { nativeSupervisionChoice, defaultConciergeControl, type DaemonControl } from './concierge-control.ts'
import { inspectInstallation, runConciergeEntry, type InstallationDiagnosis } from './concierge-entry.ts'
import { ConciergeShell, readDaemonStatusReport, conciergeInterruptHint, conciergeWelcome } from './concierge-shell.ts'
import { renderAgentEvent, type AgentToolActivityState } from './index.ts'
import { loadSourceReference, resolveSourceReference, type SourceReference } from './source-reference.ts'
import { changeAssistantModel } from './assistant-model.ts'
import { NativeUpdateControl } from './native-update.ts'
import { NaturalUpdateRouter, runConciergeUpdate } from './concierge-update.ts'
import { ConciergeActivityIndicator } from './concierge-activity.ts'

export { defaultConciergeControl } from './concierge-control.ts'
export const CONCIERGE_RELAUNCH_EXIT_CODE = 75

export async function runLocalConcierge(control: DaemonControl, diagnosis: InstallationDiagnosis, sourceReference?: SourceReference): Promise<'closed' | 'relaunch'> {
  let requestExit!: (result: 'closed' | 'relaunch') => void
  const exited = new Promise<'closed' | 'relaunch'>(resolve => { requestExit = resolve })
  const lifetime = new AbortController()
  let modelChange: Promise<void> | undefined
  let shell!: ConciergeShell
  const naturalUpdates = new NaturalUpdateRouter()
  const tools = new Map<string, AgentToolActivityState>()
  let activity!: ConciergeActivityIndicator
  const conversation: ManagementConversation = new ManagementConversation(() => openManagementAgent({
    askSecret: (message, signal) => tui.askSecret(message, signal),
    event: event => {
      activity.event(event)
      const updateRequest = naturalUpdates.accept(event)
      if (event.type === 'local-action' || event.type === 'assistant-stream') {
        return
      }
      if (event.type !== 'turn-end') renderAgentEvent(tui, tools, event.type === 'assistant' ? { ...event, reasoning: '' } : event)
      if (updateRequest !== undefined) void shell.requestUpdate(updateRequest)
      if (event.type === 'turn-end' && event.outcome !== 'completed') {
        tui.setProgress(undefined)
        tui.addAssistant('The management assistant could not complete that turn. Use /help for local controls; inspect dearmachine status for any unconfirmed operation.')
      }
    },
    status: status => activity.status(status),
  }, sourceReference), sourceReference)
  const tui = new InstallerTui({
    title: 'Dear Machine Concierge', exitWindowMs: 2_000, interruptHint: conciergeInterruptHint,
    inputPlaceholder: 'Enter a prompt or /help',
    onSubmit: text => shell.submit(text),
    onLocalCommand: text => shell.submit(text),
    onInterrupt: () => conversation.interrupt(),
    onExit: () => { void shell.submit('/quit') },
  })
  activity = new ConciergeActivityIndicator(tui)
  const updater = new NativeUpdateControl()
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
    update: request => runConciergeUpdate({
      updater, tui, request,
      relaunch: async () => { lifetime.abort(); requestExit('relaunch') },
      close: async () => { lifetime.abort(); requestExit('closed') },
    }),
    // Native control owns daemon startup; this interface has no daemon attachment or log subscription.
    ensureIndependent: async () => {}, unsubscribe: async () => {},
    close: async () => { lifetime.abort(); requestExit('closed') },
  })
  try {
    tui.start()
    tui.addAssistant(conciergeWelcome)
    const statusReport = diagnosis.status === undefined ? `Installation: ${diagnosis.installation}.`
      : await readDaemonStatusReport(control, diagnosis.status)
    tui.addAssistant(statusReport)
    if (diagnosis.guidance !== undefined) tui.addAssistant(diagnosis.guidance)
    if (diagnosis.installation === 'installed') await shell.requestUpdate('startup')
    return await exited
  } finally {
    lifetime.abort()
    activity.dispose()
    try { await conversation.close() } finally { await tui.dispose(); await modelChange?.catch(() => {}) }
  }
}

export async function launchConcierge(sourceRoot?: string, method?: InstallationMethod): Promise<'closed' | 'relaunch'> {
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required to locate installation state.')
  const control = defaultConciergeControl()
  const managementReference = async () => sourceRoot === undefined
    ? await loadSourceReference(home).catch(() => undefined)
    : await resolveSourceReference(sourceRoot)
  let result: 'closed' | 'relaunch' = 'closed'
  await runConciergeEntry({
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    inspect: () => inspectInstallation(home, control),
    install: async () => {
      if (sourceRoot === undefined) {
        result = await runLocalConcierge(control, { installation: 'absent', guidance: 'To begin guided installation, run dearmachine --source-root /absolute/path/to/machtiani. Use /help for local controls.' })
        return
      }
      const { runInstaller } = await import('./index.ts')
      await runInstaller(sourceRoot, undefined, method)
    },
    manage: async diagnosis => {
      // An absent supervisor cannot establish installation health. Let the
      // installed native entry inspect its own state, including a stopped client.
      if (['installed', 'unknown'].includes(diagnosis.installation) && await handoffInstalledConcierge()) return
      result = await runLocalConcierge(control, diagnosis, await managementReference())
    },
    write: text => { process.stdout.write(text) },
  })
  return result
}

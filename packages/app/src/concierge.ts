import { ManagementConversation, openManagementAgent } from './concierge-agent.ts'
import { InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { nativeSupervisionChoice, defaultConciergeControl, type DaemonControl } from './concierge-control.ts'
import { inspectInstallation, runConciergeEntry, type InstallationDiagnosis } from './concierge-entry.ts'
import { ConciergeShell, formatDaemonStatus, conciergeInterruptHint } from './concierge-shell.ts'
import { loadSourceReference, resolveSourceReference, type SourceReference } from './source-reference.ts'

export { defaultConciergeControl } from './concierge-control.ts'

export async function runLocalConcierge(control: DaemonControl, diagnosis: InstallationDiagnosis, sourceReference?: SourceReference): Promise<void> {
  let requestExit!: () => void
  const exited = new Promise<void>(resolve => { requestExit = resolve })
  let shell!: ConciergeShell
  const conversation = new ManagementConversation(() => openManagementAgent({
    event: event => {
      if (event.type === 'assistant' && event.text.trim()) tui.addAssistant(event.text)
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
    control, say: text => tui.addAssistant(text),
    // Native control owns daemon startup; this interface has no daemon attachment or log subscription.
    ensureIndependent: async () => {}, unsubscribe: async () => {},
    close: async () => { requestExit() },
  })
  try {
    tui.start()
    tui.addAssistant(diagnosis.status === undefined ? `Installation: ${diagnosis.installation}.` : formatDaemonStatus(diagnosis.status))
    if (diagnosis.guidance !== undefined) tui.addAssistant(diagnosis.guidance)
    tui.addAssistant('Use /help for local commands. Opening and leaving this interface does not change daemon state.')
    await exited
  } finally { try { await conversation.close() } finally { await tui.dispose() } }
}

export async function launchConcierge(sourceRoot?: string): Promise<void> {
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required to locate installation state.')
  const sourceReference = sourceRoot === undefined
    ? await loadSourceReference(home).catch(() => undefined)
    : await resolveSourceReference(sourceRoot)
  const control = defaultConciergeControl()
  await runConciergeEntry({
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    inspect: () => inspectInstallation(home, control),
    install: async () => {
      if (sourceRoot === undefined) {
        await runLocalConcierge(control, { installation: 'absent', guidance: 'To begin guided installation, run dearmachine --source-root /absolute/path/to/machtiani. Use /help for local controls.' }, sourceReference)
        return
      }
      const { runInstaller } = await import('./index.ts')
      await runInstaller(sourceRoot)
    },
    manage: diagnosis => runLocalConcierge(control, diagnosis, sourceReference),
    write: text => { process.stdout.write(text) },
  })
}

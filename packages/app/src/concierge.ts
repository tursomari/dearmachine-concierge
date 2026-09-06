import { InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { nativeSupervisionChoice, defaultConciergeControl, type DaemonControl } from './concierge-control.ts'
import { inspectInstallation, runConciergeEntry, type InstallationDiagnosis } from './concierge-entry.ts'
import { ConciergeShell, formatDaemonStatus, conciergeInterruptHint } from './concierge-shell.ts'

export { defaultConciergeControl } from './concierge-control.ts'

export async function runLocalConcierge(control: DaemonControl, diagnosis: InstallationDiagnosis): Promise<void> {
  let requestExit!: () => void
  const exited = new Promise<void>(resolve => { requestExit = resolve })
  let shell!: ConciergeShell
  const tui = new InstallerTui({
    title: 'Dear Machine Concierge', exitWindowMs: 2_000, interruptHint: conciergeInterruptHint,
    onSubmit: text => shell.submit(text),
    onLocalCommand: text => shell.submit(text),
    onExit: () => { void shell.submit('/quit') },
  })
  shell = new ConciergeShell({
    chooseSupervision: nativeSupervisionChoice,
    control, say: text => tui.addAssistant(text),
    // This entry never spawns or attaches to a daemon or subscribes to logs.
    ensureIndependent: async () => {}, unsubscribe: async () => {},
    close: async () => { requestExit() },
  })
  try {
    tui.start()
    tui.addAssistant(diagnosis.status === undefined ? `Installation: ${diagnosis.installation}.` : formatDaemonStatus(diagnosis.status))
    if (diagnosis.guidance !== undefined) tui.addAssistant(diagnosis.guidance)
    tui.addAssistant('Use /help for local commands. Opening and leaving this interface does not change daemon state.')
    await exited
  } finally { await tui.dispose() }
}

export async function launchConcierge(sourceRoot?: string): Promise<void> {
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required to locate installation state.')
  const control = defaultConciergeControl(process.env, text => { process.stdout.write(text + '\n') })
  await runConciergeEntry({
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    inspect: () => inspectInstallation(home, control),
    install: async () => {
      if (sourceRoot === undefined) {
        await runLocalConcierge(control, { installation: 'absent', guidance: 'To begin guided installation, run machtiani-installer --concierge --source-root /absolute/path/to/machtiani. Use /help for local controls.' })
        return
      }
      const { runInstaller } = await import('./index.ts')
      await runInstaller(sourceRoot)
    },
    manage: diagnosis => runLocalConcierge(control, diagnosis),
    write: text => { process.stdout.write(text) },
  })
}

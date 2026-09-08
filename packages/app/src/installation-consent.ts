import { InstallerChoiceBackError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { messages } from '@dearmachine/machtiani-installer-workflow'

/** Escape returns from command visibility to consent; local exit works at either menu. */
export async function installationConsent(tui: Pick<InstallerTui, 'choose' | 'addAssistant'>, exited: Promise<void>): Promise<{ showCommands: boolean } | undefined> {
  while (true) {
    const consent = await Promise.race([
      tui.choose(messages.welcome, [
        { value: 'continue', label: 'Continue', description: 'Begin guided installation' },
        { value: 'not-now', label: 'Not now', description: 'Exit without changing anything' },
      ], 'continue').catch(error => { if (error instanceof InstallerChoiceBackError) return 'not-now'; throw error }),
      exited.then(() => 'not-now'),
    ])
    if (consent !== 'continue') { tui.addAssistant(messages.notNow); return undefined }
    try {
      const choice = await Promise.race([
        tui.choose('Would you like to see the shell commands as they run?', [
          { value: 'no', label: 'Keep it brief', description: 'Show progress and tool summaries' },
          { value: 'yes', label: 'Show commands', description: 'Also show commands in subdued grey; credential-bearing commands are hidden' },
        ], 'no'),
        exited.then(() => undefined),
      ])
      return choice === undefined ? undefined : { showCommands: choice === 'yes' }
    } catch (error) { if (!(error instanceof InstallerChoiceBackError)) throw error }
  }
}

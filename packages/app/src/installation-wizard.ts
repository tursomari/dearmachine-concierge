import { InstallerChoiceBackError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import type { InstallerModelSelection } from '@dearmachine/machtiani-installer-dsh-adapter'
import type { InstallationMethod } from '@dearmachine/machtiani-installer-products'
import { installationConsent } from './installation-consent.ts'
import { chooseInstallationMethod } from './installation-method.ts'

/** Each menu owns one back edge; the provider wizard can return to this parent. */
export async function runInstallationWizard(
  tui: Pick<InstallerTui, 'choose' | 'addAssistant'>,
  prebuiltAvailable: boolean,
  exited: Promise<void>,
  chooseModel: () => Promise<InstallerModelSelection>,
): Promise<{ selection: InstallerModelSelection; method: InstallationMethod; showCommands: boolean } | undefined> {
  while (true) {
    const consent = await installationConsent(tui, exited)
    if (consent === undefined) return
    while (true) {
      const method = await chooseInstallationMethod(tui, prebuiltAvailable, exited)
      if (method === undefined) return
      if (method === 'back') break
      try {
        const selection = await Promise.race([chooseModel(), exited.then(() => undefined)])
        if (selection === undefined) return
        return { selection, method, showCommands: consent.showCommands }
      } catch (error) {
        if (!(error instanceof InstallerChoiceBackError)) throw error
        if (!prebuiltAvailable) break
      }
    }
  }
}

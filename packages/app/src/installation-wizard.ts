import { InstallerChoiceBackError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import type { InstallerModelSelection } from '@dearmachine/machtiani-installer-dsh-adapter'
import type { InstallationMethod } from '@dearmachine/machtiani-installer-products'
import { installationConsent } from './installation-consent.ts'
import { chooseInstallationMethod, isNixOS } from './installation-method.ts'

/** Each menu owns one back edge; the provider wizard can return to this parent. */
export async function runInstallationWizard(
  tui: Pick<InstallerTui, 'choose' | 'addAssistant'>,
  prebuiltAvailable: boolean,
  exited: Promise<void>,
  chooseModel: () => Promise<InstallerModelSelection>,
  prepare: (method: InstallationMethod) => Promise<void> = async () => {},
  platform: NodeJS.Platform = process.platform,
  nixos?: boolean,
): Promise<{ selection: InstallerModelSelection; method: InstallationMethod; showCommands: boolean } | undefined> {
  let closed = false
  void exited.then(() => { closed = true })
  const automaticNix = platform === 'linux' && (nixos ?? await isNixOS(platform))
  while (!closed) {
    const consent = await installationConsent(tui, exited)
    if (consent === undefined) return
    while (true) {
      const method = await chooseInstallationMethod(tui, prebuiltAvailable, exited, platform, automaticNix)
      if (method === undefined) return
      if (method === 'back') break
      try {
        await prepare(method)
      } catch (error) {
        if (closed) return
        tui.addAssistant(error instanceof Error ? error.message : 'Software preparation failed. Choose a method to try again.')
        if (automaticNix) break // Retry through consent, never a tight automatic loop.
        continue
      }
      if (closed) return
      try {
        const selection = await Promise.race([chooseModel(), exited.then(() => undefined)])
        if (selection === undefined) return
        return { selection, method, showCommands: consent.showCommands }
      } catch (error) {
        if (!(error instanceof InstallerChoiceBackError)) throw error
        if (automaticNix) break // There is no method menu to go back to on NixOS.
      }
    }
  }
}

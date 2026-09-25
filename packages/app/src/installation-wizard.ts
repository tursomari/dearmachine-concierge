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
  prepare: (method: InstallationMethod) => Promise<void | 'back'> = async () => {},
  platform: NodeJS.Platform = process.platform,
  nixos?: boolean,
  requestedMethod?: InstallationMethod,
): Promise<{ selection: InstallerModelSelection; method: InstallationMethod; showCommands: boolean } | undefined> {
  let closed = false
  void exited.then(() => { closed = true })
  const automaticNix = platform === 'linux' && (nixos ?? await isNixOS(platform))
  if (requestedMethod === 'standard' && automaticNix) throw new Error('Standard is unavailable on NixOS. Use the Nix Quick start.')
  if (requestedMethod === 'nix' && platform === 'win32') throw new Error('Nix is unavailable for native Windows. Use the Windows Quick start.')
  const fixedMethod = requestedMethod ?? (platform === 'win32' ? 'standard' : automaticNix ? 'nix' : undefined)
  while (!closed) {
    const consent = await installationConsent(tui, exited)
    if (consent === undefined) return
    while (true) {
      if (requestedMethod) tui.addAssistant(`Installation method: ${requestedMethod === 'nix' ? 'Nix' : 'Standard'}`)
      const method = requestedMethod ?? await chooseInstallationMethod(tui, prebuiltAvailable, exited, platform, automaticNix)
      if (method === undefined) return
      if (method === 'back') break
      try {
        if (await prepare(method) === 'back') {
          if (fixedMethod) break
          continue
        }
      } catch (error) {
        if (closed) return
        tui.addAssistant(error instanceof Error ? error.message : 'Software preparation failed. Choose a method to try again.')
        if (fixedMethod) break // Retry through consent when there is no method menu.
        continue
      }
      if (closed) return
      try {
        const selection = await Promise.race([chooseModel(), exited.then(() => undefined)])
        if (selection === undefined) return
        return { selection, method, showCommands: consent.showCommands }
      } catch (error) {
        if (!(error instanceof InstallerChoiceBackError)) throw error
        if (fixedMethod) break // A fixed route has no method menu to go back to.
      }
    }
  }
}

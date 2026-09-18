import { InstallerChoiceBackError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import type { InstallationMethod } from '@dearmachine/machtiani-installer-products'

export async function chooseInstallationMethod(
  tui: Pick<InstallerTui, 'choose'>, _prebuiltAvailable: boolean, exited: Promise<void>,
  platform: NodeJS.Platform = process.platform,
): Promise<InstallationMethod | 'back' | undefined> {
  try {
    const choice = await Promise.race([
      tui.choose('How would you like to install Dear Machine?', [
        { value: 'nix', label: 'Nix', description: 'Use Nix-managed packages. We will ask before installing Nix if needed.' },
        ...(platform === 'darwin' ? [] : [
          { value: 'container', label: 'Container build', description: 'Build locally using Docker. Downloads are cached for later builds.' },
        ]),
      ], platform === 'darwin' ? 'nix' : 'container'),
      exited.then(() => undefined),
    ])
    if (choice === undefined || (choice === 'container' && platform !== 'darwin') || choice === 'nix') return choice
    throw new Error('invalid installation method')
  } catch (error) {
    if (error instanceof InstallerChoiceBackError) return 'back'
    throw error
  }
}

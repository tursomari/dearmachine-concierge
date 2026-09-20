import { readFile } from 'node:fs/promises'
import { InstallerChoiceBackError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import type { InstallationMethod } from '@dearmachine/machtiani-installer-products'

/** os-release identifies the host; an installed Nix executable does not. */
export async function isNixOS(
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => Promise<string> = path => readFile(path, 'utf8'),
): Promise<boolean> {
  if (platform !== 'linux') return false
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const release = await read(path)
      return /^ID=(?:nixos|"nixos"|'nixos')[ \t]*$/mu.test(release)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
  }
  return false
}

export async function chooseInstallationMethod(
  tui: Pick<InstallerTui, 'choose' | 'addAssistant'>, _prebuiltAvailable: boolean, exited: Promise<void>,
  platform: NodeJS.Platform = process.platform,
  nixos = false,
): Promise<InstallationMethod | 'back' | undefined> {
  if (platform === 'win32') {
    tui.addAssistant('Installation method: native Windows')
    return 'standard'
  }
  if (platform === 'linux' && nixos) {
    tui.addAssistant('Installation method: Nix')
    return 'nix'
  }
  try {
    const choice = await Promise.race([
      tui.choose('How would you like to install Dear Machine?', [
        { value: 'nix', label: 'Nix', description: 'Use Nix-managed packages (recommended). NixOS is not required.' },
        { value: 'standard', label: 'Standard', description: platform === 'darwin'
          ? 'Build directly on this Mac.'
          : 'Build using Docker. Install and run directly on this computer.' },
      ], 'nix'),
      exited.then(() => undefined),
    ])
    if (choice === undefined || choice === 'standard' || choice === 'nix') return choice
    throw new Error('invalid installation method')
  } catch (error) {
    if (error instanceof InstallerChoiceBackError) return 'back'
    throw error
  }
}

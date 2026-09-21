import { join } from 'node:path'
import { loadDistribution } from '@dearmachine/machtiani-installer-products'

/** Resolve the installation's writer, never a backend or an arbitrary PATH entry. */
export async function installedMachtianiCommand(home: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform !== 'win32') return join(home, '.local', 'bin', 'machtiani')
  const distribution = await loadDistribution(environment)
  if (!distribution) throw new Error('Run Machtiani configuration through the installed Windows launcher.')
  return distribution.binaries.machtiani
}

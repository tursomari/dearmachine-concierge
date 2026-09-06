import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DaemonCommand, DaemonControl, DaemonStatus, InstallationState } from './concierge-control.ts'

export const entryHelp = `Usage: machtiani-installer [--concierge [--source-root /absolute/path/to/machtiani]]
       machtiani-installer --install --source-root /absolute/path/to/machtiani
       machtiani-installer --mock
       machtiani-installer status|up|down|restart
       machtiani-installer --help

Bare interactive invocation opens the local concierge. Fresh installation
requires --source-root. Without a TTY, bare invocation prints this help.
Concierge controls require a compatible supervisor endpoint; see /help.
Native rescue commands: dearmachine --help, dearmachine status,
dearmachine up, dearmachine down, dearmachine restart.
Native init, setup-agents, and inbox remain commands of dearmachine.
`

export type InstallerInvocation =
  | { mode: 'mock' | 'help' }
  | { mode: 'install'; sourceRoot: string }
  | { mode: 'concierge'; sourceRoot?: string }
  | { mode: 'control'; command: DaemonCommand }

export function parseInvocation(args: readonly string[]): InstallerInvocation {
  if (args.length === 0 || (args.length === 1 && args[0] === '--concierge')) return { mode: 'concierge' }
  if (args.length === 1) {
    if (args[0] === '--help') return { mode: 'help' }
    if (args[0] === '--mock') return { mode: 'mock' }
    if (['status', 'up', 'down', 'restart'].includes(args[0]!)) return { mode: 'control', command: args[0] as DaemonCommand }
  }
  if (args.length === 3 && ['--install', '--concierge'].includes(args[0]!) && args[1] === '--source-root' && args[2] !== '') {
    return { mode: args[0] === '--install' ? 'install' : 'concierge', sourceRoot: args[2]! }
  }
  throw new Error(entryHelp)
}

export interface InstallationDiagnosis {
  installation: InstallationState
  status?: DaemonStatus
  guidance?: string
}
const recoveryGuidance = 'Existing installation state needs diagnosis. Run dearmachine status and dearmachine --help. The concierge will not overwrite or reinstall it.'

/** Presence guards against overwrite; only the native control owner can validate an installation. */
export async function inspectInstallation(
  home: string,
  control: DaemonControl,
  inspect: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }> = lstat,
): Promise<InstallationDiagnosis> {
  let existing = false
  for (const directory of ['.dearmachine', '.machtiani']) {
    try {
      const metadata = await inspect(join(home, directory))
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { installation: 'partial', guidance: recoveryGuidance }
      existing = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { installation: 'unreadable', guidance: recoveryGuidance }
    }
  }
  if (!existing) return { installation: 'absent' }
  try {
    const status = await control.request('status')
    if (status.installation === 'absent') return { installation: 'partial', guidance: recoveryGuidance }
    return { installation: status.installation, status, ...(status.installation === 'installed' ? {} : { guidance: recoveryGuidance }) }
  } catch {
    return { installation: 'partial', guidance: recoveryGuidance }
  }
}

export async function runConciergeEntry(ports: {
  interactive: boolean
  inspect(): Promise<InstallationDiagnosis>
  install(): Promise<void>
  manage(diagnosis: InstallationDiagnosis): Promise<void>
  write(text: string): void
}): Promise<void> {
  if (!ports.interactive) { ports.write(entryHelp); return }
  const diagnosis = await ports.inspect()
  if (diagnosis.installation !== 'absent') { await ports.manage(diagnosis); return }
  await ports.install()
  const after = await ports.inspect()
  if (after.installation !== 'absent') await ports.manage(after)
}

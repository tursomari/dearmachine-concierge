import type { InstallationMethod } from '@dearmachine/machtiani-installer-products'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { DaemonCommand, DaemonControl, DaemonStatus, InstallationState } from './concierge-control.ts'

export const entryHelp = `Usage: dearmachine [--source-root /absolute/path/to/machtiani]
       dearmachine status|up|down|restart
       dearmachine update [--check | --recover] [--json]
       machtiani-installer quick-start [--method nix|standard] --source-root /absolute/path/to/machtiani
       machtiani-installer install --source-root /absolute/path/to/machtiani
       machtiani-installer migrate-profile <entry> [--check]
       dearmachine --help

Bare interactive invocation detects whether Dear Machine is installed. It opens
guided installation when absent and the local concierge when installed. Fresh
installation requires --source-root or DEARMACHINE_SOURCE_ROOT (an absolute
umbrella checkout).
Without a TTY, bare invocation prints this help.
Concierge controls require a compatible supervisor endpoint; see /help.
Native init, setup-agents, and inbox remain commands of dearmachine.
machtiani-installer remains available as a compatibility alias.
`

export type InstallerInvocation =
  | { mode: 'managed'; action: 'install' | 'update' | 'migrate-profile' | '_launcher-check'; args: string[] }
  | { mode: 'mock' }
  | { mode: 'help' }
  | { mode: 'install'; sourceRoot: string }
  | { mode: 'concierge'; sourceRoot?: string; method?: InstallationMethod }
  | { mode: 'control'; command: DaemonCommand }

export function parseInvocation(args: readonly string[], environment: NodeJS.ProcessEnv = {}): InstallerInvocation {
  if (args[0] === 'quick-start') {
    let sourceRoot: string | undefined
    let method: InstallationMethod = 'nix'
    const seen = new Set<string>()
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index]!
      const value = args[index + 1]
      if (seen.has(flag) || !value) throw new Error(entryHelp)
      seen.add(flag)
      if (flag === '--source-root') sourceRoot = value
      else if (flag === '--method' && (value === 'nix' || value === 'standard')) method = value
      else throw new Error(entryHelp)
    }
    if (!sourceRoot) throw new Error(entryHelp)
    if (!isAbsolute(sourceRoot)) throw new Error('--source-root must be absolute.')
    return { mode: 'concierge', sourceRoot, method }
  }
  if (args[0] === 'update' || args[0] === 'install' || args[0] === 'migrate-profile' || args[0] === '_launcher-check') return { mode: 'managed', action: args[0], args: args.slice(1) }
  if (args.length === 0 || (args.length === 1 && args[0] === '--concierge')) {
    const sourceRoot = environment.DEARMACHINE_SOURCE_ROOT
    if (!sourceRoot) return { mode: 'concierge' }
    if (!isAbsolute(sourceRoot)) throw new Error('DEARMACHINE_SOURCE_ROOT must be absolute.')
    return { mode: 'concierge', sourceRoot }
  }
  if (args.length === 1) {
    if (args[0] === '--help') return { mode: 'help' }
    if (args[0] === '--mock') return { mode: 'mock' }
    if (['status', 'up', 'down', 'restart'].includes(args[0]!)) return { mode: 'control', command: args[0] as DaemonCommand }
  }
  if (args.length === 2 && args[0] === '--source-root' && args[1] !== '') {
    if (!isAbsolute(args[1]!)) throw new Error('--source-root must be absolute.')
    return { mode: 'concierge', sourceRoot: args[1]! }
  }
  if (args.length === 3 && ['--install', '--concierge'].includes(args[0]!) && args[1] === '--source-root' && args[2] !== '') {
    if (!isAbsolute(args[2]!)) throw new Error('--source-root must be absolute.')
    return { mode: args[0] === '--install' ? 'install' : 'concierge', sourceRoot: args[2]! }
  }
  throw new Error(entryHelp)
}

export interface InstallationDiagnosis {
  installation: InstallationState | 'unknown'
  status?: DaemonStatus
  guidance?: string
}
const recoveryGuidance = 'Existing installation state needs diagnosis. Run dearmachine status and dearmachine --help. The concierge will not overwrite or reinstall it.'

/** Presence guards against overwrite; native status validates independently of liveness. */
export async function inspectInstallation(
  home: string,
  control: DaemonControl,
  inspect: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }> = lstat,
): Promise<InstallationDiagnosis> {
  let existing = false
  for (const directory of ['.dearmachine']) {
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
    return { installation: 'unknown', guidance: 'Installation health could not be verified. Run dearmachine status. An unavailable supervisor does not establish an incomplete installation.' }
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

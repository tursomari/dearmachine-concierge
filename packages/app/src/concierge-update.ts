import { InstallerChoiceBackError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import type { UpdateCheckResult, UpdateInstallResult } from './native-update.ts'
import type { InstallerAgentEvent } from '@dearmachine/machtiani-installer-dsh-adapter'

export type UpdateRequest = 'startup' | 'check' | 'install'

export interface ConciergeUpdater {
  check(): Promise<UpdateCheckResult>
  install(): Promise<UpdateInstallResult>
}

/** Wait for the interpreting model turn to end before entering local lifecycle serialization. */
export class NaturalUpdateRouter {
  private pending: Exclude<UpdateRequest, 'startup'> | undefined

  accept(event: InstallerAgentEvent): Exclude<UpdateRequest, 'startup'> | undefined {
    if (event.type === 'local-action') {
      const request = event.action === 'install-update' ? 'install' : 'check'
      if (request === 'install' || this.pending === undefined) this.pending = request
      return undefined
    }
    if (event.type !== 'turn-end' || this.pending === undefined) return undefined
    const request = this.pending
    this.pending = undefined
    return request
  }
}

export async function runConciergeUpdate(ports: {
  updater: ConciergeUpdater
  tui: Pick<InstallerTui, 'choose' | 'addAssistant' | 'setProgress'>
  request: UpdateRequest
  relaunch(): Promise<void>
  close(): Promise<void>
}): Promise<void> {
  ports.tui.setProgress('Checking for Dear Machine updates')
  let checked: UpdateCheckResult
  try { checked = await ports.updater.check() } catch { checked = { state: 'failed' } }
  finally { ports.tui.setProgress(undefined) }

  if (checked.state === 'current') {
    ports.tui.addAssistant(`Updates: current. This concierge is release ${checked.current}.`)
    return
  }
  if (checked.state === 'unsupported') {
    ports.tui.addAssistant('Updates: unsupported for this installation channel. Continue using this concierge and follow the release channel’s own update instructions.')
    return
  }
  if (checked.state === 'failed') {
    ports.tui.addAssistant('Update check failed. No installation change was requested, and you can keep using this concierge. Try /update later or inspect dearmachine update --check.')
    return
  }

  ports.tui.addAssistant(`Updates: available. Installed release ${checked.current}; available release ${checked.available}.`)
  if (ports.request === 'check') return

  let choice: string
  try {
    choice = await ports.tui.choose('Install this update now? If Dear Machine is running, it will briefly stop and restart. If it is stopped, it will stay stopped.', [
      { value: 'not-now', label: 'Not now', description: 'Keep using your current version' },
      { value: 'install', label: 'Install update', description: 'Update Dear Machine to the new version' },
    ], 'not-now')
  } catch (error) {
    if (!(error instanceof InstallerChoiceBackError)) throw error
    choice = 'not-now'
  }
  if (choice !== 'install') {
    ports.tui.addAssistant('Update declined. Nothing was installed; you can keep using this concierge.')
    return
  }

  ports.tui.setProgress('Installing the Dear Machine update')
  let installed: UpdateInstallResult
  try { installed = await ports.updater.install() } catch { installed = { state: 'failed' } }
  finally { ports.tui.setProgress(undefined) }
  if (installed.state === 'unsupported') {
    ports.tui.addAssistant('This installation channel does not support managed updates. Nothing was changed; you can keep using this concierge.')
    return
  }
  if (installed.state === 'failed') {
    ports.tui.addAssistant('The update could not finish. You can keep using this concierge. Run dearmachine status to check Dear Machine; if it reports an interrupted update, run dearmachine update --recover before trying again.')
    return
  }

  ports.tui.addAssistant(`Update installed successfully (release ${installed.release}). Reopen the concierge to use the new version.`)
  let relaunch: string
  try {
    relaunch = await ports.tui.choose('Open the updated concierge now?', [
      { value: 'relaunch', label: 'Reopen now', description: 'Continue with the updated concierge' },
      { value: 'close', label: 'Close for now', description: 'Open dearmachine yourself later' },
    ], 'relaunch')
  } catch (error) {
    if (!(error instanceof InstallerChoiceBackError)) throw error
    relaunch = 'close'
  }
  if (relaunch === 'relaunch') await ports.relaunch()
  else await ports.close()
}

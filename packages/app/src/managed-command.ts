import { spawn } from 'node:child_process'
import { ManagedNix, UnsupportedManagedInstallationError, launcherGuidance } from '@dearmachine/machtiani-installer-products'

function writeJSON(value: object): void {
  process.stdout.write(`${JSON.stringify({ version: 1, ...value })}\n`)
}

export async function runManagedCommand(action: 'install' | 'update' | 'migrate-profile' | '_launcher-check', args: string[], callerPath = process.env.PATH ?? ''): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: machtiani-installer install --source-root <absolute-checkout>\n       dearmachine update [--check | --recover] [--json]\n       machtiani-installer migrate-profile <entry> [--check]\n')
    return
  }
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required')
  const reportLaunchers = async () => {
    for (const message of await launcherGuidance(home, callerPath)) process.stderr.write(message + '\n')
  }
  if (action === '_launcher-check') {
    if (args.length) throw new Error('_launcher-check takes no arguments')
    await reportLaunchers(); return
  }

  if (process.platform === 'win32' && process.env.MACHTIANI_DISTRIBUTION && action === 'update') {
    const native = process.env.DEARMACHINE_NATIVE_BIN
    if (!native) throw new Error('Run update through the installed Windows launcher')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(native, ['update', ...args], { stdio: 'inherit', windowsHide: true })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Windows update exited with status ${code}`)))
    })
    return
  }

  const json = action === 'update' && args.includes('--json')
  const updateArgs = json ? args.filter(argument => argument !== '--json') : args
  const operation = updateArgs.length === 1 && updateArgs[0] === '--check' ? 'check'
    : updateArgs.length === 0 ? 'install' : undefined
  if (json && operation === undefined) throw new Error('Usage: dearmachine update [--check | --recover] [--json]')
  if (process.env.MACHTIANI_DISTRIBUTION) {
    if (json && operation !== undefined) { writeJSON({ operation, state: 'unsupported' }); return }
    throw new Error('Standard releases cannot be changed by the Nix updater')
  }

  const dataHome = process.env.DEARMACHINE_MANAGED_DATA_HOME || process.env.XDG_DATA_HOME
  const manager = new ManagedNix({ home, ...(dataHome ? { dataHome } : {}),
    progress: text => process.stderr.write(text + '\n') })
  try {
    if (action === 'migrate-profile') {
      if (!args[0] || args.length > 2 || (args.length === 2 && args[1] !== '--check')) throw new Error('Usage: machtiani-installer migrate-profile <entry> [--check]')
      const result = await manager.migrateProfile(args[0], args[1] === '--check')
      process.stdout.write(`${result.backup ? 'Removed' : 'Would remove'} Nix profile entry ${result.entry}: ${result.commands.join(', ')}.\n`)
      if (result.backup) process.stdout.write(`Backup: ${result.backup}\nPrevious profile generation: ${result.generation}. Existing shells may need their command cache refreshed.\n`)
      await reportLaunchers()
      return
    }
    if (action === 'install') {
      if (args.length !== 2 || args[0] !== '--source-root' || !args[1]?.startsWith('/')) throw new Error('install requires --source-root <absolute-checkout>')
      const release = await manager.install(args[1])
      process.stdout.write(`Installed coordinated release ${release.revision}.\nSource: ${release.sourceRoot}\n`)
      await reportLaunchers()
    } else if (updateArgs.length === 1 && updateArgs[0] === '--check') {
      const result = await manager.check()
      if (json) writeJSON({ operation: 'check', state: result.status, current: result.current, available: result.available })
      else process.stdout.write(`Installed: ${result.current}\nAvailable: ${result.available}\nStatus: ${result.status}\n`)
    } else if (updateArgs.length === 1 && updateArgs[0] === '--recover') {
      await manager.recover()
      process.stdout.write('Restored the previous installation.\n')
    } else if (updateArgs.length === 0) {
      // Native/package wrappers prepend runtime paths before this handoff. They
      // cannot establish which installation the user's shell would select.
      const release = await manager.update()
      if (json) writeJSON({ operation: 'install', state: 'installed', release: release.revision })
      else process.stdout.write(`Active release: ${release.revision}\nSource: ${release.sourceRoot}\nReopen the concierge to use its updated runtime and documentation.\n`)
    } else throw new Error('Usage: dearmachine update [--check | --recover] [--json]')
  } catch (error) {
    if (!json || operation === undefined) throw error
    if (error instanceof UnsupportedManagedInstallationError) writeJSON({ operation, state: 'unsupported' })
    else {
      writeJSON({ operation, state: 'failed' })
      process.exitCode = 1
    }
  }
}

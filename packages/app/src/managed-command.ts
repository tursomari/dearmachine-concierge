import { ManagedNix, launcherGuidance } from '@dearmachine/machtiani-installer-products'

export async function runManagedCommand(action: 'install' | 'update' | 'migrate-profile' | '_launcher-check', args: string[], callerPath = process.env.PATH ?? ''): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: machtiani-installer install --source-root <absolute-checkout>\n       dearmachine update [--check | --recover]\n       machtiani-installer migrate-profile <entry> [--check]\n')
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
  if (process.env.MACHTIANI_DISTRIBUTION) throw new Error('Standard releases use their own release channel; the Nix updater cannot change them')
  const dataHome = process.env.DEARMACHINE_MANAGED_DATA_HOME || process.env.XDG_DATA_HOME
  const manager = new ManagedNix({ home, ...(dataHome ? { dataHome } : {}),
    progress: text => process.stderr.write(text + '\n') })
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
  } else if (args.length === 1 && args[0] === '--check') {
    const result = await manager.check()
    process.stdout.write(`Installed: ${result.current}\nAvailable: ${result.available}\nStatus: ${result.status}\n`)
  } else if (args.length === 1 && args[0] === '--recover') {
    await manager.recover()
    process.stdout.write('Restored the previous installation.\n')
  } else if (args.length === 0) {
    const release = await manager.update()
    process.stdout.write(`Active release: ${release.revision}\nSource: ${release.sourceRoot}\nReopen the concierge to use its updated runtime and documentation.\n`)
    await reportLaunchers()
  } else throw new Error('Usage: dearmachine update [--check | --recover]')
}

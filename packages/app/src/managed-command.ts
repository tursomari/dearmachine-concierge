import { ManagedNix } from '@dearmachine/machtiani-installer-products'

export async function runManagedCommand(action: 'install' | 'update', args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: machtiani-installer install --source-root <absolute-checkout>\n       dearmachine update [--check | --recover]\n')
    return
  }
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required')
  if (process.env.MACHTIANI_DISTRIBUTION) throw new Error('Standard releases use their own release channel; the Nix updater cannot change them')
  const dataHome = process.env.DEARMACHINE_MANAGED_DATA_HOME || process.env.XDG_DATA_HOME
  const manager = new ManagedNix({ home, ...(dataHome ? { dataHome } : {}),
    ...(process.env.ZDOTDIR ? { zshDirectory: process.env.ZDOTDIR } : {}),
    progress: text => process.stderr.write(text + '\n') })
  if (action === 'install') {
    if (args.length !== 2 || args[0] !== '--source-root' || !args[1]?.startsWith('/')) throw new Error('install requires --source-root <absolute-checkout>')
    const release = await manager.install(args[1])
    process.stdout.write(`Installed coordinated release ${release.revision}.\nSource: ${release.sourceRoot}\nOpen a new terminal to use the managed commands; existing shells retain their old PATH and command cache.\n`)
  } else if (args.length === 1 && args[0] === '--check') {
    const result = await manager.check()
    process.stdout.write(`Installed: ${result.current}\nAvailable: ${result.available}\nStatus: ${result.status}\n`)
  } else if (args.length === 1 && args[0] === '--recover') {
    await manager.recover()
    process.stdout.write('Recovered the interrupted installation or shell setup.\n')
  } else if (args.length === 0) {
    const release = await manager.update()
    process.stdout.write(`Active release: ${release.revision}\nSource: ${release.sourceRoot}\nOpen a new terminal to refresh command lookup. Reopen the concierge to use its updated runtime and documentation.\n`)
  } else throw new Error('Usage: dearmachine update [--check | --recover]')
}

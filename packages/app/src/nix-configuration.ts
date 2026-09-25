import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { InstallerChoiceBackError, type InstallerTui } from '@dearmachine/machtiani-installer-tui'
import { checkNixPrerequisites, NixFeaturesMissing } from './nix-prerequisites.ts'

class NixConfigurationError extends Error {}

export function nixUserConfiguration(home: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.NIX_USER_CONF_FILES !== undefined) {
    throw new NixConfigurationError('NIX_USER_CONF_FILES selects custom Nix configuration files. Enable nix-command and flakes in that configuration, then choose Check again. No file was changed.')
  }
  const root = environment.XDG_CONFIG_HOME || join(home, '.config')
  if (!isAbsolute(root)) throw new NixConfigurationError('The Nix configuration directory must be an absolute path. Correct XDG_CONFIG_HOME, then choose Check again.')
  return join(root, 'nix', 'nix.conf')
}

/** Append to Nix's additive setting; preserve includes, comments and private values. */
export async function saveNixFeatures(path: string, missing: readonly string[]): Promise<{ backup?: string; changed: boolean }> {
  if (missing.some(feature => !['nix-command', 'flakes'].includes(feature))) throw new NixConfigurationError('Unexpected Nix feature; no file was changed.')
  let temporary: string | undefined
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const before = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    })
    if (before && (!before.isFile() || before.isSymbolicLink() || before.size > 1_048_576 ||
      (process.getuid && before.uid !== process.getuid()))) {
      throw new NixConfigurationError('The Nix configuration is not an ordinary file owned by you. Edit it through its existing configuration manager, then choose Check again. No file was changed.')
    }
    let original = ''
    if (before) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const current = await handle.stat()
        if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev) throw new NixConfigurationError('The Nix configuration changed during inspection. Choose Check again.')
        original = await handle.readFile('utf8')
      } finally { await handle.close() }
    }
    // Multiple additive entries are valid Nix syntax. Never rewrite existing ones.
    const already = new Set<string>()
    for (const line of original.split(/\r?\n/u)) {
      if (/^\s*(?:experimental-features\s*=|!?include\s)/u.test(line)) already.clear()
      const match = /^\s*extra-experimental-features\s*=\s*([^#]*)/u.exec(line)
      if (match) for (const feature of match[1]!.trim().split(/\s+/u)) already.add(feature)
    }
    const additions = [...new Set(missing)].filter(feature => !already.has(feature))
    if (!additions.length) return { changed: false }
    const ending = original.includes('\r\n') ? '\r\n' : '\n'
    const updated = original + (original && !original.endsWith('\n') ? ending : '') +
      `extra-experimental-features = ${additions.join(' ')}${ending}`
    const backup = before ? `${path}.dearmachine-backup-${randomUUID()}` : undefined
    if (backup) await writeFile(backup, original, { flag: 'wx', mode: 0o600 })
    temporary = `${path}.dearmachine-${randomUUID()}.tmp`
    await writeFile(temporary, updated, { flag: 'wx', mode: before ? before.mode & 0o777 : 0o600 })
    const current = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    })
    if (before ? !current?.isFile() || current.ino !== before.ino || current.dev !== before.dev ||
      await readFile(path, 'utf8') !== original : current !== undefined) {
      throw new NixConfigurationError('The Nix configuration changed while preparing the update. Choose Check again; the newer configuration was preserved.')
    }
    await rename(temporary, path)
    temporary = undefined
    return { ...(backup ? { backup } : {}), changed: true }
  } catch (error) {
    if (error instanceof NixConfigurationError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new NixConfigurationError('Could not save Nix settings: the configuration file or directory is not writable. Correct its permissions or edit it through its configuration manager, then choose Check again.')
    }
    if (code === 'ENOSPC' || code === 'EDQUOT') throw new NixConfigurationError('Could not save Nix settings: there is not enough disk space. Free some space, then retry.')
    throw new NixConfigurationError('Could not safely save Nix settings. Check the configuration file and directory, then retry. Existing settings were preserved.')
  } finally { if (temporary) await unlink(temporary).catch(() => {}) }
}

/** Keep repair/retry inside the selected Nix route instead of repeating its menu. */
export async function prepareNixConfiguration(
  tui: Pick<InstallerTui, 'choose' | 'addAssistant'>,
  options: { home: string; exited: Promise<void>; environment?: NodeJS.ProcessEnv;
    check?: typeof checkNixPrerequisites; save?: typeof saveNixFeatures },
): Promise<void | 'back'> {
  const check = options.check ?? checkNixPrerequisites
  let closed = false
  void options.exited.then(() => { closed = true })
  while (!closed) {
    let missing: readonly string[] = ['nix-command', 'flakes']
    let absent = false
    let repairable = true
    try {
      if (await check() === 'ready') return
      absent = true
    } catch (error) {
      if (error instanceof NixFeaturesMissing) missing = error.missing
      else { repairable = false; tui.addAssistant(error instanceof Error ? error.message : 'Could not inspect Nix. Check the installation, then retry.') }
    }
    let path: string | undefined
    if (repairable) {
      try { path = nixUserConfiguration(options.home, options.environment) }
      catch (error) { tui.addAssistant((error as Error).message) }
      if (path) tui.addAssistant(`${absent ? 'Nix setup needs' : 'Nix is installed but needs'} nix-command and flakes enabled for Dear Machine. Save the required settings in ${path}? Existing settings will be preserved, with a backup if the file already exists.`)
    }
    if (closed) return 'back'
    let choice: string | undefined
    try {
      choice = await Promise.race([
        tui.choose('Finish Nix setup', [
          ...(path ? [{ value: 'enable', label: 'Enable required Nix features and continue', description: 'Save the settings for future sessions.' }] : []),
          { value: 'retry', label: 'Check again', description: 'Retry after fixing Nix settings yourself.' },
          { value: 'back', label: 'Back', description: 'Return without changing Nix settings.' },
        ], path ? 'enable' : 'retry'),
        options.exited.then(() => undefined),
      ])
    } catch (error) { if (error instanceof InstallerChoiceBackError) return 'back'; throw error }
    if (closed || choice === undefined || choice === 'back') return 'back'
    if (choice !== 'enable' || !path) continue
    try {
      const result = await (options.save ?? saveNixFeatures)(path, missing)
      if (result.backup) tui.addAssistant(`Previous Nix settings: ${result.backup}`)
      if (closed) return 'back'
      const verified = await check() // A fresh process, with no feature flags overriding saved settings.
      if (verified === 'absent') {
        tui.addAssistant('Required Nix settings are saved for future sessions. Guided setup will install Nix and verify them.')
      } else tui.addAssistant('Nix features are enabled and verified. Continuing setup.')
      return
    } catch (error) {
      tui.addAssistant(error instanceof NixFeaturesMissing
        ? 'Nix still reports missing features. Check whether NIX_CONFIG or an included configuration overrides them, then choose Check again. Your saved settings were retained.'
        : error instanceof Error ? error.message : 'Could not finish Nix setup. Correct the configuration and retry.')
    }
  }
  return 'back'
}

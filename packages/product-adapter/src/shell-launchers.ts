import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

const begin = '# >>> DearMachine managed PATH >>>'
const end = '# <<< DearMachine managed PATH <<<'
const block = `${begin}\n# Keep managed commands ahead of older Nix profile packages.\ncase "\${PATH-}" in\n  "$HOME/.local/bin"|"$HOME/.local/bin":*) ;;\n  *) export PATH="$HOME/.local/bin\${PATH:+:$PATH}" ;;\nesac\n${end}\n`
interface ShellFile { path: string; before: string | null; after: string; mode: number }
interface ShellJournal { version: 1; files: ShellFile[] }
export interface ShellOptions { home: string; root: string; zshDirectory?: string }

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function directory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Shell configuration directory must be absolute')
  if (path !== dirname(path)) await directory(dirname(path))
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== process.getuid?.() && info.uid !== 0) || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) throw new Error('Unsafe shell configuration directory')
}
async function contents(path: string): Promise<{ text: string | null; mode: number }> {
  if (!await exists(path)) return { text: null, mode: 0o600 }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || info.size > 65536) throw new Error(`Cannot safely edit ${path}; configure $HOME/.local/bin first in this shell's PATH manually`)
  return { text: await readFile(path, 'utf8'), mode: info.mode & 0o777 }
}
function updated(text: string): string {
  const start = text.indexOf(begin), finish = text.indexOf(end)
  if (start !== -1 || finish !== -1) {
    if (start === -1 || finish < start || text.indexOf(begin, start + begin.length) !== -1 || text.indexOf(end, finish + end.length) !== -1) throw new Error('Ambiguous DearMachine PATH markers; inspect the startup file before retrying')
    // Preserve all user content while moving our one block after later initializers.
    text = text.slice(0, start) + text.slice(finish + end.length).replace(/^\r?\n/u, '')
  }
  return text.replace(/\s*$/u, '') + (text.trim() ? '\n\n' : '') + block
}
async function atomic(path: string, text: string, mode: number): Promise<void> {
  await directory(dirname(path))
  const temporary = `${path}.dearmachine-${randomUUID()}.tmp`
  try { await writeFile(temporary, text, { mode, flag: 'wx' }); await chmod(temporary, mode); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
async function restore(files: ShellFile[]): Promise<void> {
  for (const file of [...files].reverse()) {
    const current = await contents(file.path)
    if (current.text === file.before) continue
    if (current.text !== file.after) throw new Error('A shell startup file changed outside this operation; preserve it and inspect the shell recovery journal')
    if (file.before === null) await rm(file.path)
    else await atomic(file.path, file.before, file.mode)
  }
}
function validate(journal: ShellJournal, options: ShellOptions): void {
  if (!journal || journal.version !== 1 || !Array.isArray(journal.files) || journal.files.length > 4) throw new Error('Invalid shell recovery journal')
  const allowed = new Set(['.bashrc', '.bash_profile', '.bash_login', '.profile'].map(name => join(options.home, name)))
  // The recorded ZDOTDIR may differ from the environment in a recovery shell.
  const seen = new Set<string>()
  for (const file of journal.files) {
    const zsh = ['.zshrc', '.zlogin'].some(name => file.path === join(options.zshDirectory ?? options.home, name))
    if ((!allowed.has(file.path) && !zsh) || seen.has(file.path) || (file.before !== null && typeof file.before !== 'string') || typeof file.after !== 'string' || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error('Invalid shell recovery path or contents; use the original ZDOTDIR when recovering')
    seen.add(file.path)
  }
}
export async function recoverShellLaunchers(options: ShellOptions): Promise<boolean> {
  const path = join(options.root, 'shell-transaction.json')
  if (!await exists(path)) return false
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1048576) throw new Error('Unsafe shell recovery journal')
  const journal = JSON.parse(await readFile(path, 'utf8')) as ShellJournal
  validate(journal, options)
  await restore(journal.files)
  await rm(path)
  return true
}
export async function configureShellLaunchers(options: ShellOptions): Promise<void> {
  const journalPath = join(options.root, 'shell-transaction.json')
  if (await exists(journalPath)) throw new Error('Interrupted shell setup needs dearmachine update --recover')
  const zsh = options.zshDirectory ?? options.home
  if (!isAbsolute(zsh)) throw new Error('ZDOTDIR must be absolute for managed shell setup')
  const login = await exists(join(options.home, '.bash_profile')) ? '.bash_profile' : await exists(join(options.home, '.bash_login')) ? '.bash_login' : '.profile'
  const paths = [join(options.home, '.bashrc'), join(options.home, login), join(zsh, '.zshrc'), join(zsh, '.zlogin')]
  const files: ShellFile[] = []
  for (const path of paths) {
    await directory(dirname(path))
    const current = await contents(path)
    const after = updated(current.text ?? '')
    if (after !== current.text) files.push({ path, before: current.text, after, mode: current.mode })
  }
  if (!files.length) return
  const journal: ShellJournal = { version: 1, files }
  validate(journal, options)
  const serialized = JSON.stringify(journal, null, 2) + '\n'
  // Private, durable originals are retained even after a successful setup.
  await atomic(join(options.root, 'shell-backups', `${randomUUID()}.json`), serialized, 0o600)
  await atomic(journalPath, serialized, 0o600)
  try {
    for (const file of files) {
      if ((await contents(file.path)).text !== file.before) throw new Error('Shell startup file changed during setup')
      await atomic(file.path, file.after, file.mode)
    }
  } catch (error) { await restore(files); await rm(journalPath); throw error }
  await rm(journalPath)
}

import { constants } from 'node:fs'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'

const begin = '# >>> Dear Machine PATH >>>'
const end = '# <<< Dear Machine PATH <<<'
const posix = [
  begin,
  'case ":$PATH:" in',
  '  *":$HOME/.local/bin:"*) ;;',
  '  ::) export PATH="$HOME/.local/bin" ;;',
  '  *) export PATH="$PATH:$HOME/.local/bin" ;;',
  'esac',
  end,
].join('\n')
const fish = [
  begin,
  'if not contains -- "$HOME/.local/bin" $PATH',
  '    set -gx PATH $PATH "$HOME/.local/bin"',
  'end',
  end,
].join('\n')

export interface ShellPathResult {
  files: string[]
  backups: string[]
  currentShellCommand: string
}

/** Configure future shells; a child process cannot change its parent shell's PATH. */
export async function configureShellPath(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ShellPathResult> {
  if (platform === 'win32') throw new Error('Windows PATH is configured by the native Windows installer.')
  if (!isAbsolute(home) || /[:\r\n\0]/u.test(home)) throw new Error('PATH setup requires an absolute HOME without colons or newlines.')
  const shell = basename(environment.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'))
  let files: string[]
  if (shell === 'zsh') {
    const directory = environment.ZDOTDIR || home
    if (!isAbsolute(directory)) throw new Error('PATH setup requires an absolute ZDOTDIR.')
    files = [join(directory, '.zprofile'), join(directory, '.zshrc')]
  } else if (shell === 'bash') {
    // Bash reads only the first existing login file, plus .bashrc for non-login terminals.
    const candidates = ['.bash_profile', '.bash_login', '.profile'].map(name => join(home, name))
    let login = join(home, '.profile')
    for (const path of candidates) {
      try { await stat(path); login = path; break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    files = [login, join(home, '.bashrc')]
  } else if (shell === 'fish') {
    const config = environment.XDG_CONFIG_HOME || join(home, '.config')
    if (!isAbsolute(config)) throw new Error('PATH setup requires an absolute XDG_CONFIG_HOME.')
    files = [join(config, 'fish', 'conf.d', 'dearmachine-path.fish')]
  } else if (['sh', 'dash', 'ksh'].includes(shell)) {
    files = [join(home, '.profile')]
  } else {
    throw new Error('Automatic PATH setup does not support ' + shell + '. Add $HOME/.local/bin to that shell’s PATH.')
  }
  const block = shell === 'fish' ? fish : posix
  const result: ShellPathResult = {
    files, backups: [],
    currentShellCommand: shell === 'fish'
      ? 'set -gx PATH $PATH "$HOME/.local/bin"'
      : 'export PATH="$PATH:$HOME/.local/bin"',
  }
  for (const path of files) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // Do not replace linked/read-only dotfiles (for example, a managed Nix configuration).
    const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error('Shell configuration must be an owned regular file: ' + path)
      const previous = await handle.readFile('utf8')
      if (previous.includes(block)) continue
      if (previous.includes(begin) || previous.includes(end)) throw new Error('The Dear Machine PATH block was customized; inspect ' + path)
      if (previous) {
        const backup = path + '.dearmachine-backup-' + randomUUID()
        await writeFile(backup, previous, { flag: 'wx', mode: info.mode & 0o777 })
        result.backups.push(backup)
      }
      await handle.writeFile((previous && !previous.endsWith('\n') ? '\n' : '') + '\n' + block + '\n')
    } finally { await handle.close() }
  }
  return result
}

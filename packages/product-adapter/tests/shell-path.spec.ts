import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configureShellPath } from '../src/shell-path.ts'

const exec = promisify(execFile)
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "shell path ' space-"))
  homes.push(home)
  await mkdir(join(home, '.local/bin'), { recursive: true })
  await writeFile(join(home, '.local/bin/dearmachine'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  return home
}

it('preserves bash settings and precedence, creates a backup, and configures an independent terminal', async () => {
  const home = await fixture()
  const original = 'export PATH="/custom/bin:$PATH"\nexport KEEP_SETTING=yes'
  await writeFile(join(home, '.bash_profile'), original)
  await writeFile(join(home, '.bashrc'), original)
  const result = await configureShellPath(home, { SHELL: '/bin/bash' }, 'linux')
  expect(result.files).toEqual([join(home, '.bash_profile'), join(home, '.bashrc')])
  expect(await readFile(result.backups[0]!, 'utf8')).toBe(original)
  const run = await exec('/bin/bash', ['--noprofile', '--rcfile', join(home, '.bashrc'), '-ic',
    'command -v dearmachine; printf "%s\\n" "$KEEP_SETTING" "$PATH"'], {
    env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
  })
  const lines = run.stdout.trimEnd().split('\n').slice(-3)
  expect(lines.slice(0, 2)).toEqual([join(home, '.local/bin/dearmachine'), 'yes'])
  const entries = lines[2]!.split(':')
  expect(entries[0]).toBe('/custom/bin')
  expect(entries.at(-1)).toBe(join(home, '.local/bin'))
  expect(entries.indexOf('/usr/bin')).toBeLessThan(entries.indexOf('/bin'))
  expect(entries.filter(entry => entry === join(home, '.local/bin'))).toHaveLength(1)
  const before = await readFile(join(home, '.bashrc'), 'utf8')
  expect((await configureShellPath(home, { SHELL: '/bin/bash' }, 'linux')).backups).toEqual([])
  expect(await readFile(join(home, '.bashrc'), 'utf8')).toBe(before)
  expect((await readdir(home)).filter(name => name.includes('backup-'))).toHaveLength(2)
})

it('honors the first existing bash login file without shadowing it', async () => {
  const home = await fixture()
  await writeFile(join(home, '.bash_login'), '# login customization\n')
  await writeFile(join(home, '.profile'), '# ignored by bash\n')
  const result = await configureShellPath(home, { SHELL: '/bin/bash' }, 'linux')
  expect(result.files[0]).toBe(join(home, '.bash_login'))
  expect(await readFile(join(home, '.profile'), 'utf8')).toBe('# ignored by bash\n')
  expect(existsSync(join(home, '.bash_profile'))).toBe(false)
})

it('honors zsh and fish configuration directories', async () => {
  const home = await fixture()
  const zdir = join(home, 'zsh config')
  expect((await configureShellPath(home, { SHELL: '/bin/zsh', ZDOTDIR: zdir }, 'darwin')).files)
    .toEqual([join(zdir, '.zprofile'), join(zdir, '.zshrc')])
  const config = join(home, 'config')
  const fish = await configureShellPath(home, { SHELL: '/usr/bin/fish', XDG_CONFIG_HOME: config }, 'linux')
  expect(fish.files).toEqual([join(config, 'fish/conf.d/dearmachine-path.fish')])
})

it.skipIf(!existsSync('/bin/zsh'))('makes dearmachine available in fresh macOS login and interactive zsh shells', async () => {
  const home = await fixture()
  await configureShellPath(home, { SHELL: '/bin/zsh' }, 'darwin')
  for (const mode of ['-lic', '-ic']) {
    const result = await exec('/bin/zsh', [mode, 'command -v dearmachine; print -l $path'], {
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' },
    })
    expect(result.stdout.split('\n')[0]).toBe(join(home, '.local/bin/dearmachine'))
    expect(result.stdout.split('\n').filter(line => line === join(home, '.local/bin'))).toHaveLength(1)
  }
})

it('does not modify linked dotfiles or a customized managed block', async () => {
  const home = await fixture()
  const target = join(home, 'managed-profile')
  await writeFile(target, '# user managed\n')
  await symlink(target, join(home, '.profile'))
  await expect(configureShellPath(home, { SHELL: '/bin/sh' }, 'linux')).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe('# user managed\n')
  await rm(join(home, '.profile'))
  const customized = '# >>> Dear Machine PATH >>>\n# customized\n# <<< Dear Machine PATH <<<\n'
  await writeFile(join(home, '.profile'), customized)
  await expect(configureShellPath(home, { SHELL: '/bin/sh' }, 'linux')).rejects.toThrow('customized')
  expect(await readFile(join(home, '.profile'), 'utf8')).toBe(customized)
})

it('rejects unsupported shells without inventing a startup file', async () => {
  const home = await fixture()
  await expect(configureShellPath(home, { SHELL: '/bin/csh' }, 'darwin')).rejects.toThrow('does not support')
  expect(await readdir(home)).toEqual(['.local'])
})

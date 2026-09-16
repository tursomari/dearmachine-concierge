import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ManagedNix } from '../src/managed-nix.ts'

const exec = promisify(execFile)

it('resolves an HTTPS release identity through an isolated local Git origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-origin-'))
  try {
    const home = join(root, 'home'), source = join(root, 'source'), origin = join(root, 'origin.git')
    await mkdir(home)
    await mkdir(source)
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') }
    const git = async (...args: string[]) => (await exec('git', args, { cwd: source, env })).stdout.trim()
    await git('init', '--quiet', '--initial-branch=main')
    await writeFile(join(source, 'tracked'), 'fixture\n')
    await git('add', 'tracked')
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture')
    await git('clone', '--quiet', '--bare', source, origin)
    await git('config', '--global', 'protocol.allow', 'never')
    await git('config', '--global', 'protocol.file.allow', 'always')
    await git('config', '--global', `url.file://${origin}.insteadOf`, 'https://qse.invalid/umbrella.git')
    await git('remote', 'add', 'origin', 'https://qse.invalid/umbrella.git')
    expect(await git('remote', 'get-url', 'origin')).toBe(`file://${origin}`)
    const managed = new ManagedNix({ home, run: async (command, args, cwd) =>
      (await exec(command, args, { cwd, env })).stdout })
    // Getting to recursive source validation proves both remote validation and
    // a real offline ls-remote succeeded; this tiny fixture has no components.
    await expect(managed.install(source)).rejects.toThrow('Missing pinned component: dearmachine')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

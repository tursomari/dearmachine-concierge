import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadSourceReference, resolveSourceReference, saveSourceReference } from '../src/source-reference.ts'

const exec = promisify(execFile)

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'machtiani-source-reference-'))
  await mkdir(join(root, 'docs'))
  await Promise.all([
    mkdir(join(root, 'machtiani-harness')),
    mkdir(join(root, 'dearmachine')),
  ])
  await writeFile(join(root, 'docs', 'README.md'), '# Documentation\n')
  await exec('git', ['init', '-q', root])
  await exec('git', ['-C', root, 'add', 'docs/README.md'])
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture'])
  return root
}

describe('versioned source reference', () => {
  it('reads a loose branch revision without requiring a Git executable', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'machtiani-source-metadata-'))
    const revision = '0123456789abcdef0123456789abcdef01234567'
    await mkdir(join(sourceRoot, 'docs'), { recursive: true })
    await mkdir(join(sourceRoot, '.git', 'refs', 'heads'), { recursive: true })
    await writeFile(join(sourceRoot, 'docs', 'README.md'), '# Documentation\n')
    await writeFile(join(sourceRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(sourceRoot, '.git', 'refs', 'heads', 'main'), `${revision}\n`)

    await expect(resolveSourceReference(sourceRoot)).resolves.toMatchObject({ umbrellaRevision: revision })
  })

  it('reads packed refs and linked-worktree metadata without invoking Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-source-worktree-'))
    const sourceRoot = join(root, 'checkout')
    const common = join(root, 'repository.git')
    const gitDirectory = join(common, 'worktrees', 'checkout')
    const revision = 'abcdef0123456789abcdef0123456789abcdef01'
    await mkdir(join(sourceRoot, 'docs'), { recursive: true })
    await mkdir(gitDirectory, { recursive: true })
    await writeFile(join(sourceRoot, 'docs', 'README.md'), '# Documentation\n')
    await writeFile(join(sourceRoot, '.git'), `gitdir: ${relative(sourceRoot, gitDirectory)}\n`)
    await writeFile(join(gitDirectory, 'commondir'), '../..\n')
    await writeFile(join(gitDirectory, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(common, 'packed-refs'), `# pack-refs with: peeled fully-peeled\n${revision} refs/heads/main\n`)

    await expect(resolveSourceReference(sourceRoot)).resolves.toMatchObject({ umbrellaRevision: revision })
  })

  it('records and reloads the canonical documentation path and umbrella revision privately', async () => {
    const sourceRoot = await sourceFixture()
    const home = await mkdtemp(join(tmpdir(), 'machtiani-reference-home-'))
    const reference = await resolveSourceReference(sourceRoot)

    const path = await saveSourceReference(home, reference)

    expect(path).toBe(join(home, '.config', 'dearmachine', 'source-reference.json'))
    expect((await stat(path)).mode & 0o077).toBe(0)
    expect(await loadSourceReference(home)).toEqual(reference)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(reference)
  })

  it('rejects a retained reference after the source revision moves', async () => {
    const sourceRoot = await sourceFixture()
    const home = await mkdtemp(join(tmpdir(), 'machtiani-reference-home-'))
    await saveSourceReference(home, await resolveSourceReference(sourceRoot))
    await writeFile(join(sourceRoot, 'docs', 'README.md'), '# Changed documentation\n')
    await exec('git', ['-C', sourceRoot, 'add', 'docs/README.md'])
    await exec('git', ['-C', sourceRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'change'])

    await expect(loadSourceReference(home)).rejects.toThrow('revision')
  })
})

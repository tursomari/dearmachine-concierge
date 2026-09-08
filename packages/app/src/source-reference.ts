import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface SourceReference {
  version: 1
  sourceRoot: string
  documentationEntryPoint: string
  umbrellaRevision: string
}

export function sourceReferencePath(home: string): string {
  return join(home, '.config', 'dearmachine', 'source-reference.json')
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function repositoryDirectories(sourceRoot: string): Promise<{ git: string; common: string }> {
  const dotGit = join(sourceRoot, '.git')
  const metadata = await lstat(dotGit)
  let git: string
  if (metadata.isDirectory()) git = await realpath(dotGit)
  else {
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('the umbrella Git metadata is invalid')
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readFile(dotGit, 'utf8'))
    if (match?.[1] === undefined) throw new Error('the umbrella Git directory reference is invalid')
    git = await realpath(resolve(dirname(dotGit), match[1]))
  }
  const commonReference = (await optionalText(join(git, 'commondir')))?.trim()
  const common = commonReference === undefined ? git : await realpath(resolve(git, commonReference))
  return { git, common }
}

function validRevision(value: string): boolean {
  return /^[0-9a-f]{40,64}$/u.test(value)
}

function validReference(value: string): boolean {
  return value.startsWith('refs/') && !value.includes('\\') &&
    value.split('/').every(component => component !== '' && component !== '.' && component !== '..')
}

async function resolveRepositoryRevision(sourceRoot: string): Promise<string> {
  // Release archives deliberately contain no Git administration or history.
  // Only a missing .git permits the explicit, package-generated provenance file.
  try { await lstat(join(sourceRoot, '.git')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const path = join(sourceRoot, 'bootstrap-source-revisions.json')
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error('invalid release revision metadata')
    const revision = (JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)['.']
    if (typeof revision !== 'string' || !validRevision(revision)) throw new Error('invalid release source revision')
    return revision
  }
  const directories = await repositoryDirectories(sourceRoot)
  const head = (await readFile(join(directories.git, 'HEAD'), 'utf8')).trim()
  if (validRevision(head)) return head
  const symbolic = /^ref: (refs\/[^\r\n]+)$/u.exec(head)?.[1]
  if (symbolic === undefined || !validReference(symbolic)) throw new Error('the umbrella Git HEAD is invalid')
  for (const directory of new Set([directories.git, directories.common])) {
    const loose = (await optionalText(join(directory, ...symbolic.split('/'))))?.trim()
    if (loose !== undefined) {
      if (!validRevision(loose)) throw new Error('the umbrella source revision is invalid')
      return loose
    }
  }
  for (const directory of new Set([directories.git, directories.common])) {
    const packed = await optionalText(join(directory, 'packed-refs'))
    if (packed === undefined) continue
    for (const line of packed.split(/\r?\n/gu)) {
      const match = /^([0-9a-f]{40,64}) ([^\s]+)$/u.exec(line)
      if (match?.[2] === symbolic && match[1] !== undefined) return match[1]
    }
  }
  throw new Error('the umbrella source revision could not be resolved from Git metadata')
}

export async function resolveSourceReference(sourceRoot: string): Promise<SourceReference> {
  if (!isAbsolute(sourceRoot)) throw new Error('the source reference root must be absolute')
  const root = await realpath(sourceRoot)
  const documentationEntryPoint = join(root, 'docs', 'README.md')
  const metadata = await lstat(documentationEntryPoint)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('the canonical documentation entry point must be a regular file')
  const umbrellaRevision = await resolveRepositoryRevision(root)
  return { version: 1, sourceRoot: root, documentationEntryPoint, umbrellaRevision }
}

export async function saveSourceReference(home: string, reference: SourceReference): Promise<string> {
  const path = sourceReferencePath(home)
  await mkdir(join(home, '.config', 'dearmachine'), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(reference, undefined, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  return path
}

export async function loadSourceReference(home: string): Promise<SourceReference | undefined> {
  const path = sourceReferencePath(home)
  let metadata
  try { metadata = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const owned = process.getuid === undefined || metadata.uid === process.getuid()
  if (!metadata.isFile() || metadata.isSymbolicLink() || !owned || (metadata.mode & 0o077) !== 0 || metadata.size > 16_384) {
    throw new Error('the retained source reference must be a small private regular file owned by the current user')
  }
  const value = JSON.parse(await readFile(path, 'utf8')) as Partial<SourceReference>
  if (value.version !== 1 || typeof value.sourceRoot !== 'string' || typeof value.documentationEntryPoint !== 'string' ||
    typeof value.umbrellaRevision !== 'string') throw new Error('the retained source reference is invalid')
  const current = await resolveSourceReference(value.sourceRoot)
  if (current.documentationEntryPoint !== value.documentationEntryPoint || current.umbrellaRevision !== value.umbrellaRevision) {
    throw new Error('the retained source reference no longer matches its documentation path or revision')
  }
  return current
}

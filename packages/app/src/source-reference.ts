import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface SourceReference {
  version: 1
  sourceRoot: string
  documentationEntryPoint: string
  umbrellaRevision: string
}

export function sourceReferencePath(home: string): string {
  return join(home, '.config', 'dearmachine', 'source-reference.json')
}

export async function resolveSourceReference(sourceRoot: string): Promise<SourceReference> {
  if (!isAbsolute(sourceRoot)) throw new Error('the source reference root must be absolute')
  const root = await realpath(sourceRoot)
  const documentationEntryPoint = join(root, 'docs', 'README.md')
  const metadata = await lstat(documentationEntryPoint)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('the canonical documentation entry point must be a regular file')
  const { stdout } = await exec('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' })
  const umbrellaRevision = stdout.trim()
  if (!/^[0-9a-f]{40,64}$/u.test(umbrellaRevision)) throw new Error('the umbrella source revision is invalid')
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

import { hasPrivatePermissions } from '@dearmachine/machtiani-installer-credentials'
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

export type InstallationMethod = 'standard' | 'nix' | 'container'
export interface ProductDistribution {
  method?: 'standard' | 'container'
  manifestPath: string
  sourceRoot: string
  binaries: { dearmachine: string; machtiani: string; modelHost: string; agentManager: string }
}

/** A release manifest is an explicit launcher contract, never inferred from PATH. */
export async function loadDistribution(environment: NodeJS.ProcessEnv): Promise<ProductDistribution | undefined> {
  const manifestPath = environment.MACHTIANI_DISTRIBUTION
  if (manifestPath === undefined) return undefined
  if (!isAbsolute(manifestPath)) throw new Error('the distribution manifest path must be absolute')
  const metadata = await lstat(manifestPath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384 || !await hasPrivatePermissions(manifestPath, 0o022)) {
    throw new Error('the distribution manifest must be a small, non-writable-by-others regular file')
  }
  const root = await realpath(dirname(manifestPath))
  const value = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    version?: unknown; method?: unknown; sourceRoot?: unknown; binaries?: Record<string, unknown>
  }
  if (value.version !== 1 || value.binaries === undefined || value.binaries === null) throw new Error('invalid distribution manifest')
  const resolveMember = async (member: unknown, executable: boolean): Promise<string> => {
    if (typeof member !== 'string' || member === '' || isAbsolute(member) ||
      member.split(/[\\/]/u).some(part => part === '..' || part === '.') || /[\r\n\0]/u.test(member)) {
      throw new Error('distribution paths must be relative to the release')
    }
    const path = join(root, member)
    const resolved = await realpath(path)
    const rel = relative(root, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('distribution path escapes its release')
    const info = await stat(path)
    if (executable) {
      if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o111) === 0)) throw new Error('distribution product is not executable')
      await access(path, constants.X_OK)
    } else if (!info.isDirectory()) throw new Error('distribution source root is not a directory')
    return path
  }
  if (value.method !== undefined && value.method !== 'container' && value.method !== 'standard') throw new Error('invalid distribution method')
  return {
    ...(value.method === undefined ? {} : { method: value.method }),
    manifestPath, sourceRoot: await resolveMember(value.sourceRoot, false),
    binaries: {
      dearmachine: await resolveMember(value.binaries.dearmachine, true),
      machtiani: await resolveMember(value.binaries.machtiani, true),
      modelHost: await resolveMember(value.binaries.modelHost, true),
      agentManager: await resolveMember(value.binaries.agentManager, true),
    },
  }
}

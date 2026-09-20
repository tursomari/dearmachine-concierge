import { protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface InstallerLock {
  release(): Promise<void>
}

interface LockRecord { pid: number; token: string }

function isLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export class InstallerAlreadyRunningError extends Error {
  constructor(readonly ownerPid?: number) {
    super(`Machtiani Installer is already running${ownerPid === undefined ? '' : ` (process ${ownerPid})`}. Return to that terminal to continue.`)
    this.name = 'InstallerAlreadyRunningError'
  }
}

export async function acquireInstallerLock(path: string): Promise<InstallerLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await protectPrivatePath(dirname(path), 0o700)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID()
    try {
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`) } finally { await handle.close() }
      return {
        release: async () => {
          try {
            const current = JSON.parse(await readFile(path, 'utf8')) as LockRecord
            if (current.pid === process.pid && current.token === token) await unlink(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: LockRecord | undefined
      try { owner = JSON.parse(await readFile(path, 'utf8')) as LockRecord } catch { /* malformed is stale */ }
      if (owner !== undefined && isLive(owner.pid)) throw new InstallerAlreadyRunningError(owner.pid)
      if (attempt === 0) {
        try { await unlink(path) } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
        }
        continue
      }
      throw new InstallerAlreadyRunningError(owner?.pid)
    }
  }
  throw new InstallerAlreadyRunningError()
}

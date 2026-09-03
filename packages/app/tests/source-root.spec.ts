import { mkdir, mkdtemp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validatedSourceRoot } from '../src/index.ts'

describe('installer source root', () => {
  it('requires an absolute umbrella checkout containing both product components', async () => {
    await expect(validatedSourceRoot('machtiani')).rejects.toThrow('--source-root must be an absolute path')
    const root = await mkdtemp(join(tmpdir(), 'machtiani-source-root-'))
    await mkdir(join(root, 'machtiani-harness'))
    await expect(validatedSourceRoot(root)).rejects.toThrow('dearmachine')
    await mkdir(join(root, 'dearmachine'))
    await expect(validatedSourceRoot(root)).resolves.toBe(root)
  })

  it('fails early with an actionable message when the launcher has no TTY', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-no-tty-'))
    await mkdir(join(root, 'machtiani-harness'))
    await mkdir(join(root, 'dearmachine'))
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve('packages/app/dist/bin.mjs'), '--install', '--source-root', root], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', code => resolveResult({ code, stderr }))
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('Machtiani Installer needs an interactive terminal. Open a terminal and run the installer again.\n')
  })
})

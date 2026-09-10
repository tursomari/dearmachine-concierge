import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { launchEnvironment } from '../src/launch-environment.ts'

describe('backend launch environment', () => {
  it('preserves precedence and unrelated variables, appending the user bin only once', () => {
    const original = { HOME: '/home/example', PATH: '/custom/bin:/usr/bin', KEEP: 'unchanged' }
    const updated = launchEnvironment(original)
    expect(updated).toEqual({ ...original, PATH: '/custom/bin:/usr/bin:/home/example/.local/bin' })
    expect(original.PATH).toBe('/custom/bin:/usr/bin')
    expect(launchEnvironment(updated)).toEqual(updated)
  })

  it('does not invent relative search paths from an absent or invalid home', () => {
    for (const HOME of [undefined, '', 'relative', '/home/with:colon']) {
      expect(launchEnvironment({ HOME, PATH: '/usr/bin' }).PATH).toBe('/usr/bin')
    }
    expect(launchEnvironment({ HOME: '/home/example' }).PATH).toBe('/usr/bin:/bin:/home/example/.local/bin')
  })

  it('finds an existing backend in fresh child processes without shell startup files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backend-path-'))
    try {
      const bin = join(root, '.local/bin')
      await mkdir(bin, { recursive: true })
      await writeFile(join(bin, 'omp'), '#!/bin/sh\nprintf "fixture-backend\\n"\n', { mode: 0o700 })
      for (let reopen = 0; reopen < 2; reopen++) {
        const result = await promisify(execFile)('/bin/sh', ['-c', 'omp'], {
          env: launchEnvironment({ HOME: root, PATH: '/usr/bin:/bin' }),
        })
        expect(result.stdout.trim()).toBe('fixture-backend')
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('applies the environment at the real CLI boundary before native bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backend-cli-path-'))
    try {
      const bin = join(root, '.local/bin')
      await mkdir(bin, { recursive: true })
      const receipt = join(root, 'native-path')
      // Fail bootstrap deliberately after recording PATH: no daemon or model runs.
      await writeFile(join(bin, 'dearmachine'), '#!/bin/sh\nprintf "%s" "$PATH" > "$HOME/native-path"\nexit 1\n', { mode: 0o700 })
      const { readFile } = await import('node:fs/promises')
      await promisify(execFile)(process.execPath, [resolve('packages/app/dist/bin.mjs'), 'up'], {
        env: { HOME: root, PATH: '/usr/bin:/bin' }, timeout: 5_000,
      }).catch(() => {})
      expect((await readFile(receipt, 'utf8')).split(':')).toContain(bin)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

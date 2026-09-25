import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const bin = fileURLToPath(new URL('../dist/bin.mjs', import.meta.url))
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

it.skipIf(process.platform === 'win32')('configures shell PATH through the installed CLI and supports repeating the repair', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shell-setup-cli-'))
  homes.push(home)
  const env = { HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }
  await expect(exec(process.execPath, [bin, 'configure-shell'], { env })).rejects.toThrow()
  expect(existsSync(join(home, '.zshrc'))).toBe(false)
  await mkdir(join(home, '.local/bin'), { recursive: true })
  await writeFile(join(home, '.local/bin/dearmachine'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const result = await exec(process.execPath, [bin, 'configure-shell'], { env })
  expect(result.stderr).toContain('Configured PATH')
  expect(result.stderr).toContain('current shell')
  const contents = await readFile(join(home, '.zshrc'), 'utf8')
  expect(contents).toContain('$HOME/.local/bin')
  await exec(process.execPath, [bin, 'configure-shell'], { env })
  expect(await readFile(join(home, '.zshrc'), 'utf8')).toBe(contents)
  await expect(exec(process.execPath, [bin, 'configure-shell', 'unexpected'], { env })).rejects.toThrow()
})

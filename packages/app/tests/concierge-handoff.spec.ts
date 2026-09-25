import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { handoffInstalledConcierge, installedConciergeEnvironment } from '../src/concierge-handoff.ts'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('drops bootstrap release identity without changing HOME, PATH, or unrelated settings', () => {
  const environment = {
    HOME: '/user', PATH: '/user/bin:/usr/bin', CUSTOM_SETTING: 'keep',
    DEARMACHINE_NATIVE_BIN: '/old/native', DEARMACHINE_CONCIERGE_BIN: '/old/concierge',
    DEARMACHINE_SOURCE_ROOT: '/old/source', MACHTIANI_DISTRIBUTION: '/old/distribution.json',
  }
  expect(installedConciergeEnvironment(environment)).toEqual({ HOME: '/user', PATH: '/user/bin:/usr/bin', CUSTOM_SETTING: 'keep' })
  expect(environment.DEARMACHINE_NATIVE_BIN).toBe('/old/native')
})

it('does not relaunch a concierge already opened through the native launcher', async () => {
  expect(await handoffInstalledConcierge({ DEARMACHINE_NATIVE_BIN: '/installed/native' })).toBe(false)
})

it('retains recovery when there is no installed launcher', async () => {
  const home = await mkdtemp(join(tmpdir(), 'handoff-missing-'))
  roots.push(home)
  expect(await handoffInstalledConcierge({ HOME: home })).toBe(false)
})

it.skipIf(process.platform === 'win32')('hands off after installation cleanup and preserves the installed process exit code', async () => {
  const home = await mkdtemp(join(tmpdir(), "handoff ' space-"))
  roots.push(home)
  await mkdir(join(home, '.local/bin'), { recursive: true })
  await writeFile(join(home, '.local/bin/dearmachine'), [
    '#!/bin/sh',
    'test -f "$HOME/installer-closed" || exit 91',
    'test -z "$DEARMACHINE_SOURCE_ROOT$DEARMACHINE_CONCIERGE_BIN$MACHTIANI_DISTRIBUTION" || exit 92',
    'test "$#" = 0 || exit 93',
    'printf "installed launcher reached\\n"',
    'exit 23',
  ].join('\n'), { mode: 0o700 })
  const entry = new URL('../src/concierge-entry.ts', import.meta.url).href
  const handoff = new URL('../src/concierge-handoff.ts', import.meta.url).href
  const code = [
    'import { writeFile } from "node:fs/promises";',
    'import { runConciergeEntry } from ' + JSON.stringify(entry) + ';',
    'import { handoffInstalledConcierge } from ' + JSON.stringify(handoff) + ';',
    'let installed = false;',
    'await runConciergeEntry({',
    ' interactive: true,',
    ' inspect: async () => ({ installation: installed ? "installed" : "absent" }),',
    ' install: async () => { await writeFile(process.env.HOME + "/installer-closed", "closed"); installed = true; },',
    ' manage: async () => { await handoffInstalledConcierge(); throw Error("bootstrap continued"); },',
    ' write: () => { throw Error("unexpected help"); },',
    '});',
  ].join('\n')
  let error: unknown
  try {
    await exec(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', code], {
      env: { HOME: home, PATH: '/usr/bin:/bin', DEARMACHINE_SOURCE_ROOT: '/old/source', DEARMACHINE_CONCIERGE_BIN: '/old/concierge', MACHTIANI_DISTRIBUTION: '/old/distribution.json' },
    })
  } catch (caught) { error = caught }
  expect(error).toMatchObject({ code: 23, stdout: 'installed launcher reached\n' })
})

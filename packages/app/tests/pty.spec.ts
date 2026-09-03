import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

function runInPty(input: string): Promise<{ code: number; output: string }> {
  return new Promise(async (resolveResult, reject) => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-pty-test-'))
    const app = resolve('packages/app/dist/bin.mjs')
    const command = `before=$(stty -g); ${JSON.stringify(process.execPath)} ${JSON.stringify(app)} --mock; code=$?; after=$(stty -g); [ "$before" = "$after" ] || exit 90; exit $code`
    const child = pty.spawn('bash', ['-lc', command], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'), TERM: 'xterm-256color' },
    })
    let output = ''
    let sent = false
    const timer = setTimeout(() => { child.kill(); reject(new Error('PTY installer timed out')) }, 8_000)
    child.onData(chunk => {
      output += chunk
      if (!sent && output.includes('Would you like to continue')) {
        sent = true
        child.write(input)
      }
    })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolveResult({ code: exitCode, output })
    })
  })
}

describe('real PTY lifecycle', () => {
  it('restores the terminal after declining the welcome gate', async () => {
    const result = await runInPty('not now\r')
    expect(result.code).toBe(0)
    expect(result.output).toContain('MACHTIANI INSTALLER')
  })

  it('restores the terminal after Ctrl-C cancellation', async () => {
    const result = await runInPty('\x03')
    expect(result.code).toBe(1)
    expect(result.output).toContain('cancelled')
  })
})

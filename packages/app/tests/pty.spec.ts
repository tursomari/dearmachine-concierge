import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

interface PtyResponse {
  prompt: string
  input: string
}

interface TerminalReply {
  trigger: string
  input: string
  delayMs: number
}

function runInPty(responses: readonly PtyResponse[], terminalReply?: TerminalReply): Promise<{ code: number; output: string }> {
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
    let responseIndex = 0
    let searchOffset = 0
    let sentTerminalReply = false
    const timer = setTimeout(() => { child.kill(); reject(new Error(`PTY installer timed out after ${responseIndex}/${responses.length} responses\n${output.slice(-2_000)}`)) }, 8_000)
    child.onData(chunk => {
      output += chunk
      if (!sentTerminalReply && terminalReply !== undefined && output.includes(terminalReply.trigger)) {
        sentTerminalReply = true
        setTimeout(() => { child.write(terminalReply.input) }, terminalReply.delayMs)
      }
      const response = responses[responseIndex]
      if (response !== undefined && output.slice(searchOffset).includes(response.prompt)) {
        responseIndex += 1
        searchOffset = output.length
        child.write(response.input)
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
    const result = await runInPty([{ prompt: 'Would you like to continue', input: 'not now\r' }])
    expect(result.code).toBe(0)
    expect(result.output).toContain('MACHTIANI INSTALLER')
  })

  it('drains delayed terminal replies before restoring cooked input', async () => {
    const deviceAttributes = '\x1b[?61;1;21;22;28c'
    const result = await runInPty([{
      prompt: 'Would you like to continue',
      input: 'not now\r',
    }], { trigger: '\x1b[<u', input: deviceAttributes, delayMs: 5 })
    expect(result.code).toBe(0)
    expect(result.output).not.toContain(deviceAttributes)
    expect(result.output).not.toContain('^[[?61;1;21;22;28c')
  })

  it('restores the terminal after Ctrl-C exit', async () => {
    const result = await runInPty([{ prompt: 'Would you like to continue', input: '\x03' }])
    expect(result.code).toBe(0)
  })

  it('completes the no-mutation guided preview through canonical credential handoffs', async () => {
    const result = await runInPty([
      { prompt: 'Would you like to continue', input: 'yes\r' },
      { prompt: 'Which LLM provider', input: 'OpenRouter\r' },
      { prompt: 'Which OpenRouter model', input: 'z-ai/glm-5.3-flash\r' },
      { prompt: 'Preview only:', input: 'preview-llm-credential\r' },
      { prompt: 'Which would you like to use?', input: 'AgentMail\r' },
      { prompt: 'free tier is available.', input: 'no\r' },
      { prompt: 'Preview only:', input: 'preview-email-credential\r' },
      { prompt: 'What email address', input: 'sender@example.test\r' },
    ])
    expect(result.code).toBe(0)
    expect(result.output).toContain('no-change installation preview is complete')
    expect(result.output).not.toContain('preview-llm-credential')
    expect(result.output).not.toContain('preview-email-credential')
  })
})

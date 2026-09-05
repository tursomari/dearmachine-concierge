import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runInteractiveModelHostAuth } from '../src/cli.ts'

class Capture extends Writable {
  value = ''
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString()
    callback()
  }
}

describe('model-host interactive authentication CLI', () => {
  it('relays provider-owned login instructions and a manual code without echoing it', async () => {
    const output = new Capture()
    const errors = new Capture()
    let promptedCode = ''
    let openedPath = ''
    const host = {
      profile: { authMethod: 'subscription' as const, provider: 'anthropic-claude' },
      async login(interaction: any, mode: unknown) {
        expect(mode).toBe('browser')
        interaction.notify({ type: 'progress', message: 'Starting Claude sign-in' })
        interaction.notify({ type: 'auth_url', url: 'https://example.invalid/login', instructions: 'Open the provider page.' })
        promptedCode = await interaction.prompt({ type: 'manual_code', message: 'Paste the one-time code:' })
      },
    }

    const code = await runInteractiveModelHostAuth(
      ['auth', 'login', '--profile', '/private/profile.json', '--mode', 'browser'],
      Readable.from(['one-time-private-code\n']), output, errors,
      async path => { openedPath = path; return host as never },
    )

    expect(code).toBe(0)
    expect(openedPath).toBe('/private/profile.json')
    expect(promptedCode).toBe('one-time-private-code')
    expect(errors.value).toContain('Starting Claude sign-in')
    expect(errors.value).toContain('https://example.invalid/login')
    expect(errors.value).toContain('Paste the one-time code:')
    expect(errors.value).not.toContain('one-time-private-code')
    expect(output.value).toBe('Authentication completed for anthropic-claude.\n')
  })

  it('rejects unsupported modes before opening the private profile', async () => {
    let opened = false
    const errors = new Capture()
    const code = await runInteractiveModelHostAuth(
      ['auth', 'login', '--profile', '/private/profile.json', '--mode', 'invented'],
      Readable.from([]), new Capture(), errors,
      async () => { opened = true; throw new Error('must not open') },
    )
    expect(code).toBe(2)
    expect(opened).toBe(false)
    expect(errors.value).toContain('browser or device_code')
  })
})

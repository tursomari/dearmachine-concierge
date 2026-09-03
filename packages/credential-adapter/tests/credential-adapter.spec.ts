import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CredentialHelperAdapter, resolveCredentialReference } from '../src/index.ts'

describe('credential helper adapter', () => {
  it('maps supported selections to private references without values', () => {
    expect(resolveCredentialReference('llm', 'OpenRouter', '/home/test')).toEqual({
      kind: 'llm', helperName: 'enter-llm-key', destination: '/home/test/.config/dearmachine/backends.env',
      format: 'environment', variable: 'OPENROUTER_API_KEY',
    })
    expect(resolveCredentialReference('email', 'Sendmux', '/home/test').destination).toBe('/home/test/.config/dearmachine/sendmux-api-key')
  })

  it('uses the canonical one-shot helper without echoing the captured value', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-credential-adapter-'))
    const bin = join(home, 'test-bin')
    await mkdir(bin)
    const micro = join(bin, 'micro')
    await writeFile(micro, `#!/usr/bin/env bash
set -euo pipefail
draft=$1
marker='--- DEAR MACHINE CREDENTIAL INSTRUCTIONS ---'
printf '%s\\n\\n%s\\n' 'credential-test-value' "$marker" > "$draft"
`)
    await chmod(micro, 0o700)
    const adapter = new CredentialHelperAdapter({ home, environment: { PATH: `${bin}:${process.env.PATH ?? ''}` } })
    await expect(adapter.prepare('llm', 'OpenRouter')).resolves.toBe('pending')
    const helper = join(home, '.local/bin/enter-llm-key')
    const result = await new Promise<{ output: string; code: number | null }>((resolve, reject) => {
      const child = spawn(helper, [], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { output += String(chunk) })
      child.once('error', reject)
      child.once('close', code => resolve({ output, code }))
    })
    expect(result).toEqual({ output: '', code: 0 })
    await expect(adapter.status('llm')).resolves.toBe('ready')
    expect(await readFile(join(home, '.config/dearmachine/backends.env'), 'utf8')).toBe('OPENROUTER_API_KEY=credential-test-value\n')
    expect(result.output).not.toContain('credential-test-value')
    const restarted = new CredentialHelperAdapter({ home, environment: { PATH: `${bin}:${process.env.PATH ?? ''}` } })
    await expect(restarted.prepare('llm', 'OpenRouter')).resolves.toBe('ready')
  })

  it('re-prepares the helper when the selected provider changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'machtiani-credential-switch-'))
    const destination = join(home, '.config', 'dearmachine', 'backends.env')
    await mkdir(join(home, '.config', 'dearmachine'), { recursive: true })
    await writeFile(destination, 'OPENROUTER_API_KEY=previous-provider-value\n', { mode: 0o600 })
    const adapter = new CredentialHelperAdapter({ home })
    await expect(adapter.prepare('llm', 'DeepSeek')).resolves.toBe('pending')
    const spec = await readFile(join(home, '.local', 'state', 'dearmachine', 'installation', 'enter-llm-key.spec'), 'utf8')
    expect(spec).toContain('variable=DEEPSEEK_API_KEY')
    expect(spec).not.toContain('previous-provider-value')
  })
})

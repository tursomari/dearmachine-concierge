import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementConversation, openManagementAgent } from '../src/concierge-agent.ts'
import type { DshAgentSessionOptions } from '@dearmachine/machtiani-installer-dsh-adapter'
import { saveModelHostProfile } from '@dearmachine/machtiani-model-host'
import { saveInterfacePreferences } from '../src/interface-preferences.ts'

const mock = vi.hoisted(() => ({ sessions: [] as { options: DshAgentSessionOptions; prompts: string[] }[], failStart: false }))
vi.mock('@dearmachine/machtiani-installer-dsh-adapter', () => ({
  DshAgentSession: class {
    options: DshAgentSessionOptions
    prompts: string[] = []
    constructor(options: DshAgentSessionOptions) { this.options = options; mock.sessions.push(this) }
    async start() { if (mock.failStart) throw new Error('provider unavailable') }
    async prompt(text: string) { this.prompts.push(text) }
    async interrupt() {}
    async shutdown() {}
  },
}))
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs(); mock.sessions.length = 0; mock.failStart = false
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cc-')); roots.push(root)
  vi.stubEnv('HOME', root); vi.stubEnv('XDG_STATE_HOME', join(root, 'state'))
  vi.stubEnv('MACHTIANI_DISTRIBUTION', undefined)
  await saveModelHostProfile(join(root, '.config', 'machtiani', 'model-profile.json'), {
    version: 1, driver: 'pi-ai', provider: 'openrouter', authMethod: 'api_key', model: 'fixture-model', reasoningEffort: 'high',
    credential: { kind: 'environment-file', path: join(root, '.config', 'dearmachine', 'backends.env'), variable: 'OPENROUTER_API_KEY' },
  })
  const key = 'fake-concierge-key'
  const askSecret = vi.fn(async () => key)
  const open = () => openManagementAgent({ event: () => {}, status: () => {}, askSecret })
  const conversation = new ManagementConversation(open)
  return { root, key, askSecret, conversation }
}
function socketPath(): string { return mock.sessions.at(-1)!.options.environment!.MACHTIANI_INSTALLER_CREDENTIAL_SOCKET! }
async function invoke(path: string, provider = 'openrouter') {
  return promisify(execFile)(process.execPath, [resolve('packages/app/dist/credential-bin.mjs'), 'backend-provider', provider], {
    env: { ...process.env, MACHTIANI_INSTALLER_CREDENTIAL_SOCKET: path }, timeout: 3_000,
  })
}

describe('reopened concierge credentials', () => {
  it.each([true, false])('retains command visibility %s at handoff and on the next management session', async showCommands => {
    const { root, askSecret, conversation } = await fixture()
    await saveInterfacePreferences(root, { showCommands })
    try {
      await conversation.submit('Check Dear Machine.')
      expect(mock.sessions.at(-1)!.options.showCommands).toBe(showCommands)
    } finally { await conversation.close() }
    const reopened = new ManagementConversation(() => openManagementAgent({ event: () => {}, status: () => {}, askSecret }))
    try {
      await reopened.submit('Check again.')
      expect(mock.sessions.at(-1)!.options.showCommands).toBe(showCommands)
    } finally { await reopened.close() }
  })
  it('collects an unknown provider through the real helper and returns only its reusable reference', async () => {
    const { key, askSecret, conversation } = await fixture()
    try {
      await conversation.submit('Configure Forge with my custom gateway.')
      const result = await invoke(socketPath(), 'Regional Gateway')
      expect(result.stdout).toContain('Credential saved securely')
      expect(result.stdout).toContain('MACHTIANI_BACKEND_REGIONAL_GATEWAY_')
      expect(result.stdout).toContain('backends.env')
      expect(result.stdout + result.stderr).not.toContain(key)
      expect((await invoke(socketPath(), 'regional gateway')).stdout).toContain('already available')
      expect(askSecret).toHaveBeenCalledTimes(1)
    } finally { await conversation.close() }
  })
  it('lazily supplies a live private helper and saves only through masked input', async () => {
    const { root, key, askSecret, conversation } = await fixture()
    expect(mock.sessions).toHaveLength(0)
    try {
      await conversation.submit('Add another backend with OpenRouter; keep my current backend.')
      const socket = socketPath()
      expect((await stat(socket)).mode & 0o077).toBe(0)
      const prompt = mock.sessions[0]!.prompts[0]!
      expect(prompt).toContain('credentialHelper')
      expect(prompt).toContain('backend-provider')
      expect(prompt).toContain('"backendPreparations"')
      expect(prompt).toContain('"forge"')
      expect(prompt).toContain('sharedModelSelection')
      expect(prompt).toContain('fixture-model')
      expect(prompt).not.toContain(key)
      const result = await invoke(socket)
      expect(result.stdout).toContain('Credential saved securely')
      expect(result.stdout + result.stderr).not.toContain(key)
      expect(askSecret).toHaveBeenCalledTimes(1)
      const file = join(root, '.config', 'dearmachine', 'backends.env')
      expect(await readFile(file, 'utf8')).toBe(`OPENROUTER_API_KEY=${key}\n`)
      expect((await stat(file)).mode & 0o077).toBe(0)
      await conversation.close()
      await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await conversation.close() }
  })

  it('reopens with a fresh bridge, reuses the key, and preserves other provider credentials', async () => {
    const { root, askSecret, conversation } = await fixture()
    const directory = join(root, '.config', 'dearmachine')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const content = 'DEEPSEEK_API_KEY=unrelated-fixture\nOPENROUTER_API_KEY=existing-fixture\n'
    await writeFile(join(directory, 'backends.env'), content, { mode: 0o600 })
    await conversation.submit('Configure another backend.')
    const first = socketPath()
    await conversation.close()
    const reopened = new ManagementConversation(() => openManagementAgent({ event: () => {}, status: () => {}, askSecret }))
    try {
      await reopened.submit('Use my existing OpenRouter key.')
      expect(socketPath()).not.toBe(first)
      expect((await invoke(socketPath())).stdout).toContain('already available')
      expect(askSecret).not.toHaveBeenCalled()
      expect(await readFile(join(directory, 'backends.env'), 'utf8')).toBe(content)
    } finally { await reopened.close() }
  })

  it('cleans the bridge when management startup fails', async () => {
    const { conversation } = await fixture(); mock.failStart = true
    await expect(conversation.submit('Hello')).rejects.toThrow('provider unavailable')
    await expect(stat(socketPath())).rejects.toMatchObject({ code: 'ENOENT' })
    await conversation.close()
  })
})

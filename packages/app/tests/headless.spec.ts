import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHeadlessSelection, parseHeadlessArguments, saveHeadlessModelProfile } from '../src/headless.ts'

const selection = {
  provider: 'openrouter',
  model: 'z-ai/glm-5.3-flash',
  transport: 'agentmail',
  authorizedSender: 'sender@example.test',
  detectedBackends: ['forge'],
  backend: {
    name: 'Forge', id: 'forge', executable: '/test/forge', status: 'ready', summary: 'functional probe passed',
  },
}

describe('headless product gate', () => {
  it('accepts only the explicit source, selection, and QSE option forms', () => {
    expect(parseHeadlessArguments(['--source-root', '/source', '--selection-file', '/selection'])).toEqual({
      sourceRoot: '/source', selectionFile: '/selection',
    })
    expect(parseHeadlessArguments([
      '--source-root', '/source', '--selection-file', '/selection', '--existing-inbox-id', 'inbox-qse-owned',
    ])).toEqual({ sourceRoot: '/source', selectionFile: '/selection', existingInboxId: 'inbox-qse-owned' })
    expect(parseHeadlessArguments([
      '--source-root', '/source', '--selection-file', '/selection', '--existing-inbox-id', 'inbox-qse-owned',
      '--reasoning-effort', 'high',
    ])).toEqual({
      sourceRoot: '/source', selectionFile: '/selection', existingInboxId: 'inbox-qse-owned', reasoningEffort: 'high',
    })
    expect(() => parseHeadlessArguments(['--source-root', '/source'])).toThrow('Usage:')
  })

  it('loads a private ready selection without accepting credential-shaped extra fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-headless-selection-'))
    const path = join(root, 'selection.json')
    await writeFile(path, `${JSON.stringify(selection)}\n`, { mode: 0o600 })
    await expect(loadHeadlessSelection(path)).resolves.toEqual(selection)
    await writeFile(path, `${JSON.stringify({ ...selection, apiKey: 'must-not-cross-this-boundary' })}\n`, { mode: 0o600 })
    await expect(loadHeadlessSelection(path)).rejects.toThrow('unexpected or missing fields')
  })

  it('accepts an explicit boolean quote choice and rejects any other value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-headless-selection-'))
    const path = join(root, 'selection.json')
    await writeFile(path, `${JSON.stringify({ ...selection, magnificaHumanitas: true })}\n`, { mode: 0o600 })
    await expect(loadHeadlessSelection(path)).resolves.toEqual({ ...selection, magnificaHumanitas: true })
    await writeFile(path, `${JSON.stringify({ ...selection, magnificaHumanitas: false })}\n`, { mode: 0o600 })
    await expect(loadHeadlessSelection(path)).resolves.toEqual(selection)
    await writeFile(path, `${JSON.stringify({ ...selection, magnificaHumanitas: 'yes' })}\n`, { mode: 0o600 })
    await expect(loadHeadlessSelection(path)).rejects.toThrow('invalid quote choice')
  })

  it('rejects a non-private selection file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-headless-selection-'))
    const path = join(root, 'selection.json')
    await writeFile(path, `${JSON.stringify(selection)}\n`, { mode: 0o600 })
    await chmod(path, 0o644)
    await expect(loadHeadlessSelection(path)).rejects.toThrow('private regular file')
  })

  it('derives the headless product profile from the same selected provider and model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-headless-profile-'))
    const home = join(root, 'home')
    const path = await saveHeadlessModelProfile(home, join(root, 'state'), selection, 'high', {})

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1, selectionVersion: 1, overrides: {},
      driver: 'pi-ai',
      provider: 'openrouter',
      authMethod: 'api_key',
      model: 'z-ai/glm-5.3-flash',
      reasoningEffort: 'high',
      credential: {
        kind: 'environment-file',
        path: join(home, '.config', 'dearmachine', 'backends.env'),
        variable: 'OPENROUTER_API_KEY',
      },
    })
  })
  it('preserves a custom endpoint, credential reference and requested reasoning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-headless-custom-'))
    const custom = { ...selection, provider: 'custom-openai-remote', model: 'example/model', customProvider: {
      kind: 'openai-compatible' as const, scope: 'remote' as const, name: 'Example',
      chatCompletionsEndpoint: 'https://models.example.test/v1/chat/completions', usesApiKey: true,
    } }
    const selectionPath = join(root, 'selection.json')
    await writeFile(selectionPath, JSON.stringify(custom), { mode: 0o600 })
    const loaded = await loadHeadlessSelection(selectionPath)
    const path = await saveHeadlessModelProfile(root, join(root, 'state'), loaded, 'high', {})
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1, selectionVersion: 1, overrides: {}, driver: 'openai-compatible', provider: custom.provider, model: custom.model,
      authMethod: 'optional_api_key', reasoningEffort: 'high', customProvider: custom.customProvider,
      credential: { kind: 'environment-file', path: join(root, '.config/dearmachine/backends.env'),
        variable: 'MACHTIANI_CUSTOM_OPENAI_REMOTE_API_KEY' },
    })
    for (const invalid of [
      { ...custom, customProvider: { ...custom.customProvider, apiKey: 'forbidden' } },
      { ...custom, customProvider: { ...custom.customProvider, chatCompletionsEndpoint: 'https://models.example.test?key=forbidden' } },
      { ...custom, provider: 'openai' },
      { ...custom, customProvider: undefined },
    ]) {
      await writeFile(selectionPath, JSON.stringify(invalid), { mode: 0o600 })
      await expect(loadHeadlessSelection(selectionPath)).rejects.toThrow()
    }
  })

})

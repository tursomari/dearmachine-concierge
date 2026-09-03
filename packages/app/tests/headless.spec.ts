import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHeadlessSelection, parseHeadlessArguments } from '../src/headless.ts'

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

  it('rejects a non-private selection file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-headless-selection-'))
    const path = join(root, 'selection.json')
    await writeFile(path, `${JSON.stringify(selection)}\n`, { mode: 0o600 })
    await chmod(path, 0o644)
    await expect(loadHeadlessSelection(path)).rejects.toThrow('private regular file')
  })
})

import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveModelProfile, loadModelHostProfile, modelComponents, saveModelHostProfile, type ModelHostProfile } from '@dearmachine/machtiani-model-host'
import { assistantModelPath, loadModelSettings, migrateModelSettings, saveModelSettings, sharedModelPath } from '../src/model-settings.ts'
import { ensureAssistantModel } from '../src/assistant-model.ts'
import { configuredBackendModels } from '../src/backend-models.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const profile = (model: string, reasoningEffort?: string): ModelHostProfile => ({ version: 1, driver: 'openai-codex-app-server', provider: 'openai-codex', authMethod: 'subscription', model, runtimeProfile: '/fixture/account', ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
async function fixture() { const home = await mkdtemp(join(tmpdir(), 'model-settings-')); homes.push(home); return home }

it('migrates legacy Default and a distinct Concierge choice without losing auth metadata', async () => {
  const home = await fixture()
  await saveModelHostProfile(sharedModelPath(home), profile('shared', 'high'))
  await saveModelHostProfile(assistantModelPath(home), profile('assistant'))
  const legacyAssistant = await readFile(assistantModelPath(home), 'utf8')
  await migrateModelSettings(home)
  const settings = (await loadModelSettings(home))!
  expect(settings).toMatchObject({ model: 'shared', selectionVersion: 1, overrides: { concierge: profile('assistant') } })
  expect(await readFile(assistantModelPath(home), 'utf8')).toBe(legacyAssistant)
  expect(effectiveModelProfile(settings, 'concierge').reasoningEffort).toBeUndefined()
  expect((await stat(sharedModelPath(home))).mode & 0o777).toBe(0o600)
  const bytes = await readFile(sharedModelPath(home), 'utf8')
  await migrateModelSettings(home)
  expect(await readFile(sharedModelPath(home), 'utf8')).toBe(bytes)
})

it('snapshot creation does not turn inherited Concierge into an override', async () => {
  const home = await fixture()
  await saveModelHostProfile(sharedModelPath(home), profile('legacy'))
  await ensureAssistantModel(home)
  await saveModelSettings(home, 'default', profile('new', 'low'))
  expect(await ensureAssistantModel(home)).toEqual(profile('new', 'low'))
  expect((await loadModelSettings(home))!.overrides).toEqual({})
})

it('persists overrides, preserves them on Default changes, inherits after reset and clears all on Set all', async () => {
  const home = await fixture()
  await saveModelSettings(home, 'all', profile('default', 'high'))
  for (const component of modelComponents) await saveModelSettings(home, component, profile(component))
  await saveModelSettings(home, 'default', profile('new-default', 'low'))
  const settings = (await loadModelSettings(home))!
  for (const component of modelComponents) {
    expect(effectiveModelProfile(settings, component)).toEqual(profile(component))
    expect(effectiveModelProfile(settings, component, profile('cli', 'medium'))).toEqual(profile('cli', 'medium'))
  }
  await saveModelSettings(home, 'sync')
  expect(effectiveModelProfile((await loadModelSettings(home))!, 'sync')).toEqual(profile('new-default', 'low'))
  await saveModelSettings(home, 'all', profile('all'))
  const all = (await loadModelSettings(home))!
  expect(all.overrides).toEqual({})
  for (const component of modelComponents) expect(effectiveModelProfile(all, component)).toEqual(profile('all'))
})

it('uses an assistant-only installation as Default and rejects unsupported schema without writes', async () => {
  const home = await fixture()
  await saveModelHostProfile(assistantModelPath(home), profile('assistant-only'))
  await migrateModelSettings(home)
  expect((await loadModelSettings(home))!.overrides).toEqual({})
  const bad = JSON.stringify({ ...profile('bad'), selectionVersion: 2 })
  await writeFile(sharedModelPath(home), bad)
  await expect(saveModelSettings(home, 'all', profile('replacement'))).rejects.toThrow('version')
  expect(await readFile(sharedModelPath(home), 'utf8')).toBe(bad)
})

it('rejects invalid and nested overrides', async () => {
  const home = await fixture()
  for (const overrides of [{ sync: null }, { unknown: profile('x') }, { sync: { ...profile('x'), overrides: {} } }]) {
    await mkdir(join(home, '.config', 'machtiani'), { recursive: true })
    await writeFile(sharedModelPath(home), JSON.stringify({ ...profile('x'), selectionVersion: 1, overrides }), { mode: 0o600 })
    await expect(loadModelHostProfile(sharedModelPath(home))).rejects.toThrow()
  }
})

it('shows only configured backends, with read-only evidence-based guidance and no guessed model', async () => {
  const home = await fixture()
  expect(await configuredBackendModels(home, {})).toEqual([])
  await mkdir(join(home, '.dearmachine', 'config'), { recursive: true })
  const path = join(home, '.dearmachine', 'config', 'dearmachine.toml')
  const config = 'version = 1\nbackends = ["forge", "claude", "private-backend"]\n'
  await writeFile(path, config)
  const lines = await configuredBackendModels(home, { DEARMACHINE_CLAUDE_MODEL: 'explicit', ANTHROPIC_MODEL: 'fallback' })
  expect(lines.join('\n')).not.toMatch(/Codex|OMP/)
  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain('forge config set model <provider> <model>')
  expect(lines[1]).toContain('model not determined')
  expect(lines[1]).not.toContain('explicit')
  expect(lines[1]).toContain('DEARMACHINE_CLAUDE_MODEL')
  expect(lines[2]).toContain('custom-backends.toml')
  expect(await readFile(path, 'utf8')).toBe(config)
  await writeFile(path, 'version = 1\nbackends = ["codex-yolo", "omp", "claude"]\n')
  expect((await configuredBackendModels(home, {})).join('\n')).toContain('sonnet as the fallback')
  expect((await configuredBackendModels(home, {}))[0]).toContain('model not determined')
})

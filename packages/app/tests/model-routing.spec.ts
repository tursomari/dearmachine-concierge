import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'smol-toml'
import { hasPrivatePermissions, protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { effectiveModelProfile, saveModelHostProfile, type ModelHostProfile } from '@dearmachine/machtiani-model-host'
import { loadModelSettings, saveModelSettings, sharedModelPath, type ModelTarget } from '../src/model-settings.ts'
import * as routing from '../src/model-routing.ts'

const homes: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const profile = (model: string): ModelHostProfile => ({ version: 1, provider: 'openai-codex', driver: 'openai-codex-app-server', authMethod: 'subscription', runtimeProfile: '/fixture/account', model })
const custom = `# Keep the imported models and settings.
default_model = 'personal' # planner
shell_agent_model = "personal"
answer_model = "personal"
file_discovery_model = "personal"

[model_defaults]
cache_trigger_threshold = 4096
temperature = 1.0

[models.personal]
provider = "personal"
model = "original"
context_length = 200000
[models.personal.params.reasoning]
effort = "high"

[providers.personal]
transport = "model-host"
profile = "/fixture/other-profile.json"
command = "fixture-model-host"

[custom]
large = 9007199254740993
note = """
Keep this text.
default_model = "inside-multiline"
"""
`
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'routing-')); homes.push(home)
  const path = join(home, '.config/dearmachine/machtiani/config.toml')
  await mkdir(join(home, '.config/dearmachine/machtiani'), { recursive: true })
  await writeFile(path, custom, { mode: 0o600 })
  await protectPrivatePath(path, 0o600)
  await saveModelHostProfile(sharedModelPath(home), { ...profile('original'), selectionVersion: 1, overrides: { concierge: profile('concierge-original') } })
  return { home, path }
}

it.each(['concierge', 'planner', 'shell-agent', 'sync', 'default', 'all'] as ModelTarget[])('saves %s against imported direct routing and retains unrelated models', async target => {
  const { home, path } = await fixture()
  await saveModelSettings(home, target, profile('replacement'))
  const settings = (await loadModelSettings(home))!
  expect(effectiveModelProfile(settings, target === 'all' || target === 'default' ? 'planner' : target).model).toBe('replacement')
  const content = await readFile(path, 'utf8')
  if (target === 'concierge') { expect(content).toBe(custom); return }
  const doc = parse(content, { integersAsBigInt: true })
  const old = parse(custom, { integersAsBigInt: true })
  expect(doc.model_defaults).toEqual(old.model_defaults)
  expect(doc.custom).toEqual(old.custom)
  expect((doc.models as any).personal).toEqual((old.models as any).personal)
  expect((doc.providers as any).personal).toEqual((old.providers as any).personal)
  expect(content).toContain(custom.slice(custom.indexOf('[model_defaults]')))
  const selected = target === 'default' || target === 'all' ? ['planner', 'shell-agent', 'sync'] : [target]
  for (const component of selected) expect((doc.models as any)['dearmachine-' + component].model).toBe('@machtiani/' + component)
  expect(doc.default_model).toBe(selected.includes('planner') ? 'dearmachine-planner' : 'personal')
  expect(doc.shell_agent_model).toBe(selected.includes('shell-agent') ? 'dearmachine-shell-agent' : 'personal')
  const backups = (await readdir(join(home, '.config/dearmachine/machtiani'))).filter(name => name.includes('.before-model-selection-'))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(home, '.config/dearmachine/machtiani', backups[0]!), 'utf8')).toBe(custom)
  expect(await hasPrivatePermissions(join(home, '.config/dearmachine/machtiani', backups[0]!))).toBe(true)
  await saveModelSettings(home, target, profile('again'))
  expect(await readFile(path, 'utf8')).toBe(content)
})

it('changes Default without rerouting component overrides, and routes a component when reset to inherit', async () => {
  const { home, path } = await fixture()
  await saveModelHostProfile(sharedModelPath(home), { ...profile('original'), selectionVersion: 1, overrides: { planner: profile('fixed'), concierge: profile('fixed') } })
  await saveModelSettings(home, 'default', profile('new-default'))
  expect(parse(await readFile(path, 'utf8'), { integersAsBigInt: true }).default_model).toBe('personal')
  expect(effectiveModelProfile((await loadModelSettings(home))!, 'planner').model).toBe('fixed')
  await saveModelSettings(home, 'planner')
  expect(parse(await readFile(path, 'utf8'), { integersAsBigInt: true }).default_model).toBe('dearmachine-planner')
  expect(effectiveModelProfile((await loadModelSettings(home))!, 'planner').model).toBe('new-default')
})

it('does not overwrite an existing customized planner alias', async () => {
  const { home, path } = await fixture()
  await writeFile(path, custom + '\n[models.dearmachine-planner]\nprovider = "personal"\nmodel = "custom"\n')
  await saveModelSettings(home, 'planner', profile('replacement'))
  const doc = parse(await readFile(path, 'utf8'), { integersAsBigInt: true })
  expect(doc.default_model).toBe('dearmachine-planner-2')
  expect((doc.models as any)['dearmachine-planner'].model).toBe('custom')
})

it('rejects malformed TOML without exposing parser excerpts or modifying the selection', async () => {
  const { home, path } = await fixture()
  await writeFile(path, 'private_fixture_token = INVALID')
  const before = await readFile(sharedModelPath(home), 'utf8')
  await expect(saveModelSettings(home, 'all', profile('replacement'))).rejects.toThrow('could not be parsed')
  await expect(saveModelSettings(home, 'all', profile('replacement'))).rejects.not.toThrow('private_fixture_token')
  expect(await readFile(sharedModelPath(home), 'utf8')).toBe(before)
  // A malformed unrelated harness file still cannot block Concierge.
  await saveModelSettings(home, 'concierge', profile('replacement'))
  expect(effectiveModelProfile((await loadModelSettings(home))!, 'concierge').model).toBe('replacement')
})

it('restores the exact previous profile when the routing commit fails', async () => {
  const { home, path } = await fixture()
  const before = await readFile(sharedModelPath(home), 'utf8')
  vi.spyOn(routing, 'prepareModelRouting').mockResolvedValue({ commit: async () => { throw new Error('fixture write failure') } })
  await expect(saveModelSettings(home, 'all', profile('replacement'))).rejects.toThrow('previous model selection was restored')
  expect(await readFile(sharedModelPath(home), 'utf8')).toBe(before)
  expect(await readFile(path, 'utf8')).toBe(custom)
})

it('detects a configuration edit after preparation and leaves it intact', async () => {
  const { home, path } = await fixture()
  const change = await routing.prepareModelRouting(home, sharedModelPath(home), ['planner'])
  await writeFile(path, custom + '\n# concurrent edit\n')
  await expect(change!.commit()).rejects.toThrow('changed while')
  expect(await readFile(path, 'utf8')).toBe(custom + '\n# concurrent edit\n')
})

import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { upgradeManagedModelConfig } from '../src/model-config.ts'
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function fixture(extra = '') {
  const home = await mkdtemp(join(tmpdir(), 'model-config-')); homes.push(home)
  const path = join(home, '.config/dearmachine/machtiani/config.toml')
  const profile = join(home, '.config/machtiani/model-profile.json')
  await mkdir(join(home, '.config/dearmachine/machtiani'), { recursive: true })
  const content = `default_model = "dearmachine"
shell_agent_model = "dearmachine"
answer_model = "dearmachine"
file_discovery_model = "dearmachine"

[providers.dearmachine-host]
transport = "model-host"
profile = ${JSON.stringify(profile)}
command = "fixture-model-host"

[models.dearmachine]
provider = "dearmachine-host"
model = "legacy"
context_length = 131072
${extra}
[models.dearmachine.params.reasoning]
effort = "high"

[models.personal]
provider = "personal"
model = "untouched"
`
  await writeFile(path, content, { mode: 0o600 })
  return { home, path, profile, content }
}
it('upgrades generated legacy roles idempotently, removing stale model and reasoning without touching unrelated models', async () => {
  const f = await fixture()
  await upgradeManagedModelConfig(f.home, f.profile)
  const next = await readFile(f.path, 'utf8')
  expect(next).toContain('shell_agent_model = "dearmachine-shell-agent"')
  for (const component of ['planner', 'shell-agent', 'sync']) expect(next).toContain(`model = "@machtiani/${component}"`)
  expect(next).not.toContain('effort = "high"')
  expect(next).not.toContain('model = "legacy"')
  expect(next).toContain('[models.personal]\nprovider = "personal"\nmodel = "untouched"')
  await upgradeManagedModelConfig(f.home, f.profile)
  expect(await readFile(f.path, 'utf8')).toBe(next)
})
it('refuses to discard customized model parameters', async () => {
  const f = await fixture('temperature = 0.5')
  await expect(upgradeManagedModelConfig(f.home, f.profile)).rejects.toThrow('customized')
  expect(await readFile(f.path, 'utf8')).toBe(f.content)
})
it('refuses custom provider routing and role assignments without rewriting files', async () => {
  const f = await fixture()
  for (const content of [f.content.replace('transport = "model-host"', 'transport = "http"'), f.content.replace('shell_agent_model = "dearmachine"', 'shell_agent_model = "personal"')]) {
    await writeFile(f.path, content)
    await expect(upgradeManagedModelConfig(f.home, f.profile)).rejects.toThrow('customized')
    expect(await readFile(f.path, 'utf8')).toBe(content)
  }
})

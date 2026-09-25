import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nixUserConfiguration, prepareNixConfiguration, saveNixFeatures } from '../src/nix-configuration.ts'
import { NixFeaturesMissing } from '../src/nix-prerequisites.ts'
import { runInstallationWizard } from '../src/installation-wizard.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'nix-recovery-')); roots.push(home)
  const path = nixUserConfiguration(home, {})
  return { home, path, exited: new Promise<void>(() => {}), environment: {} }
}
it('creates a private config before first installation and does not duplicate settings', async () => {
  const { path } = await fixture()
  expect(await saveNixFeatures(path, ['nix-command', 'flakes'])).toEqual({ changed: true })
  expect(await readFile(path, 'utf8')).toBe('extra-experimental-features = nix-command flakes\n')
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await saveNixFeatures(path, ['nix-command', 'flakes'])).toEqual({ changed: false })
})
it('preserves comments, includes, other features, private settings and CRLF with a private backup', async () => {
  const { path } = await fixture(); await mkdir(join(path, '..'), { recursive: true })
  const original = '# existing configuration\r\ninclude other.conf\r\nextra-experimental-features = ca-derivations nix-command\r\naccess-tokens = fixture-private-setting'
  await writeFile(path, original, { mode: 0o644 })
  const result = await saveNixFeatures(path, ['flakes'])
  expect(await readFile(result.backup!, 'utf8')).toBe(original)
  expect((await stat(result.backup!)).mode & 0o777).toBe(0o600)
  expect(await readFile(path, 'utf8')).toBe(original + '\r\nextra-experimental-features = flakes\r\n')
  expect((await stat(path)).mode & 0o777).toBe(0o644)
})
it('adds features after a later assignment or include overrides earlier additions', async () => {
  for (const reset of ['experimental-features = ca-derivations', 'include overrides.conf']) {
    const { path } = await fixture(); await mkdir(join(path, '..'), { recursive: true })
    const original = `extra-experimental-features = nix-command flakes\n${reset}\n`
    await writeFile(path, original)
    await saveNixFeatures(path, ['nix-command', 'flakes'])
    expect(await readFile(path, 'utf8')).toBe(original + 'extra-experimental-features = nix-command flakes\n')
  }
})
it('preserves symlink-managed files and gives recovery guidance without printing contents', async () => {
  const { home, path } = await fixture(); await mkdir(join(path, '..'), { recursive: true })
  const target = join(home, 'managed.conf'); await writeFile(target, 'fixture-private-setting')
  await symlink(target, path)
  await expect(saveNixFeatures(path, ['flakes'])).rejects.toThrow('configuration manager')
  expect(await readFile(target, 'utf8')).toBe('fixture-private-setting')
  expect(await readdir(join(path, '..'))).toEqual(['nix.conf'])
})
it('respects XDG configuration and refuses to guess a custom Nix configuration list', () => {
  expect(nixUserConfiguration('/home/example', { XDG_CONFIG_HOME: '/custom/settings' })).toBe('/custom/settings/nix/nix.conf')
  expect(() => nixUserConfiguration('/home/example', { NIX_USER_CONF_FILES: '/custom/a:/custom/b' })).toThrow('NIX_USER_CONF_FILES')
})
it.each(['linux', 'darwin'] as const)('repairs a partial Nix installation and advances once on %s, then relaunches without another repair', async platform => {
  const f = await fixture()
  const check = vi.fn(async () => {
    if (await readFile(f.path, 'utf8').catch(() => '') === 'extra-experimental-features = nix-command flakes\n') return 'ready' as const
    throw new NixFeaturesMissing()
  })
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('nix').mockResolvedValueOnce('enable')
  const tui = { choose, addAssistant: vi.fn() }; const selection = { provider: 'fixture', model: 'fixture' }
  const model = vi.fn().mockResolvedValue(selection)
  expect(await runInstallationWizard(tui, true, f.exited, model,
    () => prepareNixConfiguration(tui, { ...f, check }), platform, false)).toMatchObject({ method: 'nix', selection })
  expect(model).toHaveBeenCalledOnce()
  expect(choose.mock.calls.filter(([prompt]) => prompt.includes('How would you like'))).toHaveLength(1)
  const reopened = { choose: vi.fn(), addAssistant: vi.fn() }
  await prepareNixConfiguration(reopened, { ...f, check })
  expect(reopened.choose).not.toHaveBeenCalled()
  expect(check).toHaveBeenCalledTimes(3)
})
it('saves requirements before Nix exists without claiming it was verified', async () => {
  const f = await fixture(); const tui = { choose: vi.fn().mockResolvedValue('enable'), addAssistant: vi.fn() }
  await prepareNixConfiguration(tui, { ...f, check: async () => 'absent' })
  expect(await readFile(f.path, 'utf8')).toContain('nix-command flakes')
  expect(tui.addAssistant).toHaveBeenCalledWith(expect.stringContaining('will install Nix and verify'))
})
it('keeps failed verification recoverable in the repair menu without duplicate edits', async () => {
  const f = await fixture(); const tui = { choose: vi.fn().mockResolvedValueOnce('enable').mockResolvedValueOnce('enable').mockResolvedValueOnce('back'), addAssistant: vi.fn() }
  expect(await prepareNixConfiguration(tui, { ...f, check: async () => { throw new NixFeaturesMissing() } })).toBe('back')
  expect(tui.addAssistant).toHaveBeenCalledWith(expect.stringContaining('Nix still reports missing features'))
  expect(await readFile(f.path, 'utf8')).toBe('extra-experimental-features = nix-command flakes\n')
  expect(await readdir(join(f.path, '..'))).toEqual(['nix.conf'])
})
it('allows backing out or exiting without modifying configuration', async () => {
  const f = await fixture(); const save = vi.fn()
  expect(await prepareNixConfiguration({ choose: vi.fn().mockResolvedValue('back'), addAssistant: vi.fn() }, { ...f, save, check: async () => { throw new NixFeaturesMissing() } })).toBe('back')
  expect(save).not.toHaveBeenCalled()
  expect(await prepareNixConfiguration({ choose: vi.fn(() => new Promise<string>(() => {})), addAssistant: vi.fn() }, { ...f, exited: Promise.resolve(), save, check: async () => 'absent' })).toBe('back')
  expect(save).not.toHaveBeenCalled()
})

it('keeps a failed save in the repair menu and allows retry after permissions are corrected', async () => {
  const f = await fixture()
  const check = vi.fn().mockRejectedValueOnce(new NixFeaturesMissing()).mockResolvedValue('ready')
  const save = vi.fn().mockRejectedValue(new Error('Could not save Nix settings: the configuration directory is not writable.'))
  const tui = { choose: vi.fn().mockResolvedValue('enable'), addAssistant: vi.fn() }
  await prepareNixConfiguration(tui, { ...f, check, save })
  expect(tui.addAssistant).toHaveBeenCalledWith(expect.stringContaining('not writable'))
  expect(check).toHaveBeenCalledTimes(2)
})
it('offers only retry and back for an unknown inspection failure', async () => {
  const f = await fixture(); const save = vi.fn()
  const tui = { choose: vi.fn().mockResolvedValue('back'), addAssistant: vi.fn() }
  await prepareNixConfiguration(tui, { ...f, save, check: async () => { throw new Error('Could not check Nix prerequisites.') } })
  expect(tui.choose.mock.calls[0]![1].map((choice: { value: string }) => choice.value)).toEqual(['retry', 'back'])
  expect(save).not.toHaveBeenCalled()
})

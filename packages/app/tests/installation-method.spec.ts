import { expect, it, vi } from 'vitest'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { chooseInstallationMethod, isNixOS } from '../src/installation-method.ts'

for (const platform of ['linux', 'darwin'] as const) {
  for (const prebuilt of [true, false]) {
    it(`offers exactly Nix and Standard on ${platform} (prebuilt=${prebuilt})`, async () => {
      const choose = vi.fn().mockResolvedValue('standard')
      expect(await chooseInstallationMethod({ choose, addAssistant: vi.fn() }, prebuilt, new Promise(() => {}), platform)).toBe('standard')
      expect(choose.mock.calls[0]?.[1].map((option: { label: string }) => option.label)).toEqual(['Nix', 'Standard'])
      expect(choose.mock.calls[0]?.[1].map((option: { value: string }) => option.value)).toEqual(['nix', 'standard'])
      expect(choose.mock.calls[0]?.[2]).toBe('nix')
    })
  }
}

it('returns to the preceding consent screen on Escape', async () => {
  const choose = vi.fn().mockRejectedValue(new InstallerChoiceBackError())
  expect(await chooseInstallationMethod({ choose, addAssistant: vi.fn() }, true, new Promise(() => {}))).toBe('back')
})
it('allows exit while a selection is pending', async () => {
  const choose = vi.fn().mockImplementation(() => new Promise(() => {}))
  expect(await chooseInstallationMethod({ choose, addAssistant: vi.fn() }, true, Promise.resolve())).toBeUndefined()
})
it('rejects the retired third choice', async () => {
  const choose = vi.fn().mockResolvedValue('container')
  await expect(chooseInstallationMethod({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}), 'darwin')).rejects.toThrow('invalid installation method')
})

for (const release of ['ID=nixos\n', 'ID="nixos"\n', "ID='nixos'\n"]) {
  it(`detects the exact NixOS identity ${JSON.stringify(release)}`, async () => {
    expect(await isNixOS('linux', async () => release)).toBe(true)
  })
}
it('does not infer NixOS from ID_LIKE, a name, or the presence of Nix', async () => {
  for (const release of ['ID=ubuntu\nID_LIKE=nixos\n', 'NAME=NixOS\nID=debian\n', 'ID=nixos-other\n', 'ID=$(echo nixos)\n']) {
    expect(await isNixOS('linux', async () => release)).toBe(false)
  }
})
it('uses the fallback only when /etc/os-release is absent', async () => {
  const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error(), { code: 'ENOENT' })).mockResolvedValue('ID=nixos\n')
  expect(await isNixOS('linux', read)).toBe(true)
  expect(read.mock.calls.map(call => call[0])).toEqual(['/etc/os-release', '/usr/lib/os-release'])
  expect(await isNixOS('linux', async () => { throw new Error('unreadable') })).toBe(false)
})
it('never reads Linux release information on macOS', async () => {
  const read = vi.fn()
  expect(await isNixOS('darwin', read)).toBe(false)
  expect(read).not.toHaveBeenCalled()
})
it('announces Nix on NixOS without opening a method menu', async () => {
  const tui = { choose: vi.fn(), addAssistant: vi.fn() }
  expect(await chooseInstallationMethod(tui, false, new Promise(() => {}), 'linux', true)).toBe('nix')
  expect(tui.choose).not.toHaveBeenCalled()
  expect(tui.addAssistant).toHaveBeenCalledExactlyOnceWith('Installation method: Nix')
})
for (const [platform, description] of [
  ['linux', 'Build using Docker. Install and run directly on this computer.'],
  ['darwin', 'Build directly on this Mac.'],
] as const) {
  it(`uses the agreed description and Nix default on ${platform}`, async () => {
    const choose = vi.fn().mockResolvedValue('nix')
    await chooseInstallationMethod({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}), platform)
    expect(choose.mock.calls[0]?.[1]).toEqual([
      { value: 'nix', label: 'Nix', description: 'Use Nix-managed packages (recommended). NixOS is not required.' },
      { value: 'standard', label: 'Standard', description },
    ])
    expect(choose.mock.calls[0]?.[2]).toBe('nix')
  })
}

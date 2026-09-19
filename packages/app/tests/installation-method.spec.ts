import { expect, it, vi } from 'vitest'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { chooseInstallationMethod } from '../src/installation-method.ts'

for (const platform of ['linux', 'darwin'] as const) {
  for (const prebuilt of [true, false]) {
    it(`offers exactly Nix and Standard on ${platform} (prebuilt=${prebuilt})`, async () => {
      const choose = vi.fn().mockResolvedValue('standard')
      expect(await chooseInstallationMethod({ choose }, prebuilt, new Promise(() => {}), platform)).toBe('standard')
      expect(choose.mock.calls[0]?.[1].map((option: { label: string }) => option.label)).toEqual(['Nix', 'Standard'])
      expect(choose.mock.calls[0]?.[1].map((option: { value: string }) => option.value)).toEqual(['nix', 'standard'])
      expect(choose.mock.calls[0]?.[2]).toBe('standard')
    })
  }
}

it('returns to the preceding consent screen on Escape', async () => {
  const choose = vi.fn().mockRejectedValue(new InstallerChoiceBackError())
  expect(await chooseInstallationMethod({ choose }, true, new Promise(() => {}))).toBe('back')
})
it('allows exit while a selection is pending', async () => {
  const choose = vi.fn().mockImplementation(() => new Promise(() => {}))
  expect(await chooseInstallationMethod({ choose }, true, Promise.resolve())).toBeUndefined()
})
it('rejects the retired third choice', async () => {
  const choose = vi.fn().mockResolvedValue('container')
  await expect(chooseInstallationMethod({ choose }, false, new Promise(() => {}), 'darwin')).rejects.toThrow('invalid installation method')
})

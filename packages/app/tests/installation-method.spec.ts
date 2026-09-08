import { expect, it, vi } from 'vitest'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { chooseInstallationMethod } from '../src/installation-method.ts'

it('offers Standard by default with an explicit Nix alternative', async () => {
  const choose = vi.fn().mockResolvedValue('standard')
  expect(await chooseInstallationMethod({ choose }, true, new Promise(() => {}))).toBe('standard')
  expect(choose.mock.calls[0]?.[2]).toBe('standard')
  expect(choose.mock.calls[0]?.[1].map((option: { value: string }) => option.value)).toEqual(['standard', 'nix'])
})

it('does not advertise missing prebuilt products from a Nix entrypoint', async () => {
  const choose = vi.fn()
  expect(await chooseInstallationMethod({ choose }, false, new Promise(() => {}))).toBe('nix')
  expect(choose).not.toHaveBeenCalled()
})

it('returns to the preceding consent screen on Escape', async () => {
  const choose = vi.fn().mockRejectedValue(new InstallerChoiceBackError())
  expect(await chooseInstallationMethod({ choose }, true, new Promise(() => {}))).toBe('back')
})

it('allows local exit while a selection is pending', async () => {
  const choose = vi.fn().mockImplementation(() => new Promise(() => {}))
  expect(await chooseInstallationMethod({ choose }, true, Promise.resolve())).toBeUndefined()
})

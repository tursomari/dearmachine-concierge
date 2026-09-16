import { expect, it, vi } from 'vitest'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { chooseInstallationMethod } from '../src/installation-method.ts'

it('offers Nix and Container build without requiring prebuilt products', async () => {
  const choose = vi.fn().mockResolvedValue('container')
  expect(await chooseInstallationMethod({ choose }, true, new Promise(() => {}))).toBe('container')
  expect(choose.mock.calls[0]?.[2]).toBe('container')
  expect(choose.mock.calls[0]?.[1].map((option: { value: string }) => option.value)).toEqual(['nix', 'container'])
})

it('offers the same methods from a source checkout', async () => {
  const choose = vi.fn().mockResolvedValue('container')
  expect(await chooseInstallationMethod({ choose }, false, new Promise(() => {}))).toBe('container')
  expect(choose.mock.calls[0]?.[1].map((option: { label: string }) => option.label)).toEqual(['Nix', 'Container build'])
})

it('returns to the preceding consent screen on Escape', async () => {
  const choose = vi.fn().mockRejectedValue(new InstallerChoiceBackError())
  expect(await chooseInstallationMethod({ choose }, true, new Promise(() => {}))).toBe('back')
})

it('allows local exit while a selection is pending', async () => {
  const choose = vi.fn().mockImplementation(() => new Promise(() => {}))
  expect(await chooseInstallationMethod({ choose }, true, Promise.resolve())).toBeUndefined()
})

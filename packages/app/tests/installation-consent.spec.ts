import { expect, it, vi } from 'vitest'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { installationConsent } from '../src/installation-consent.ts'

it.each(['yes', 'no'])('records the %s command preference with brief output as default', async choice => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce(choice)
  expect(await installationConsent({ choose, addAssistant: vi.fn() }, new Promise(() => {}))).toEqual({ showCommands: choice === 'yes' })
  expect(choose.mock.calls[1]?.[2]).toBe('no')
})

it('returns to installation consent on Escape without starting model setup', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockRejectedValueOnce(new InstallerChoiceBackError()).mockResolvedValueOnce('not-now')
  expect(await installationConsent({ choose, addAssistant: vi.fn() }, new Promise(() => {}))).toBeUndefined()
  expect(choose.mock.calls[2]?.[0]).toBe(choose.mock.calls[0]?.[0])
})

it('leaves a pending command-visibility question when local exit is requested', async () => {
  let exit!: () => void
  const exited = new Promise<void>(resolve => { exit = resolve })
  const choose = vi.fn().mockResolvedValueOnce('continue').mockImplementationOnce(() => { exit(); return new Promise(() => {}) })
  expect(await installationConsent({ choose, addAssistant: vi.fn() }, exited)).toBeUndefined()
})

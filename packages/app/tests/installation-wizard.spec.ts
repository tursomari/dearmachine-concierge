import { expect, it, vi } from 'vitest'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { runInstallationWizard } from '../src/installation-wizard.ts'

it('goes from provider back to installation method without repeating consent', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('yes')
    .mockResolvedValueOnce('standard').mockResolvedValueOnce('nix')
  const selection = { provider: 'fixture', model: 'fixture' }
  const model = vi.fn().mockRejectedValueOnce(new InstallerChoiceBackError()).mockResolvedValueOnce(selection)
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, true, new Promise(() => {}), model))
    .toEqual({ selection, method: 'nix', showCommands: true })
  expect(choose.mock.calls.map(call => call[0]).filter(message => message.includes('How would you like to install'))).toHaveLength(2)
  expect(choose).toHaveBeenCalledTimes(4)
})

it('returns from method selection to consent and can decline without opening a model', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no')
    .mockRejectedValueOnce(new InstallerChoiceBackError()).mockResolvedValueOnce('not-now')
  const model = vi.fn()
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, true, new Promise(() => {}), model)).toBeUndefined()
  expect(model).not.toHaveBeenCalled()
})

it('returns to consent from the provider menu when there is no method menu', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('not-now')
  const model = vi.fn().mockRejectedValueOnce(new InstallerChoiceBackError())
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}), model)).toBeUndefined()
  expect(model).toHaveBeenCalledTimes(1)
})

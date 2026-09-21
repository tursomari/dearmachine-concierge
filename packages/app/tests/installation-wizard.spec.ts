import { expect, it, vi } from 'vitest'
import { InstallerChoiceBackError } from '@dearmachine/machtiani-installer-tui'
import { runInstallationWizard } from '../src/installation-wizard.ts'

it('goes from provider back to installation method without repeating consent', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('yes')
    .mockResolvedValueOnce('standard').mockResolvedValueOnce('nix')
  const selection = { provider: 'fixture', model: 'fixture' }
  const model = vi.fn().mockRejectedValueOnce(new InstallerChoiceBackError()).mockResolvedValueOnce(selection)
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, true, new Promise(() => {}), model, undefined, 'linux', false))
    .toEqual({ selection, method: 'nix', showCommands: true })
  expect(choose.mock.calls.map(call => call[0]).filter(message => message.includes('How would you like to install'))).toHaveLength(2)
  expect(choose).toHaveBeenCalledTimes(4)
})

it('returns from method selection to consent and can decline without opening a model', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no')
    .mockRejectedValueOnce(new InstallerChoiceBackError()).mockResolvedValueOnce('not-now')
  const model = vi.fn()
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, true, new Promise(() => {}), model, undefined, 'linux', false)).toBeUndefined()
  expect(model).not.toHaveBeenCalled()
})

it('returns to method selection from the provider menu even without prebuilt products', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no')
    .mockResolvedValueOnce('standard').mockResolvedValueOnce('nix')
  const selection = { provider: 'fixture', model: 'fixture' }
  const model = vi.fn().mockRejectedValueOnce(new InstallerChoiceBackError()).mockResolvedValueOnce(selection)
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}), model, undefined, 'linux', false))
    .toEqual({ selection, method: 'nix', showCommands: false })
  expect(choose.mock.calls.filter(call => call[0].includes('How would you like to install'))).toHaveLength(2)
})

it('prepares the chosen runtime before model setup and allows another method after a build failure', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no')
    .mockResolvedValueOnce('standard').mockResolvedValueOnce('nix')
  const addAssistant = vi.fn()
  const calls: string[] = []
  const prepare = async (method: string) => {
    calls.push(method)
    if (method === 'standard') throw new Error('Docker is not available. Start Docker and try again.')
  }
  const selection = { provider: 'fixture', model: 'fixture' }
  const model = async () => { calls.push('model'); return selection }
  expect(await runInstallationWizard({ choose, addAssistant }, false, new Promise(() => {}), model, prepare, 'linux', false))
    .toEqual({ selection, method: 'nix', showCommands: false })
  expect(calls).toEqual(['standard', 'nix', 'model'])
  expect(addAssistant).toHaveBeenCalledWith(expect.stringContaining('Docker is not available'))
})

it('does not open model setup when the interface exits during a build', async () => {
  let exit!: () => void
  const exited = new Promise<void>(resolve => { exit = resolve })
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('standard')
  const model = vi.fn()
  const prepare = async () => { exit(); await Promise.resolve() }
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false, exited, model, prepare, 'linux', false)).toBeUndefined()
  expect(model).not.toHaveBeenCalled()
})

it('prepares Nix on macOS before opening model setup', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('nix')
  const prepare = vi.fn()
  const selection = { provider: 'fixture', model: 'fixture' }
  const model = vi.fn().mockResolvedValue(selection)
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}), model, prepare, 'darwin', false))
    .toEqual({ selection, method: 'nix', showCommands: false })
  expect(prepare).toHaveBeenCalledExactlyOnceWith('nix')
  expect(choose.mock.calls[2]?.[1].map((option: { value: string }) => option.value)).toEqual(['nix', 'standard'])
})

it('prepares Standard on macOS before provider configuration', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('standard')
  const calls: string[] = []
  const selection = { provider: 'fixture', model: 'fixture' }
  const result = await runInstallationWizard({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}),
    async () => { calls.push('model'); return selection }, async method => { calls.push(method) }, 'darwin', false)
  expect(result?.method).toBe('standard')
  expect(calls).toEqual(['standard', 'model'])
})

it('automatically prepares Nix on NixOS before model setup', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no')
  const calls: string[] = []
  const selection = { provider: 'fixture', model: 'fixture' }
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}),
    async () => { calls.push('model'); return selection }, async method => { calls.push(method) }, 'linux', true))
    .toEqual({ selection, method: 'nix', showCommands: false })
  expect(choose).toHaveBeenCalledTimes(2)
  expect(calls).toEqual(['nix', 'model'])
})
it('returns to consent after a NixOS prerequisite failure instead of retrying automatically', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('not-now')
  const model = vi.fn()
  const prepare = vi.fn().mockRejectedValue(new Error('Enable flakes, then retry.'))
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}), model, prepare, 'linux', true)).toBeUndefined()
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(model).not.toHaveBeenCalled()
})
it('backs out of model setup to consent on NixOS', async () => {
  const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('not-now')
  const model = vi.fn().mockRejectedValue(new InstallerChoiceBackError())
  expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false, new Promise(() => {}), model, undefined, 'linux', true)).toBeUndefined()
  expect(choose).toHaveBeenCalledTimes(3)
  expect(model).toHaveBeenCalledTimes(1)
})

for (const method of ['nix', 'standard'] as const) {
  it(`honors the ${method} Quick start after consent without another method choice`, async () => {
    const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no')
    const prepare = vi.fn()
    const selection = { provider: 'fixture', model: 'fixture' }
    const result = await runInstallationWizard({ choose, addAssistant: vi.fn() }, false,
      new Promise(() => {}), async () => selection, prepare, 'linux', false, method)
    expect(result).toEqual({ selection, method, showCommands: false })
    expect(prepare).toHaveBeenCalledExactlyOnceWith(method)
    expect(choose).toHaveBeenCalledTimes(2)
  })
  it(`returns to consent after ${method} Quick start preparation fails`, async () => {
    const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('not-now')
    const prepare = vi.fn().mockRejectedValue(new Error('Unavailable'))
    const model = vi.fn()
    expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false,
      new Promise(() => {}), model, prepare, 'linux', false, method)).toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(model).not.toHaveBeenCalled()
  })
  it(`returns from model selection to consent on the ${method} Quick start`, async () => {
    const choose = vi.fn().mockResolvedValueOnce('continue').mockResolvedValueOnce('no').mockResolvedValueOnce('not-now')
    const model = vi.fn().mockRejectedValue(new InstallerChoiceBackError())
    expect(await runInstallationWizard({ choose, addAssistant: vi.fn() }, false,
      new Promise(() => {}), model, undefined, 'darwin', false, method)).toBeUndefined()
    expect(model).toHaveBeenCalledTimes(1)
  })
}
it('rejects Standard on NixOS and Nix on native Windows before consent or preparation', async () => {
  const tui = { choose: vi.fn(), addAssistant: vi.fn() }
  const model = vi.fn()
  const prepare = vi.fn()
  await expect(runInstallationWizard(tui, false, new Promise(() => {}), model, prepare, 'linux', true, 'standard')).rejects.toThrow('NixOS')
  await expect(runInstallationWizard(tui, false, new Promise(() => {}), model, prepare, 'win32', false, 'nix')).rejects.toThrow('Windows')
  expect(tui.choose).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
})

import { expect, it, vi } from 'vitest'
import { submitInstallerMessage } from '../src/installer-conversation.ts'

it('does not blame the provider or send prompts after local startup failure', async () => {
  const say = vi.fn()
  const agent = { prompt: vi.fn().mockRejectedValue(new Error('closed process')) }
  await submitInstallerMessage('Is it installed?', 'unavailable', agent, say)
  expect(agent.prompt).not.toHaveBeenCalled()
  expect(say.mock.calls.flat().join(' ')).toContain('/status')
  expect(say.mock.calls.flat().join(' ')).not.toContain('provider is unavailable')
})

it('explains pending setup and forwards conversation only to a ready agent', async () => {
  const say = vi.fn()
  await submitInstallerMessage('hello', 'setup', undefined, say)
  expect(say.mock.calls.flat().join(' ')).toContain('setup menus')
  const agent = { prompt: vi.fn().mockResolvedValue(undefined) }
  await submitInstallerMessage('hello', 'ready', agent, say)
  expect(agent.prompt).toHaveBeenCalledWith('hello')
})

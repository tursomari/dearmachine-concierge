import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/dsh-plugin.ts'
import { ModelHost } from '../src/index.ts'
import { nativeConversationPrompt } from '../src/subscription-drivers.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each(['installer', 'management', 'task'])('preserves the %s caller through DSH generation', async mode => {
  vi.stubEnv('MACHTIANI_MODEL_PROFILE', '/fixture/model-profile.json')
  vi.stubEnv('MACHTIANI_AGENT_MODE', mode)
  let request: any
  vi.spyOn(ModelHost, 'open').mockResolvedValue({
    async * generate(value: any) { request = value; yield { type: 'finish', reason: 'stop' } },
  } as never)
  let adapter: any
  apply({ llm: { registerAdapter: (_providers: unknown, value: unknown) => { adapter = value } } } as never)
  for await (const _chunk of adapter.stream({ sessionId: 'fixture-session', model: 'fixture', messages: [] })) { /* drain */ }
  expect(request.caller).toBe(mode === 'management' ? 'concierge' : mode)
  expect(request.sessionId).toBe('fixture-session')
  expect(nativeConversationPrompt(request).text.includes('finish_installation')).toBe(mode === 'installer')
})

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
    async * generate(value: any) { request = value; yield { type: 'text-end', index: 0, text: 'Ready.' }; yield { type: 'finish', reason: 'stop' } },
  } as never)
  let adapter: any
  apply({ llm: { registerAdapter: (_providers: unknown, value: unknown) => { adapter = value } } } as never)
  for await (const _chunk of adapter.stream({ sessionId: 'fixture-session', model: 'fixture', messages: [] })) { /* drain */ }
  expect(request.caller).toBe(mode === 'management' ? 'concierge' : mode)
  expect(request.sessionId).toBe('fixture-session')
  expect(nativeConversationPrompt(request).text.includes('finish_installation')).toBe(mode === 'installer')
})

it.each([
  ['reasoning only', [{ type: 'reasoning-end', index: 0, text: 'Private deliberation' }], 'stop', 'EMPTY_RESPONSE'],
  ['blank answer', [{ type: 'text-end', index: 0, text: ' \n' }], 'stop', 'EMPTY_RESPONSE'],
  ['answer', [{ type: 'text-end', index: 0, text: 'Which backend would you like?' }], 'stop', undefined],
  ['tool call', [{ type: 'tool-end', index: 0, id: 'call-1', name: 'read', arguments: '{}' }], 'tool-calls', undefined],
  ['limited reasoning', [{ type: 'reasoning-end', index: 0, text: 'Private deliberation' }], 'max-tokens', undefined],
  ['cancelled', [], 'cancelled', undefined],
])('handles %s without treating a silent completion as success', async (_name, events, reason, code) => {
  vi.stubEnv('MACHTIANI_MODEL_PROFILE', '/fixture/model-profile.json')
  vi.spyOn(ModelHost, 'open').mockResolvedValue({
    async * generate() { yield* events; yield { type: 'finish', reason } },
  } as never)
  let adapter: any
  apply({ llm: { registerAdapter: (_providers: unknown, value: unknown) => { adapter = value } } } as never)
  const drain = async () => {
    const chunks = []
    for await (const chunk of adapter.stream({ model: 'fixture', messages: [] })) chunks.push(chunk)
    return chunks
  }
  if (code) await expect(drain()).rejects.toMatchObject({ code })
  else expect((await drain()).at(-1)?.type).toBe('finish')
})

import { expect, it } from 'vitest'
import { normalizeDshSessionEvent } from '../src/index.ts'

const call = (command: string) => ({ type: 'tool/call', data: {
  callId: 'shell-1', name: 'bash', arguments: JSON.stringify({ command, description: 'Inspect installation' }),
} })

it('keeps shell commands out of the default event and exposes them only after opting in', () => {
  const command = 'set -o pipefail\ndearmachine status | head -10'
  expect(normalizeDshSessionEvent(call(command))).not.toHaveProperty('command')
  expect(normalizeDshSessionEvent(call(command), { showCommands: true })).toMatchObject({ command })
})

it.each([
  'curl -H "Authorization: Bearer private-fixture-value" https://example.test',
  'export OPENROUTER_API_KEY=private-fixture-value',
  'client --api-key private-fixture-value',
  'client --password="private-fixture-value"',
  'curl https://user:private-fixture-value@example.test',
  'curl "https://example.test/?token=private-fixture-value"',
  'echo sk-fixture-private-value',
])('withholds credential-bearing command: %s', command => {
  const event = normalizeDshSessionEvent(call(command), { showCommands: true })
  expect(event).toMatchObject({ command: '[Command hidden: may contain a credential]' })
  expect(JSON.stringify(event)).not.toContain('private-fixture-value')
})

it('does not mistake credential-file references for credential values', () => {
  const command = 'AGENTMAIL_API_KEY_FILE="$HOME/.config/dearmachine/agentmail-key" dearmachine status'
  expect(normalizeDshSessionEvent(call(command), { showCommands: true })).toMatchObject({ command })
})

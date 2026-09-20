import { describe, expect, it } from 'vitest'
import { localHelpForPlatform } from '../src/concierge-shell.ts'
describe('Windows management help', () => {
  it('explains sign-in startup and keeps the supported native lifecycle commands', () => {
    const help = localHelpForPlatform('win32')
    expect(help).toContain('dearmachine persistence on|off|status')
    expect(help).toContain('does not run before sign-in')
    expect(help).toContain('dearmachine down')
    expect(help).not.toMatch(/systemctl|loginctl|enable-linger|launchd/u)
  })
})

import { describe, expect, it } from 'vitest'
import { credentialRuntimeContext } from '../src/credential-context.ts'

describe('credential and preparation capabilities', () => {
  it('keeps credential entry generic and explicitly scopes preparation to Forge 2.13.21', () => {
    const context = credentialRuntimeContext('/private/credential-helper.mjs')
    expect(context.credentialHelper.backendProvider.slice(-2)).toEqual(['backend-provider', '<selected backend provider>'])
    expect(context.credentialHelper.machtianiProvider.slice(-3)).toEqual(['machtiani-provider', '<exact Machtiani provider alias>', '--use-existing'])
    expect(context.credentialHelper.replaceMachtianiProvider.at(-1)).toBe('--replace')
    expect(context.credentialHelper.replaceBackendProvider.at(-1)).toBe('--replace')
    expect(context).not.toHaveProperty('backendPreparation')
    expect(context.backendPreparations).toEqual({
      forge: {
        supportedVersion: '2.13.21',
        invocation: [process.execPath, expect.stringMatching(/\/bin\.mjs$/), 'prepare-forge-2.13.21'],
        makesProviderRequest: true,
      },
    })
  })
})

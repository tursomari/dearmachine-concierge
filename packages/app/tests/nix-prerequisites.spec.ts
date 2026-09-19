import { expect, it } from 'vitest'
import { checkNixPrerequisites, nixFeatureGuidance } from '../src/nix-prerequisites.ts'

it('accepts both feature settings without requesting configuration changes', async () => {
  for (const value of [['nix-command', 'flakes'], 'nix-command flakes']) {
    await expect(checkNixPrerequisites(async () => JSON.stringify({ 'experimental-features': { value } }))).resolves.toBeUndefined()
  }
})
it('explains missing features without exposing unrelated private Nix settings', async () => {
  for (const value of [[], ['nix-command'], ['flakes']]) {
    await expect(checkNixPrerequisites(async () => JSON.stringify({ 'experimental-features': { value }, 'access-tokens': { value: 'fake-private-token' } })))
      .rejects.toThrow(nixFeatureGuidance)
  }
})
it('recognizes a disabled nix-command interface', async () => {
  await expect(checkNixPrerequisites(async () => { throw { stderr: "error: experimental Nix feature 'nix-command' is disabled" } })).rejects.toThrow(nixFeatureGuidance)
})
it('leaves installation consent to guided setup when Nix is absent', async () => {
  await expect(checkNixPrerequisites(async () => { throw { code: 'ENOENT' } })).resolves.toBeUndefined()
})
it('does not echo raw diagnostics for other failures or invalid configuration', async () => {
  await expect(checkNixPrerequisites(async () => { throw { stderr: 'fake-private-token', code: 'EACCES' } })).rejects.toThrow('Could not check Nix prerequisites')
  await expect(checkNixPrerequisites(async () => 'fake-private-token')).rejects.toThrow('Could not read Nix feature settings')
})

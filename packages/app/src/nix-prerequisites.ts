import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const nixFeatureGuidance = 'This installer requires Nix flakes and the Nix command interface. Add `extra-experimental-features = nix-command flakes` to your Nix user configuration (normally ~/.config/nix/nix.conf), then retry.'

export class NixFeaturesMissing extends Error {
  constructor(readonly missing: readonly string[] = ['nix-command', 'flakes']) { super(nixFeatureGuidance) }
}

/** Inspect without changing Nix configuration or exposing its other settings. */
export async function checkNixPrerequisites(
  inspect: () => Promise<string> = async () => (await execute('nix', ['show-config', '--json'],
    { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout,
): Promise<'ready' | 'absent'> {
  let output: string
  try { output = await inspect() } catch (error) {
    // The existing guided setup owns consent and installation when Nix is absent.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    const diagnostic = (error as { stderr?: unknown }).stderr
    if (typeof diagnostic === 'string' && /experimental Nix feature ['"](?:nix-command|flakes)['"] is disabled/u.test(diagnostic)) {
      throw new NixFeaturesMissing()
    }
    throw new Error('Could not check Nix prerequisites. Verify that `nix --version` works, then retry.')
  }
  let features: unknown
  try { features = JSON.parse(output)['experimental-features']?.value } catch {
    throw new Error('Could not read Nix feature settings. Verify that `nix show-config --json` works, then retry.')
  }
  const enabled = typeof features === 'string' ? features.split(/\s+/u) : Array.isArray(features) ? features : []
  const missing = ['nix-command', 'flakes'].filter(feature => !enabled.includes(feature))
  if (missing.length) throw new NixFeaturesMissing(missing)
  return 'ready'
}

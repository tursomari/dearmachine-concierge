import { execFile } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import type { CredentialReference } from '@dearmachine/machtiani-installer-credentials'
import { installedMachtianiCommand } from './machtiani-command.ts'

/** Reuse the native configuration writer; no credential values enter argv or output. */
export class MachtianiCredentialTarget {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async check(provider: string): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(provider)) throw new Error('Use the exact Machtiani provider alias, such as deepseek')
    const output = await this.run(['config', 'provider', 'show', provider])
    if (/^\s*transport:\s*model-host\s*$/mu.test(output)) {
      throw new Error('This Machtiani provider uses a model-host profile; configure that profile instead of replacing its credential with an environment reference')
    }
  }

  async configure(provider: string, reference: CredentialReference): Promise<void> {
    if (reference.format !== 'environment' || !reference.variable || !/^[A-Z_][A-Z0-9_]*$/u.test(reference.variable)) throw new Error('Machtiani requires a saved provider environment reference')
    await this.check(provider)
    await this.run(['config', 'provider', 'set', provider, '--api-key-env', reference.variable, '--credentials-file', reference.destination, '--no-interactive'])
  }

  private async run(args: string[]): Promise<string> {
    const home = this.environment.HOME
    if (!home || !isAbsolute(home)) throw new Error('An absolute HOME is required for Machtiani credential configuration')
    // The public command belongs to the installation. Do not use an arbitrary
    // backend executable or a different project config selected by the shell.
    const executable = await installedMachtianiCommand(home, this.environment)
    return new Promise((resolve, reject) => {
      execFile(executable, args, {
        cwd: home, env: { ...this.environment, MACHTIANI_CONFIG: join(home, '.config/dearmachine/machtiani/config.toml'), MACHTIANI_UPDATE_REEXEC: '1' }, timeout: 15_000, maxBuffer: 65_536, windowsHide: true,
      }, (error, stdout) => {
        // Native failures can contain private configuration. Never forward them.
        if (error) reject(new Error('Machtiani provider configuration failed; inspect the provider alias with machtiani config provider show with DearMachine’s MACHTIANI_CONFIG'))
        else resolve(stdout)
      })
    })
  }
}

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { BackendPort, EnvironmentPort, EnvironmentReport } from '@dearmachine/machtiani-installer-workflow'

const foundations = [
  { name: 'Nix', command: 'nix', package: undefined },
  { name: 'Git', command: 'git', package: 'nixpkgs#git' },
  { name: 'Git LFS', command: 'git-lfs', package: 'nixpkgs#git-lfs' },
] as const

async function available(command: string, pathValue: string): Promise<boolean> {
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    try { await access(join(directory, command), constants.X_OK); return true } catch { /* keep searching */ }
  }
  return false
}

export interface EnvironmentAdapterOptions {
  backends: Pick<BackendPort, 'discover'>
  environment?: NodeJS.ProcessEnv
}

export class LocalEnvironmentAdapter implements EnvironmentPort {
  constructor(private readonly options: EnvironmentAdapterOptions) {}

  async inspect(): Promise<EnvironmentReport> {
    const environment = { ...process.env, ...this.options.environment }
    const pathValue = environment.PATH ?? ''
    const missingFoundations: string[] = []
    for (const foundation of foundations) {
      if (!await available(foundation.command, pathValue)) missingFoundations.push(foundation.name)
    }
    return {
      missingFoundations,
      detectedBackends: (await this.options.backends.discover()).map(candidate => candidate.name),
    }
  }

  async installFoundations(names: readonly string[]): Promise<void> {
    const selected = foundations.filter(foundation => names.includes(foundation.name))
    if (selected.some(foundation => foundation.name === 'Nix')) {
      throw new Error('Nix must be installed by the bootstrap before Machtiani Installer starts.')
    }
    const packages = selected.flatMap(foundation => foundation.package === undefined ? [] : [foundation.package])
    if (packages.length === 0) return
    const result = await run(['nix', 'profile', 'install', ...packages], { ...process.env, ...this.options.environment })
    if (result !== 0) throw new Error(`Nix could not install the foundational tools (status ${result ?? 'unknown'}).`)
  }
}

async function run(command: readonly string[], environment: NodeJS.ProcessEnv): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = `${diagnostic}${String(chunk)}`.slice(-16_384) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(code) : reject(new Error(diagnostic.trim() || `command exited with status ${code ?? 'unknown'}`)))
  })
}

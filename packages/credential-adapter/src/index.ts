import { spawn } from 'node:child_process'
import { access, lstat, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type CredentialKind = 'llm' | 'email'

export interface CredentialReference {
  kind: CredentialKind
  helperName: 'enter-llm-key' | 'enter-email-key'
  destination: string
  format: 'environment' | 'raw'
  variable?: string
}

const providerVariables: Readonly<Record<string, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'deepseek official': 'DEEPSEEK_API_KEY',
}

const transportIds: Readonly<Record<string, string>> = {
  agentmail: 'agentmail',
  openmail: 'openmail',
  sendmux: 'sendmux',
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ')
}

export function resolveCredentialReference(kind: CredentialKind, selection: string, home: string): CredentialReference {
  if (kind === 'llm') {
    const variable = providerVariables[normalized(selection)]
    if (variable === undefined) throw new Error(`Machtiani Installer does not yet know the credential variable for ${selection}.`)
    return {
      kind,
      helperName: 'enter-llm-key',
      destination: join(home, '.config', 'dearmachine', 'backends.env'),
      format: 'environment',
      variable,
    }
  }
  const transport = transportIds[normalized(selection)]
  if (transport === undefined) throw new Error(`Machtiani Installer does not yet know the credential path for ${selection}.`)
  return {
    kind,
    helperName: 'enter-email-key',
    destination: join(home, '.config', 'dearmachine', `${transport}-api-key`),
    format: 'raw',
  }
}

export interface CredentialAdapterOptions {
  home: string
  environment?: NodeJS.ProcessEnv
  helperPath?: string
}

export class CredentialHelperAdapter {
  private readonly helperPath: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly references = new Map<CredentialKind, CredentialReference>()

  constructor(private readonly options: CredentialAdapterOptions) {
    this.helperPath = options.helperPath ?? fileURLToPath(new URL('../../../assets/credential-entry.sh', import.meta.url))
    this.environment = { ...process.env, ...options.environment, HOME: options.home }
  }

  async prepare(kind: CredentialKind, selection: string): Promise<'ready' | 'pending'> {
    const reference = resolveCredentialReference(kind, selection, this.options.home)
    this.references.set(kind, reference)
    if (await this.referenceExists(reference)) return 'ready'
    if (await this.preparedSpecMatches(reference)) return 'pending'
    const args = ['prepare', '--name', reference.helperName, '--destination', reference.destination, '--format', reference.format]
    if (reference.variable !== undefined) args.push('--variable', reference.variable)
    await this.run(args)
    return 'pending'
  }

  async status(kind: CredentialKind): Promise<'ready' | 'pending'> {
    const reference = this.references.get(kind)
    if (reference === undefined) throw new Error(`the ${kind} credential helper has not been prepared`)
    const output = (await this.run(['status', '--name', reference.helperName])).trim()
    if (output !== 'ready' && output !== 'pending') throw new Error(`unexpected ${reference.helperName} status`)
    if (output === 'ready') await this.verifyReference(reference)
    return output
  }

  reference(kind: CredentialKind): CredentialReference | undefined {
    const reference = this.references.get(kind)
    return reference === undefined ? undefined : { ...reference }
  }

  private async verifyReference(reference: CredentialReference): Promise<void> {
    await access(reference.destination, constants.R_OK)
    const metadata = await lstat(reference.destination)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || (metadata.mode & 0o077) !== 0 || !ownedByCurrentUser(metadata.uid)) {
      throw new Error(`${reference.helperName} did not create a nonempty private credential file`)
    }
    if (reference.format === 'environment') {
      const content = await readFile(reference.destination, 'utf8')
      const prefix = `${reference.variable}=`
      if (!content.startsWith(prefix) || content.slice(prefix.length).trim() === '') {
        throw new Error(`${reference.helperName} did not create the expected credential reference`)
      }
    } else {
      const content = await readFile(reference.destination, 'utf8')
      if (content.trim() === '' || /\s/u.test(content.trim())) {
        throw new Error(`${reference.helperName} did not create a valid one-line credential`)
      }
    }
  }

  private async referenceExists(reference: CredentialReference): Promise<boolean> {
    try {
      const metadata = await lstat(reference.destination)
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || !ownedByCurrentUser(metadata.uid)) {
        throw new Error(`${reference.helperName} credential destination is not a private regular file`)
      }
      const content = await readFile(reference.destination, 'utf8')
      if (reference.format === 'environment') {
        const prefix = `${reference.variable}=`
        return content.startsWith(prefix) && content.slice(prefix.length).trim() !== ''
      }
      return content.trim() !== '' && !/\s/u.test(content.trim())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async preparedSpecMatches(reference: CredentialReference): Promise<boolean> {
    const stateRoot = this.environment.XDG_STATE_HOME || join(this.options.home, '.local', 'state')
    const specPath = join(stateRoot, 'dearmachine', 'installation', `${reference.helperName}.spec`)
    const executable = join(this.options.home, '.local', 'bin', reference.helperName)
    try {
      await access(executable, constants.X_OK)
      const metadata = await lstat(specPath)
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || !ownedByCurrentUser(metadata.uid)) {
        throw new Error(`${reference.helperName} specification is not private`)
      }
      const expected = `destination=${reference.destination}\nformat=${reference.format}\nvariable=${reference.variable ?? ''}\n`
      return await readFile(specPath, 'utf8') === expected
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async run(args: readonly string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [...args], {
        env: this.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve(stdout)
        else reject(new Error(stderr.trim() || `${this.helperPath} exited with status ${code ?? 'unknown'}`))
      })
    })
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid()
}

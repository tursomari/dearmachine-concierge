import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'

export type CredentialKind = 'backend-provider' | 'machtiani-provider' | 'email'

export interface CredentialReference {
  kind: CredentialKind
  destination: string
  format: 'environment' | 'raw'
  variable?: string
}

const providerVariables: Readonly<Record<string, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  'open router': 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'deep seek': 'DEEPSEEK_API_KEY',
  'deepseek official': 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
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
  if (kind === 'backend-provider' || kind === 'machtiani-provider') {
    const label = selection.trim().toLowerCase().replace(/ +/gu, ' ')
    if (!/^[a-z0-9][a-z0-9 ._-]{0,159}$/u.test(label) || label.includes('..')) {
      throw new Error('Backend provider label must be 1–160 printable letters, numbers, spaces, dots, hyphens or underscores.')
    }
    // Unknown providers get a stable application-owned namespace, not an
    // arbitrary shell variable or a shared OpenAI slot. Hashing distinguishes
    // labels whose punctuation would otherwise collapse to the same slug.
    const variable = providerVariables[normalized(selection)] ??
      `MACHTIANI_BACKEND_${label.replace(/[^a-z0-9]/gu, '_').slice(0,40).toUpperCase()}_${createHash('sha256').update(label).digest('hex').slice(0,16).toUpperCase()}_API_KEY`
    return {
      kind,
      destination: kind === 'machtiani-provider' ? join(home, '.config', 'dearmachine', 'machtiani', 'credentials.env') : join(home, '.config', 'dearmachine', 'backends.env'),
      format: 'environment',
      variable,
    }
  }
  const transport = transportIds[normalized(selection)]
  if (transport === undefined) throw new Error(`Machtiani Installer does not yet know the credential path for ${selection}.`)
  return {
    kind,
    destination: join(home, '.config', 'dearmachine', `${transport}-api-key`),
    format: 'raw',
  }
}

export interface CredentialAdapterOptions { home: string }

/** Stores transcript-free TUI input in the private files consumed by Dear Machine. */
export class CredentialFileAdapter {
  private readonly references = new Map<CredentialKind, CredentialReference>()

  constructor(private readonly options: CredentialAdapterOptions) {}

  async prepare(kind: CredentialKind, selection: string): Promise<'ready' | 'pending'> {
    const reference = resolveCredentialReference(kind, selection, this.options.home)
    this.references.set(kind, reference)
    return await this.referenceExists(reference) ? 'ready' : 'pending'
  }

  async save(kind: CredentialKind, value: string): Promise<void> {
    const reference = this.references.get(kind)
    if (reference === undefined) throw new Error(`the ${kind} credential destination has not been prepared`)
    validateCredential(value)
    await this.writeReference(reference, value)
    await this.verifyReference(reference)
  }

  reference(kind: CredentialKind): CredentialReference | undefined {
    const reference = this.references.get(kind)
    return reference === undefined ? undefined : { ...reference }
  }

  private async writeReference(reference: CredentialReference, value: string): Promise<void> {
    const destinationDirectory = dirname(reference.destination)
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
    await assertPrivateDestinationDirectory(this.options.home, destinationDirectory)
    try {
      const current = await lstat(reference.destination)
      if (!current.isFile() || current.isSymbolicLink() || !ownedByCurrentUser(current.uid)) {
        throw new Error('credential destination must be a regular file owned by the current user')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const temporary = join(destinationDirectory, `.machtiani-credential-${process.pid}-${randomUUID()}`)
    let handle
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      const content = reference.format === 'environment'
        ? await updatedEnvironmentContent(reference.destination, reference.variable!, value)
        : `${value}\n`
      await handle.writeFile(content, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await chmod(temporary, 0o600)
      await rename(temporary, reference.destination)
    } catch (error) {
      await handle?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  private async verifyReference(reference: CredentialReference): Promise<void> {
    await access(reference.destination, constants.R_OK)
    const metadata = await lstat(reference.destination)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || (metadata.mode & 0o077) !== 0 || !ownedByCurrentUser(metadata.uid)) {
      throw new Error('credential input did not create a nonempty private credential file')
    }
    const content = await readFile(reference.destination, 'utf8')
    if (reference.format === 'environment') {
      const stored = parseEnvironment(content).get(reference.variable!)
      if (stored === undefined || stored === '') {
        throw new Error('credential input did not create the expected credential reference')
      }
    } else if (content.trim() === '' || /\s/u.test(content.trim())) {
      throw new Error('credential input did not create a valid one-line credential')
    }
  }

  private async referenceExists(reference: CredentialReference): Promise<boolean> {
    try {
      const metadata = await lstat(reference.destination)
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || !ownedByCurrentUser(metadata.uid)) {
        throw new Error('credential destination is not a private regular file')
      }
      const content = await readFile(reference.destination, 'utf8')
      if (reference.format === 'environment') {
        const stored = parseEnvironment(content).get(reference.variable!)
        return stored !== undefined && stored !== ''
      }
      return content.trim() !== '' && !/\s/u.test(content.trim())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
}

function parseEnvironment(content: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of content.split(/\r?\n/gu)) {
    if (line === '') continue
    const match = /^([A-Z_][A-Z0-9_]*)=(\S+)$/u.exec(line)
    if (match === null) throw new Error('provider credential file contains an invalid assignment')
    if (values.has(match[1]!)) throw new Error(`provider credential file contains duplicate assignment ${match[1]}`)
    values.set(match[1]!, match[2]!)
  }
  return values
}

async function updatedEnvironmentContent(destination: string, variable: string, value: string): Promise<string> {
  let content = ''
  try {
    content = await readFile(destination, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const values = parseEnvironment(content)
  values.set(variable, value)
  return [...values].map(([name, stored]) => `${name}=${stored}`).join('\n') + '\n'
}

function validateCredential(value: string): void {
  if (value === '' || value.length > 16_384 || /\s/u.test(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('API key must be one nonempty line without whitespace')
  }
}

async function assertPrivateDestinationDirectory(home: string, destinationDirectory: string): Promise<void> {
  const [resolvedHome, resolvedDirectory] = await Promise.all([realpath(home), realpath(destinationDirectory)])
  const fromHome = relative(resolvedHome, resolvedDirectory)
  if (fromHome === '..' || fromHome.startsWith(`..${sep}`) || fromHome === '') {
    throw new Error('credential destination must remain beneath HOME')
  }
  const metadata = await lstat(destinationDirectory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata.uid)) {
    throw new Error('credential destination directory must be owned by the current user and must not be a symbolic link')
  }
  if ((metadata.mode & 0o077) !== 0) await chmod(destinationDirectory, 0o700)
}

function ownedByCurrentUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid()
}

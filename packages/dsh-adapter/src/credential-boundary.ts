import { hasPrivatePermissions, protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { constants } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const CREDENTIAL_BLOCKED = 'Credential access or output was blocked. Use the secure credential helper and its non-secret receipt; do not inspect or print saved credentials.'
export const CREDENTIAL_UNAVAILABLE = 'Credential protection is unavailable. No tool or model request was permitted.'

/** Trusted in-process inspection only. Values never leave this object as data. */
export class CredentialBoundary {
  private readonly files = new Map<string, 'environment' | 'raw'>()
  private readonly values = new Set<string>()

  constructor(private readonly options: { home: string; profile?: string; environment: NodeJS.ProcessEnv }) {
    if (!isAbsolute(options.home)) throw new Error(CREDENTIAL_UNAVAILABLE)
    const config = join(options.home, '.config', 'dearmachine')
    this.files.set(join(config, 'backends.env'), 'environment')
    this.files.set(join(config, 'machtiani', 'credentials.env'), 'environment')
    this.files.set(join(options.environment.XDG_CONFIG_HOME || join(options.home, '.config'), 'machtiani', 'credentials.env'), 'environment')
    for (const transport of ['agentmail', 'openmail', 'sendmux']) this.files.set(join(config, `${transport}-api-key`), 'raw')
    for (const [name, value] of Object.entries(options.environment)) {
      if (/(?:API_?KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/iu.test(name) && value) this.remember(value)
    }
  }

  private remember(value: string): void {
    if (!value) return
    for (const variant of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
      Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
      Buffer.from(value).toString('hex'), Buffer.from(value).toString('hex').toUpperCase()]) this.values.add(variant)
  }

  /** Refresh before and after tools: masked entry can add or rotate a key mid-turn. */
  async refresh(): Promise<void> {
    try {
      if (this.options.profile) {
        const profile = JSON.parse(await readFile(this.options.profile, 'utf8')) as { credential?: { kind?: string; path?: string } }
        if (profile.credential) {
          if (profile.credential.kind !== 'environment-file' || typeof profile.credential.path !== 'string' || !isAbsolute(profile.credential.path)) throw new Error()
          this.files.set(profile.credential.path, 'environment')
        }
      }
      for (const [path, format] of this.files) {
        let handle
        try {
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          const metadata = await handle.stat()
          if (!metadata.isFile() || metadata.size > 1_048_576 || !await hasPrivatePermissions(path) ||
            (process.getuid && metadata.uid !== process.getuid())) throw new Error()
          const text = await handle.readFile('utf8')
          if (format === 'raw') this.remember(text.trim())
          else for (const line of text.split(/\r?\n/u)) {
            if (!line.trim() || line.trimStart().startsWith('#')) continue
            const match = /^([A-Z_][A-Z0-9_]*)=(\S+)$/u.exec(line)
            if (!match) throw new Error()
            this.remember(match[2]!)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        } finally { await handle?.close() }
      }
    } catch { throw new Error(CREDENTIAL_UNAVAILABLE) }
  }

  containsCredential(value: unknown): boolean {
    // Scan every field, not just display text: DSH retains value/meta/error and
    // additional contexts separately. Joining strings also catches split output.
    const strings: string[] = []
    let encoded: string
    try {
      encoded = JSON.stringify(value, (key, item: unknown) => {
        strings.push(key)
        if (typeof item === 'string') strings.push(item)
        return item
      }) ?? ''
    } catch { return true }
    const joined = strings.join('')
    const compact = joined.replace(/\s/gu, '')
    const includes = (text: string) => [...this.values].some(secret => text.includes(secret))
    if (includes(encoded) || includes(joined) || includes(compact)) return true
    // Base64 of a whole environment file need not contain base64(key): the
    // assignment prefix changes byte alignment. Decode candidate runs locally.
    for (const text of strings) for (const token of text.replace(/\s/gu, '').matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/gu)) {
      if (includes(Buffer.from(token[0], 'base64').toString('utf8'))) return true
    }
    return false
  }

  async protectedPath(path: string, cwd: string): Promise<boolean> {
    const absolute = resolve(cwd, path.startsWith('~/') ? join(this.options.home, path.slice(2)) : path)
    const canonical = await realpath(absolute).catch(() => absolute)
    const identity = await stat(absolute).catch(() => undefined)
    for (const file of this.files.keys()) {
      const target = await realpath(file).catch(() => file)
      if (absolute === file || canonical === target) return true
      // Catch hard links as well as symlinks without opening the requested file.
      if (identity) {
        const protectedIdentity = await stat(file).catch(() => undefined)
        if (protectedIdentity?.dev === identity.dev && protectedIdentity.ino === identity.ino) return true
      }
      // A renamed/missing leaf beneath a symlinked credential directory.
      if (dirname(absolute) !== dirname(file) &&
        await realpath(dirname(absolute)).catch(() => '') === dirname(target) &&
        absolute.slice(absolute.lastIndexOf('/') + 1) === file.slice(file.lastIndexOf('/') + 1)) return true
    }
    return false
  }
}

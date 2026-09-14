import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

export function machtianiConfigPath(home: string): string {
 return join(home, '.config/dearmachine/machtiani/config.toml')
}

/** Upgrade the former shared configuration once; never change the personal copy. */
export async function migrateMachtianiConfig(environment: NodeJS.ProcessEnv): Promise<void> {
 const home = environment.HOME
 if (!home) return
 const destination = machtianiConfigPath(home)
 const exists = async (path: string) => access(path).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return false
  throw error
 })
 if (await exists(destination) || !await exists(join(home, '.dearmachine/config/runtime.toml'))) return
 const source = join(home, '.machtiani/config.toml')
 if (!await exists(source)) return
 const args = ['config', 'import', '--source', source]
 const credentials = join(home, '.config/dearmachine/backends.env')
 if (await exists(credentials)) args.push('--credentials-file', credentials)
 await new Promise<void>((resolve, reject) => {
  execFile(join(home,'.local/bin/machtiani'), args, {
   env: { ...environment, MACHTIANI_CONFIG: destination, MACHTIANI_UPDATE_REEXEC: '1' },
   cwd: home, timeout: 15_000, maxBuffer: 65_536,
  }, error => error ? reject(new Error('Could not migrate the legacy Machtiani configuration into DearMachine’s private configuration.')) : resolve())
 })
}

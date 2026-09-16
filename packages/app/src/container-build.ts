import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadDistribution, type ProductDistribution } from '@dearmachine/machtiani-installer-products'

/** The same production builder serves the wizard, bootstrap and acceptance gates. */
export async function buildContainerDistribution(options: {
  sourceRoot: string
  diagnosticPath: string
  signal: AbortSignal
  environment?: NodeJS.ProcessEnv
}): Promise<ProductDistribution> {
  options.signal.throwIfAborted()
  await mkdir(dirname(options.diagnosticPath), { recursive: true, mode: 0o700 })
  const log = createWriteStream(options.diagnosticPath, { flags: 'w', mode: 0o600 })
  let logError: Error | undefined
  log.on('error', error => { logError = error })
  const environment = options.environment ?? process.env
  let output = ''
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('python3', [join(options.sourceRoot, 'scripts/container-build.py'),
        '--source-root', options.sourceRoot, '--json'], {
        env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      })
      let escalation: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const stop = () => {
        if (finished || child.pid === undefined) return
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already exited. */ }
        escalation = setTimeout(() => {
          if (!finished && child.pid !== undefined) {
            try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
          }
        }, 10_000)
      }
      options.signal.addEventListener('abort', stop, { once: true })
      if (options.signal.aborted) stop()
      child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-65_536) })
      child.stderr.on('data', chunk => { log.write(chunk) })
      child.once('error', reject)
      child.once('close', code => {
        finished = true
        clearTimeout(escalation)
        options.signal.removeEventListener('abort', stop)
        if (options.signal.aborted) reject(new Error('Container build cancelled. Choose an installation method to continue.'))
        else if (code !== 0 || logError) reject(new Error(`Container build failed. Check Docker and the build log at ${options.diagnosticPath}, then choose a method to retry.`))
        else resolve()
      })
    })
  } finally {
    await new Promise<void>(resolve => { log.end(resolve) })
  }
  const receipt = JSON.parse(output) as { manifest?: unknown }
  if (typeof receipt.manifest !== 'string') throw new Error('Container build returned no installation manifest.')
  const distribution = await loadDistribution({ MACHTIANI_DISTRIBUTION: receipt.manifest })
  if (distribution?.method !== 'container') throw new Error('Container build returned an invalid distribution.')
  return distribution
}

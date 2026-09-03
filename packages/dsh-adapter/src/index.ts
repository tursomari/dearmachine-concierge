import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export const DSH_NPM_VERSION = '0.1.2-rc.1'
export const DSH_SOURCE_REVISION = '76fda729799fe9b3848dbe2c211d4b231032b81e'
export const INSTALLER_PROVIDER = 'openrouter'
export const INSTALLER_MODEL = 'z-ai/glm-5.3-flash'
export const INSTALLER_REASONING_EFFORT = 'high'

const profilePackage = `{
  "name": "machtiani-installer-dsh-profile",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
      "patchReload": "startup"
    }
  }
}\n`

const profilePatch = `- id: agent-default-model
  config:
    provider: openrouter
    model: z-ai/glm-5.3-flash
- id: llm-pi-ai
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        models:
          - id: z-ai/glm-5.3-flash
            reasoningEfforts:
              high: high
- id: session-telemetry-otel
  disabled: true
`

const settings = `agent-default-model:
  provider: openrouter
  model: z-ai/glm-5.3-flash
  reasoningEffort: high
`

export async function prepareIsolatedDshHome(dshHome: string): Promise<void> {
  const profile = join(dshHome, 'profiles', 'machtiani-installer')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(join(profile, 'cordis.yml'), '[]\n', { mode: 0o600 }),
    writeFile(join(profile, 'cordis.patch.yml'), profilePatch, { mode: 0o600 }),
    writeFile(join(profile, 'package.json'), profilePackage, { mode: 0o600 }),
    writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600 }),
    writeFile(join(dshHome, 'settings.yaml'), settings, { mode: 0o600 }),
  ])
}

export interface DshTaskOptions {
  dshHome: string
  workspace: string
  task: string
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export interface DshTaskResult {
  stdout: string
  stderr: string
}

function dshBin(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
}

/** The sole process-facing compatibility seam for the pinned DSH runtime. */
export async function runDshTask(options: DshTaskOptions): Promise<DshTaskResult> {
  await prepareIsolatedDshHome(options.dshHome)
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dshBin(), '--profile', 'machtiani-installer', options.task], {
      cwd: options.workspace,
      env: { ...process.env, ...options.environment, DSH_HOME: options.dshHome, DSH_PERMISSION_MODE: 'workspace-write' },
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`DeepSeek Harness task exited with status ${code ?? 'unknown'}: ${stderr.trim()}`))
    })
  })
}

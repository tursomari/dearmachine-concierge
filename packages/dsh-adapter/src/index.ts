import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { InstallerModelSelection } from './model-setup.ts'
import { MODEL_HOST_PROVIDER } from '@dearmachine/machtiani-model-host'

export {
  InstallerModelSetup,
  isKnownInstallerModelSelection,
  loadInstallerModelSelection,
  saveInstallerModelSelection,
  type InstallerAuthEvent,
  type InstallerAuthInteraction,
  type InstallerAuthMethod,
  type InstallerAuthMethodId,
  type InstallerAuthPrompt,
  type InstallerModelOption,
  type InstallerModelSelection,
  type InstallerProviderOption,
} from './model-setup.ts'

export const DSH_NPM_VERSION = '0.1.2-rc.1'
export const DSH_SOURCE_REVISION = '76fda729799fe9b3848dbe2c211d4b231032b81e'
export const DSH_INTERRUPT_METHOD = 'session/interrupt'
export const INSTALLER_PROVIDER = 'openrouter'
export const INSTALLER_MODEL = 'z-ai/glm-5.3-flash'
export const INSTALLER_REASONING_EFFORT = 'high'

export const DEFAULT_INSTALLER_MODEL_SELECTION: InstallerModelSelection = {
  provider: INSTALLER_PROVIDER,
  model: INSTALLER_MODEL,
  reasoningEffort: INSTALLER_REASONING_EFFORT,
}

const profilePackage = `{
  "name": "machtiani-installer-dsh-profile",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],
      "patchReload": "startup"
    }
  }
}\n`

function modelHostPlugin(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('@dearmachine/machtiani-model-host/dsh-plugin')
}

function installerToolsPlugin(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('@dearmachine/machtiani-installer-dsh-adapter/installer-tools')
}

function profilePatch(selection: InstallerModelSelection, mode: 'installer' | 'management' = 'installer'): string {
  return `- id: agent-default-model
  config:
    provider: ${JSON.stringify(MODEL_HOST_PROVIDER)}
    model: ${JSON.stringify(selection.model)}
- id: llm-pi-ai
  disabled: true
- id: bash-sandbox
  config:
    timeoutMs: 3600000
- id: goal
  disabled: true
- id: goal-round-driver
  disabled: true
- id: command-goal
  disabled: true
- id: tool-goal
  disabled: true
- id: tool-ralph
  disabled: true
- id: tool-todo
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: web-search-deepseek
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: sdk-app-startup
  config:
    profile: machtiani-installer
- insert:
    - id: machtiani-model-host
      name: ${JSON.stringify(modelHostPlugin())}
${mode === 'management' ? '' : `    - id: machtiani-installer-tools
      name: ${JSON.stringify(installerToolsPlugin())}
`}`
}

function settings(selection: InstallerModelSelection): string {
  return `agent-default-model:
  provider: ${JSON.stringify(MODEL_HOST_PROVIDER)}
  model: ${JSON.stringify(selection.model)}
${selection.reasoningEffort === undefined ? '' : `  reasoningEffort: ${JSON.stringify(selection.reasoningEffort)}\n`}`
}

export async function prepareIsolatedDshHome(
  dshHome: string,
  selection: InstallerModelSelection = DEFAULT_INSTALLER_MODEL_SELECTION,
  mode: 'installer' | 'management' = 'installer',
): Promise<void> {
  const profile = join(dshHome, 'profiles', 'machtiani-installer')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(join(profile, 'cordis.yml'), '[]\n', { mode: 0o600 }),
    writeFile(join(profile, 'cordis.patch.yml'), profilePatch(selection, mode), { mode: 0o600 }),
    writeFile(join(profile, 'package.json'), profilePackage, { mode: 0o600 }),
    writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600 }),
    writeFile(join(dshHome, 'settings.yaml'), settings(selection), { mode: 0o600 }),
  ])
}

export interface DshTaskOptions {
  dshHome: string
  workspace: string
  task: string
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  selection?: InstallerModelSelection
  modelProfilePath?: string
}

export interface DshTaskResult {
  stdout: string
  stderr: string
}

export type InstallerAgentEvent =
  | { type: 'assistant'; text: string; reasoning: string }
  | { type: 'tool-start'; id: string; name: string; detail: string }
  | { type: 'tool-end'; id: string; failed: boolean }
  | {
      type: 'turn-end'
      outcome: 'completed' | 'blocked' | 'aborted' | 'error' | 'max-tokens' | 'unknown'
      failureCode?: 'EMPTY_RESPONSE' | 'RATE_LIMIT' | 'SERVER' | 'TIMEOUT' | 'TRANSPORT' | 'PI_AI_ERROR'
    }

export type InstallerAgentStatus = 'running' | 'idle'

export interface DshAgentSessionOptions {
  mode?: 'installer' | 'management'
  dshHome: string
  workspace: string
  environment?: NodeJS.ProcessEnv
  onEvent?(event: InstallerAgentEvent): void
  onStatus?(status: InstallerAgentStatus): void
  selection?: InstallerModelSelection
  modelProfilePath: string
  outcomePath: string
}

export class DshTaskExecutionError extends Error {
  readonly #diagnostic: Readonly<DshTaskResult>

  constructor(readonly code: number | null, diagnostic: DshTaskResult) {
    super(`DeepSeek Harness task failed with status ${code ?? 'unknown'}. The installer retained the private diagnostic for troubleshooting.`)
    this.name = 'DshTaskExecutionError'
    this.#diagnostic = { ...diagnostic }
  }

  privateDiagnostic(): Readonly<DshTaskResult> {
    return { ...this.#diagnostic }
  }
}

function dshBin(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function contentText(value: unknown, type: 'text' | 'reasoning'): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(block => {
    const item = record(block)
    return item?.type === type && typeof item.text === 'string' ? [item.text] : []
  }).join('')
}

const secretShapedDetail = /(?:\b(?:sk|rk|pk)-[a-z0-9_-]{8,}|\bgh(?:p|o|u|s|r)_[a-z0-9_]{8,}|\bgithub_pat_[a-z0-9_]{8,}|\bAKIA[A-Z0-9]{16}\b|\bbearer\s+[a-z0-9._~+/=-]{8,}|\b(?:api[_ -]?key|password|secret|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+)/iu

function publicToolDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized === '' || secretShapedDetail.test(normalized)) return undefined
  const characters = [...normalized]
  return characters.length <= 120 ? normalized : `${characters.slice(0, 119).join('')}…`
}

function toolCallDetail(name: string, encodedArguments: unknown): string {
  if (typeof encodedArguments !== 'string') return 'Working'
  let args: Record<string, unknown> | undefined
  try { args = record(JSON.parse(encodedArguments)) } catch { return 'Working' }
  if (args === undefined) return 'Working'

  if (name === 'web_search') {
    const count = Array.isArray(args.queries) ? args.queries.length : 0
    return count === 1 ? '1 query' : count > 1 ? `${count} queries` : 'Working'
  }

  let candidate: unknown
  if (name === 'bash') candidate = args.description
  else if (name === 'read' || name === 'write' || name === 'edit' || name === 'apply_patch') candidate = args.file_path ?? args.path
  else if (name === 'glob' || name === 'grep') candidate = args.pattern ?? args.path
  else candidate = undefined
  return publicToolDetail(candidate) ?? 'Working'
}

/** Normalize the pinned SDK event vocabulary before it reaches product code. */
export function normalizeDshSessionEvent(value: unknown): InstallerAgentEvent | undefined {
  const event = record(value)
  const data = record(event?.data)
  if (event?.type === 'assistant/message') {
    const message = record(data?.message)
    return {
      type: 'assistant',
      text: contentText(message?.content, 'text'),
      reasoning: contentText(message?.content, 'reasoning'),
    }
  }
  if (event?.type === 'tool/call' && typeof data?.callId === 'string' && typeof data.name === 'string') {
    return { type: 'tool-start', id: data.callId, name: data.name, detail: toolCallDetail(data.name, data.arguments) }
  }
  if (event?.type === 'tool/result') {
    const message = record(data?.message)
    const blocks = Array.isArray(message?.content) ? message.content : []
    const result = blocks.map(record).find(block => block?.type === 'tool-result')
    if (typeof result?.toolCallId === 'string') {
      const raw = record(data?.result)
      const rendered = Array.isArray(result.content)
        ? result.content.map(record).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block!.text as string).join('\n')
        : ''
      const structuredFailure = raw?.timedOut === true || raw?.aborted === true || raw?.signal !== null && raw?.signal !== undefined ||
        typeof raw?.exitCode === 'number' && raw.exitCode !== 0
      const renderedFailure = /\[(?:timed out after \d+ms|killed by signal: [^\]]+|exit code: (?!0\])\d+)\]/u.test(rendered)
      return { type: 'tool-end', id: result.toolCallId, failed: result.isError === true || data?.error !== undefined || structuredFailure || renderedFailure }
    }
  }
  if (event?.type === 'turn/end') {
    const reason = record(data?.reason)
    const kind = reason?.kind
    const outcome = kind === 'completed' || kind === 'blocked' || kind === 'aborted' || kind === 'error' || kind === 'max-tokens'
      ? kind
      : 'unknown'
    const failure = record(reason?.error)
    const code = failure?.code
    const failureCode = code === 'EMPTY_RESPONSE' || code === 'RATE_LIMIT' || code === 'SERVER' || code === 'TIMEOUT' || code === 'TRANSPORT' || code === 'PI_AI_ERROR'
      ? code
      : undefined
    return { type: 'turn-end', outcome, ...(failureCode === undefined ? {} : { failureCode }) }
  }
  return undefined
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** One multi-turn installer agent over DSH's documented SDK stdio protocol. */
export class DshAgentSession {
  readonly sessionId = randomUUID()
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ''
  private stderr = ''
  private requestId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private exit: Promise<number | null> | undefined
  private closed = false

  constructor(private readonly options: DshAgentSessionOptions) {}

  async start(): Promise<void> {
    if (this.child !== undefined) throw new Error('the DSH installer session is already started')
    const selection = this.options.selection ?? DEFAULT_INSTALLER_MODEL_SELECTION
    await prepareIsolatedDshHome(this.options.dshHome, selection, this.options.mode)
    const child = spawn(process.execPath, [dshBin(), '--profile', 'machtiani-installer'], {
      cwd: this.options.workspace,
      env: {
        ...process.env,
        ...this.options.environment,
        DSH_HOME: this.options.dshHome,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        MACHTIANI_MODEL_PROFILE: this.options.modelProfilePath,
        MACHTIANI_INSTALLER_OUTCOME: this.options.outcomePath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8').on('data', chunk => { this.consume(String(chunk)) })
    child.stderr.setEncoding('utf8').on('data', chunk => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-1_048_576) })
    this.exit = new Promise(resolve => {
      child.once('close', code => {
        this.closed = true
        const error = new Error(`DeepSeek Harness exited with status ${code ?? 'unknown'}.`)
        for (const request of this.pending.values()) request.reject(error)
        this.pending.clear()
        resolve(code)
      })
    })
    child.once('error', () => {
      const error = new Error('DeepSeek Harness could not start.')
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    })
    await this.request('initialize', {
      cwd: this.options.workspace,
      provider: MODEL_HOST_PROVIDER,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
  }

  async prompt(text: string): Promise<void> {
    if (text.trim() === '') return
    await this.request('session/prompt', {
      sessionId: this.sessionId,
      contentBlocks: [{ type: 'text', text }],
    })
  }

  /** Cancel current model/tool activity while preserving the installer session. */
  async interrupt(): Promise<void> {
    await this.request(DSH_INTERRUPT_METHOD, { sessionId: this.sessionId })
  }

  async whenExited(): Promise<number | null> {
    if (this.exit === undefined) throw new Error('the DSH installer session is not started')
    return await this.exit
  }

  async shutdown(): Promise<void> {
    if (this.child === undefined || this.closed) return
    if (this.options.mode === 'management') {
      const child = this.child
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.request('shutdown', {}).then(() => this.exit).catch(() => this.exit),
          new Promise<void>(resolve => {
            timer = setTimeout(() => {
              child.kill('SIGKILL')
              child.stdout.destroy()
              child.stderr.destroy()
              resolve()
            }, 500)
          }),
        ])
      } finally { clearTimeout(timer) }
      return
    }
    try {
      await this.request('shutdown', {})
    } finally {
      await this.exit
    }
  }

  private request(method: string, params: object): Promise<unknown> {
    const child = this.child
    if (child === undefined || this.closed) return Promise.reject(new Error('the DSH installer session is not running'))
    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (error === null || error === undefined) return
        this.pending.delete(id)
        reject(new Error('DeepSeek Harness protocol input failed.'))
      })
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() === '') continue
      let message: Record<string, unknown> | undefined
      try { message = record(JSON.parse(line)) } catch { continue }
      if (typeof message?.id === 'number') {
        const request = this.pending.get(message.id)
        if (request === undefined) continue
        this.pending.delete(message.id)
        const error = record(message.error)
        if (error !== undefined) request.reject(new Error(typeof error.message === 'string' ? error.message : 'DeepSeek Harness request failed.'))
        else request.resolve(message.result)
        continue
      }
      const params = record(message?.params)
      if (message?.method === 'session.status' && params?.sessionId === this.sessionId && (params.status === 'running' || params.status === 'idle')) {
        this.options.onStatus?.(params.status)
      }
      if (message?.method === 'session.event' && params?.sessionId === this.sessionId) {
        const event = normalizeDshSessionEvent(params.event)
        if (event !== undefined) this.options.onEvent?.(event)
      }
    }
  }
}

/** The sole process-facing compatibility seam for the pinned DSH runtime. */
export async function runDshTask(options: DshTaskOptions): Promise<DshTaskResult> {
  await prepareIsolatedDshHome(options.dshHome, options.selection)
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dshBin(), '--profile', 'machtiani-installer', options.task], {
      cwd: options.workspace,
      env: {
        ...process.env,
        ...options.environment,
        DSH_HOME: options.dshHome,
        DSH_PERMISSION_MODE: 'workspace-write',
        ...(options.modelProfilePath === undefined ? {} : { MACHTIANI_MODEL_PROFILE: options.modelProfilePath }),
      },
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: unknown): string => `${current}${String(chunk)}`.slice(-1_048_576)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = append(stderr, chunk) })
    child.once('error', () => reject(new Error('DeepSeek Harness task could not start.')))
    child.once('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new DshTaskExecutionError(code, { stdout, stderr }))
    })
  })
}

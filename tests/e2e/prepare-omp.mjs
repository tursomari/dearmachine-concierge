import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
const execute = promisify(execFile)

// Read only the fields needed to prove the effective client configuration.
// Session messages and private reasoning are never included in the receipt.
export function verifyOmpSession(text, backend) {
  const events = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const model = events.filter(row => row.type === 'model_change').at(-1)
  const effort = events.filter(row => row.type === 'thinking_level_change').at(-1)
  const replies = events.filter(row => row.type === 'message' && row.message?.role === 'assistant').map(row => row.message)
  if (model?.model !== `${backend.provider}/${backend.model}` || model?.resolvedModelIsFallback === true ||
      (backend.reasoningEffort !== 'default' && effort?.thinkingLevel !== backend.reasoningEffort) ||
      !replies.some(reply => reply.stopReason === 'stop' && reply.provider === backend.provider && reply.model === backend.model &&
        reply.content?.some(part => part.type === 'text' && part.text.trim() === 'READY'))) {
    throw new Error('OMP functional probe did not confirm the requested model, reasoning and reply')
  }
  return { provider: backend.provider, model: backend.model, reasoningEffort: effort?.thinkingLevel ?? 'default', probe: 'passed' }
}

export async function prepareOmp18116({ home, backend, credentialPath, credentialVariable, executable = '/usr/local/bin/omp' }) {
  const agent = join(home, '.omp/agent')
  await mkdir(agent, { recursive: true, mode: 0o700 })
  // The disposable HOME belongs to this run; fail rather than replace old config.
  const privateEnvironment = join(agent, '.env')
  await writeFile(privateEnvironment, await readFile(credentialPath), { mode: 0o600, flag: 'wx' })
  const provider = { apiKey: credentialVariable }
  if (backend.endpoint) {
    if (!backend.endpoint.endsWith('/chat/completions')) throw new Error('OMP needs a Chat Completions endpoint')
    Object.assign(provider, {
      baseUrl: backend.endpoint.slice(0, -'/chat/completions'.length), api: 'openai-completions',
      models: [{ id: backend.model, name: backend.model, reasoning: backend.reasoningEffort !== 'default',
        input: ['text'], contextWindow: 131072, maxTokens: 8192 }],
    })
  }
  await writeFile(join(agent, 'models.yml'), JSON.stringify({ providers: { [backend.provider]: provider } }), { mode: 0o600, flag: 'wx' })
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent }
  const run = async (args, cwd = home) => {
    try {
      const result = execute(executable, args, { cwd, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
      result.child.stdin.end()
      return await result
    }
    catch { throw new Error('OMP preparation command failed; private command output was withheld') }
  }
  if ((await run(['--version'])).stdout.trim() !== 'omp/18.1.16') throw new Error('Unexpected OMP version')
  const role = `${backend.provider}/${backend.model}${backend.reasoningEffort === 'default' ? '' : `:${backend.reasoningEffort}`}`
  await run(['config', 'set', 'modelRoles', JSON.stringify({ default: role, smol: role, slow: role, tiny: role })])
  const probe = await mkdtemp(join(home, 'qse-omp-probe-'))
  const sessions = join(probe, 'sessions')
  await mkdir(sessions, { mode: 0o700 })
  try {
    await run(['--print', '--session-dir', sessions, 'Reply with exactly READY. Do not run tools or alter files.'], probe)
    const files = (await readdir(sessions, { recursive: true })).filter(name => name.endsWith('.jsonl'))
    if (files.length !== 1) throw new Error('OMP probe must produce exactly one session')
    return { backend: 'omp', version: '18.1.16', ...verifyOmpSession(await readFile(join(sessions, files[0]), 'utf8'), backend) }
  } finally { await rm(probe, { recursive: true, force: true }) }
}

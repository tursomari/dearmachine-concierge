import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeApiKeyCredential } from '../../packages/model-host/dist/index.mjs'
import { prepareOmp18116 } from './prepare-omp.mjs'
import { prepareForge21321 } from '../../packages/backend-adapter/dist/index.mjs'

const runtime = '/run/machtiani-installer-qse'
const config = JSON.parse(await readFile(join(runtime, 'model-config.json'), 'utf8'))
const home = process.env.HOME
const shared = config.shared
const backend = config.backend
const backendId = config.backendId
const executable = `/usr/local/bin/${backendId}`
const provider = shared.endpoint ? 'custom-openai-remote' : shared.provider
await writeApiKeyCredential(join(home, '.config/dearmachine/backends.env'), provider,
  (await readFile(join(runtime, 'secrets/shared'), 'utf8')).trim())
const backendCredential = join(home, '.config/dearmachine/qse-backend.env')
const backendVariable = backend.endpoint ? 'MACHTIANI_BACKEND_QSE_API_KEY' : `${backend.provider.toUpperCase()}_API_KEY`
await writeFile(backendCredential, `${backendVariable}=${(await readFile(join(runtime, 'secrets/backend'), 'utf8')).trim()}\n`, { mode: 0o600 })
const receipt = backendId === 'omp' ? await prepareOmp18116({ home, backend, credentialPath: backendCredential, credentialVariable: backendVariable, executable }) : await prepareForge21321({
  home, providerEnvironmentPath: backendCredential, provider: backend.provider, model: backend.model,
  ...(backend.reasoningEffort === 'default' ? {} : { reasoningEffort: backend.reasoningEffort }),
  ...(backend.endpoint ? { customProvider: { endpoint: backend.endpoint, credentialVariable: backendVariable } } : {}),
})
await unlink(backendCredential)
const selection = {
  provider, model: shared.model,
  ...(shared.endpoint ? { customProvider: { kind: 'openai-compatible', scope: 'remote', name: shared.provider,
    chatCompletionsEndpoint: shared.endpoint, usesApiKey: true } } : {}),
  transport: 'agentmail', authorizedSender: process.env.QSE_SENDER_ADDRESS, detectedBackends: [backendId],
  backend: { name: backendId === 'omp' ? 'OMP' : 'Forge', id: backendId, executable, status: 'ready', summary: 'functional probe passed' },
}
await writeFile(join(runtime, 'selection.json'), `${JSON.stringify(selection)}\n`, { mode: 0o600 })
await writeFile(join(runtime, 'model-receipt.json'), `${JSON.stringify({ ...config, backendPreparation: receipt })}\n`, { mode: 0o600 })
await writeFile(join(runtime, 'reasoning-effort'), shared.reasoningEffort, { mode: 0o600 })
await writeFile(join(runtime, 'backend-id'), backendId, { mode: 0o600 })

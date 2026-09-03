import { describe, expect, it } from 'vitest'
import { messages, runCompleteInstallation, runFirstThreeStages, runThroughBackendSelection, type CompleteWorkflowPorts, type GuidedWorkflowPorts, type WorkflowCheckpoint, type WorkflowPorts } from '../src/index.ts'

function fixture(answers: string[], initial?: WorkflowCheckpoint) {
  const asked: string[] = []
  const events: string[] = []
  let saved = initial
  let inspections = 0
  const ports: WorkflowPorts = {
    conversation: {
      ask: async message => {
        asked.push(message)
        const answer = answers.shift()
        if (answer === undefined) throw new Error(`no answer for: ${message}`)
        return answer
      },
      say: message => events.push(`say:${message}`),
      progress: message => events.push(`progress:${message ?? 'idle'}`),
      tool: name => ({
        succeed: summary => events.push(`tool:${name}:success:${summary ?? ''}`),
        fail: summary => events.push(`tool:${name}:failure:${summary}`),
      }),
    },
    environment: {
      inspect: async () => {
        inspections += 1
        events.push('inspect')
        return { missingFoundations: [], detectedBackends: ['Codex'] }
      },
      installFoundations: async names => { events.push(`install:${names.join(',')}`) },
    },
    credentials: {
      prepare: async kind => { events.push(`prepare:${kind}`) },
      status: async kind => { events.push(`status:${kind}`); return 'ready' },
    },
    checkpoint: {
      load: async () => saved,
      save: async checkpoint => { saved = checkpoint; events.push(`save:${checkpoint.stage}`) },
    },
  }
  return { ports, asked, events, inspections, get saved() { return saved } }
}

describe('canonical installation workflow', () => {
  it('does nothing before explicit consent', async () => {
    const test = fixture(['not now'])
    await expect(runFirstThreeStages(test.ports)).resolves.toBeUndefined()
    expect(test.asked).toEqual([messages.welcome])
    expect(test.events).toEqual([`say:${messages.notNow}`])
  })

  it('keeps the first three stages ordered and credentials out of the conversation', async () => {
    const test = fixture(['yes', 'OpenRouter', 'z-ai/glm-5.3-flash', 'done', 'AgentMail', 'no', 'done', 'sender@example.test'])
    await expect(runFirstThreeStages(test.ports)).resolves.toEqual({
      provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', transport: 'AgentMail',
      authorizedSender: 'sender@example.test', detectedBackends: ['Codex'],
    })
    expect(test.asked).toEqual([
      messages.welcome,
      messages.provider,
      messages.model('OpenRouter'),
      messages.llmCredential('OpenRouter', 'z-ai/glm-5.3-flash'),
      messages.emailTransport,
      messages.agentMailHelp,
      messages.emailCredential('AgentMail'),
      messages.authorizedSender,
    ])
    expect(test.events).toContain('prepare:llm')
    expect(test.events).toContain('prepare:email')
    expect(test.asked.join('\n')).not.toMatch(/sk-[A-Za-z0-9]/u)
  })

  it('resumes from a non-secret checkpoint without repeating earlier questions', async () => {
    const test = fixture(['done', 'Sendmux', 'done', 'sender@example.test'], {
      stage: 'llm-credential', provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', detectedBackends: [],
    })
    await runFirstThreeStages(test.ports)
    expect(test.asked[0]).toBe(messages.llmCredential('OpenRouter', 'z-ai/glm-5.3-flash'))
    expect(test.asked).not.toContain(messages.welcome)
    expect(test.saved?.stage).toBe('complete')
  })
})

describe('backend selection', () => {
  it('does not probe or select a backend before permission and an explicit choice', async () => {
    const test = fixture([], {
      stage: 'complete', provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', transport: 'AgentMail',
      authorizedSender: 'sender@example.test', detectedBackends: ['Codex'],
    })
    let checks = 0
    const ports: GuidedWorkflowPorts = {
      ...test.ports,
      conversation: {
        ...test.ports.conversation,
        ask: async message => { test.asked.push(message); return 'no' },
      },
      backends: {
        discover: async () => [{ name: 'Codex', id: 'codex-yolo', executable: '/usr/bin/codex' }],
        check: async () => { checks += 1; return [] },
      },
    }
    await expect(runThroughBackendSelection(ports)).resolves.toBeUndefined()
    expect(checks).toBe(0)
    expect(test.asked).toEqual([messages.backendReadiness('Codex')])
  })

  it('checks every candidate only after permission and records the human choice', async () => {
    const test = fixture([], {
      stage: 'complete', provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', transport: 'AgentMail',
      authorizedSender: 'sender@example.test', detectedBackends: ['Codex', 'Forge'],
    })
    const answers = ['yes', 'Forge']
    const checked: string[] = []
    const ports: GuidedWorkflowPorts = {
      ...test.ports,
      conversation: {
        ...test.ports.conversation,
        ask: async message => {
          test.asked.push(message)
          const answer = answers.shift()
          if (answer === undefined) throw new Error('missing backend answer')
          return answer
        },
      },
      backends: {
        discover: async () => [
          { name: 'Codex', id: 'codex-yolo', executable: '/usr/bin/codex' },
          { name: 'Forge', id: 'forge', executable: '/usr/bin/forge' },
        ],
        check: async candidates => {
          checked.push(...candidates.map(candidate => candidate.name))
          return candidates.map(candidate => ({ ...candidate, status: 'ready' as const, summary: 'functional probe passed' }))
        },
      },
    }
    const result = await runThroughBackendSelection(ports)
    expect(checked).toEqual(['Codex', 'Forge'])
    expect(result?.backend).toEqual(expect.objectContaining({ name: 'Forge', id: 'forge', status: 'ready' }))
    expect(test.saved?.stage).toBe('ready-to-install')
    expect(test.asked[1]).toBe(messages.backendChoice('Codex is ready.\nForge is ready.'))
  })
})

describe('complete installation', () => {
  const ready: WorkflowCheckpoint = {
    stage: 'ready-to-install', provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', transport: 'AgentMail',
    authorizedSender: 'sender@example.test', detectedBackends: ['Forge'],
    backend: { name: 'Forge', id: 'forge', executable: '/usr/bin/forge', status: 'ready', summary: 'functional probe passed' },
  }

  it('orders product mutation, the human email gate, live verification, and the success report', async () => {
    const test = fixture(['sent'], ready)
    const productEvents: string[] = []
    const ports: CompleteWorkflowPorts = {
      ...test.ports,
      backends: { discover: async () => [], check: async () => [] },
      products: {
        install: async () => { productEvents.push('install'); return { inboxAddress: 'machine@example.test' } },
        captureLiveEmailBaseline: async () => { productEvents.push('baseline'); return 'private-baseline' },
        waitForLiveEmail: async (baseline, progress) => {
          productEvents.push(`verify:${baseline}`)
          progress('Dear Machine received your email and is working through Forge')
        },
      },
    }
    await expect(runCompleteInstallation(ports)).resolves.toEqual({ inboxAddress: 'machine@example.test' })
    expect(productEvents).toEqual(['install', 'baseline', 'verify:private-baseline'])
    expect(test.asked).toEqual([messages.testEmail('machine@example.test')])
    expect(test.events).toContain(`say:${messages.productInstallation}`)
    expect(test.events).toContain(`say:${messages.installationOutcome('Forge', 'machine@example.test')}`)
    expect(test.saved).toEqual(expect.objectContaining({ stage: 'success', inboxAddress: 'machine@example.test' }))
    expect(test.events.indexOf('save:installing')).toBeLessThan(test.events.indexOf('save:awaiting-test-email'))
  })

  it('resumes live verification without reinstalling or repeating the email question', async () => {
    const test = fixture([], { ...ready, stage: 'verifying-email', inboxAddress: 'machine@example.test', liveEmailBaseline: 'saved-baseline' })
    let installs = 0
    const ports: CompleteWorkflowPorts = {
      ...test.ports,
      backends: { discover: async () => [], check: async () => [] },
      products: {
        install: async () => { installs += 1; return { inboxAddress: 'wrong@example.test' } },
        captureLiveEmailBaseline: async () => 'wrong-baseline',
        waitForLiveEmail: async baseline => { expect(baseline).toBe('saved-baseline') },
      },
    }
    await expect(runCompleteInstallation(ports)).resolves.toEqual({ inboxAddress: 'machine@example.test' })
    expect(installs).toBe(0)
    expect(test.asked).toEqual([])
    expect(test.saved?.stage).toBe('success')
  })
})

import { describe, expect, it } from 'vitest'
import { messages, runCompleteInstallation, runFirstThreeStages, runThroughBackendSelection, type CompleteWorkflowPorts, type GuidedWorkflowPorts, type WorkflowCheckpoint, type WorkflowPorts } from '../src/index.ts'

function fixture(answers: string[], initial?: WorkflowCheckpoint) {
  const asked: string[] = []
  const secretAsked: string[] = []
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
      askSecret: async message => {
        secretAsked.push(message)
        const answer = answers.shift()
        if (answer === undefined) throw new Error(`no secret answer for: ${message}`)
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
      prepare: async kind => { events.push(`prepare:${kind}`); return 'pending' },
      save: async kind => { events.push(`credential:${kind}:saved`) },
    },
    checkpoint: {
      load: async () => saved,
      save: async checkpoint => { saved = checkpoint; events.push(`save:${checkpoint.stage}`) },
    },
  }
  return { ports, asked, secretAsked, events, inspections, get saved() { return saved } }
}

describe('canonical installation workflow', () => {
  it('does nothing before explicit consent', async () => {
    const test = fixture(['not now'])
    await expect(runFirstThreeStages(test.ports)).resolves.toBeUndefined()
    expect(test.asked).toEqual([messages.welcome])
    expect(test.events).toEqual([`say:${messages.notNow}`])
  })

  it('keeps the first three stages ordered and credentials out of the conversation', async () => {
    const test = fixture(['yes', 'OpenRouter', 'z-ai/glm-5.3-flash', 'provider-test-secret', 'AgentMail', 'no', 'email-test-secret', 'sender@example.test'])
    await expect(runFirstThreeStages(test.ports)).resolves.toEqual({
      provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', transport: 'AgentMail',
      authorizedSender: 'sender@example.test', detectedBackends: ['Codex'],
    })
    expect(test.asked).toEqual([
      messages.welcome,
      messages.provider,
      messages.model('OpenRouter'),
      messages.emailTransport,
      messages.agentMailHelp,
      messages.authorizedSender,
    ])
    expect(test.secretAsked).toEqual([
      messages.llmCredential('OpenRouter', 'z-ai/glm-5.3-flash'),
      messages.emailCredential('AgentMail'),
    ])
    expect(test.events).toContain('prepare:llm')
    expect(test.events).toContain('prepare:email')
    const persistedAndConversational = JSON.stringify({ asked: test.asked, secretAsked: test.secretAsked, events: test.events, checkpoint: test.saved })
    expect(persistedAndConversational).not.toContain('provider-test-secret')
    expect(persistedAndConversational).not.toContain('email-test-secret')
  })

  it('resumes from a non-secret checkpoint without repeating earlier questions', async () => {
    const test = fixture(['resume-provider-secret', 'Sendmux', 'resume-email-secret', 'sender@example.test'], {
      stage: 'llm-credential', provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', detectedBackends: [],
    })
    await runFirstThreeStages(test.ports)
    expect(test.secretAsked[0]).toBe(messages.llmCredential('OpenRouter', 'z-ai/glm-5.3-flash'))
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
    expect(test.asked[0]).toContain('a separate AI worker similar to a subagent')
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
    expect(test.asked[1]).toBe(messages.backendChoice('Codex is ready.\nForge is ready.', ['Codex', 'Forge']))
    expect(test.asked[1]).toContain('Dear Machine only needs one backend.')
    expect(test.asked[1]).not.toContain('lower separate API costs')
  })

  it('confirms the only ready backend without presenting the full catalogue again', async () => {
    const test = fixture([], {
      stage: 'complete', provider: 'OpenRouter', model: 'z-ai/glm-5.3-flash', transport: 'AgentMail',
      authorizedSender: 'sender@example.test', detectedBackends: ['Forge'],
    })
    const answers = ['yes', 'yes']
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
        discover: async () => [{ name: 'Forge', id: 'forge', executable: '/usr/bin/forge' }],
        check: async candidates => candidates.map(candidate => ({
          ...candidate, status: 'ready' as const, summary: 'functional probe passed',
        })),
      },
    }

    const result = await runThroughBackendSelection(ports)
    expect(result?.backend).toEqual(expect.objectContaining({ name: 'Forge', status: 'ready' }))
    expect(test.asked[1]).toBe(messages.backendChoice('Forge is ready.', ['Forge']))
    expect(test.asked[1]).toContain('Dear Machine only needs one backend; adding another is optional.')
    expect(test.asked[1]).toContain('Use Forge?')
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
    expect(test.asked).toEqual([expect.stringContaining('Please send a short test email from sender@example.test to machine@example.test.')])
    expect(test.events).toContain(`say:${messages.productInstallation}`)
    expect(test.events).toContain(`say:${messages.installationOutcome('Forge', 'machine@example.test')}`)
    expect(test.saved).toEqual(expect.objectContaining({ stage: 'success', inboxAddress: 'machine@example.test' }))
    expect(test.events.indexOf('save:installing')).toBeLessThan(test.events.indexOf('save:awaiting-test-email'))
  })

  it('uses the current confirmed sender and inbox when resuming the email question', async () => {
    const test = fixture(['sent'], { ...ready, stage: 'awaiting-test-email',
      authorizedSender: 'replacement@example.test', inboxAddress: 'current-inbox@example.test', liveEmailBaseline: 'saved-baseline' })
    const ports: CompleteWorkflowPorts = {
      ...test.ports,
      backends: { discover: async () => [], check: async () => [] },
      products: {
        install: async () => { throw new Error('must not reinstall') },
        captureLiveEmailBaseline: async () => { throw new Error('must preserve the baseline') },
        waitForLiveEmail: async baseline => { expect(baseline).toBe('saved-baseline') },
      },
    }
    await runCompleteInstallation(ports)
    expect(test.asked).toEqual([expect.stringContaining(
      'Please send a short test email from replacement@example.test to current-inbox@example.test.',
    )])
    expect(test.asked[0]).not.toContain('from sender@example.test')
  })

  it.each(['authorizedSender', 'inboxAddress'] as const)('does not give an email instruction with a missing %s', async missing => {
    const test = fixture([], { ...ready, stage: 'awaiting-test-email',
      inboxAddress: 'machine@example.test', liveEmailBaseline: 'saved-baseline', [missing]: undefined })
    const ports: CompleteWorkflowPorts = {
      ...test.ports,
      backends: { discover: async () => [], check: async () => [] },
      products: {
        install: async () => { throw new Error('must not reinstall') },
        captureLiveEmailBaseline: async () => 'unused',
        waitForLiveEmail: async () => { throw new Error('must not verify an incomplete pairing') },
      },
    }
    await expect(runCompleteInstallation(ports)).rejects.toThrow('saved live email verification state is incomplete')
    expect(test.asked).toEqual([])
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

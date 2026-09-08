import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ModelHost, ModelHostError, MODEL_HOST_PROVIDER, type ModelHostMessage } from './index.ts'

function dshMessages(messages: readonly Message[]): ModelHostMessage[] {
  const calls = new Map<string, string>()
  for (const message of messages) for (const block of message.content) if (block.type === 'tool-call') calls.set(block.id, block.name)
  return messages.map(message => {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
    const toolResult = message.content.find(block => block.type === 'tool-result')
    if (toolResult?.type === 'tool-result') return {
      role: 'tool' as const,
      content: toolResult.content.filter(block => block.type === 'text').map(block => block.text).join(''),
      toolCallId: toolResult.toolCallId,
      toolName: calls.get(toolResult.toolCallId) ?? 'unknown',
    }
    return {
      role: message.role,
      content: text,
      ...(reasoning === '' ? {} : { reasoning }),
      ...(message.role !== 'assistant' ? {} : {
        toolCalls: message.content.flatMap(block => block.type === 'tool-call'
          ? [{ id: block.id, name: block.name, arguments: block.arguments }]
          : []),
      }),
    }
  })
}

function failure(error: unknown): LlmError {
  const mapped = error instanceof ModelHostError ? error : new ModelHostError('INTERNAL', 'The model host request failed.')
  const codes: Record<string, string> = {
    AUTH_REQUIRED: 'AUTH', AUTH_EXPIRED: 'AUTH', RATE_LIMITED: 'RATE_LIMIT', QUOTA_EXHAUSTED: 'RATE_LIMIT',
    MODEL_UNAVAILABLE: 'MODEL', CANCELLED: 'ABORTED', UPSTREAM_CHANGED: 'TRANSPORT', INVALID_REQUEST: 'INVALID_REQUEST',
    UNSUPPORTED_CAPABILITY: 'INVALID_REQUEST', INTERNAL: 'TRANSPORT',
  }
  return new LlmError(mapped.message, codes[mapped.code] ?? 'TRANSPORT', mapped.retryAfterMs === undefined ? undefined : { providerRetryAfterMs: mapped.retryAfterMs })
}

class MachtianiModelHostAdapter extends LlmAdapter {
  constructor(private readonly profilePath: string, private readonly caller: string) { super() }

  override providerInfo() { return { id: MODEL_HOST_PROVIDER, name: 'Machtiani model host' } }

  override providerRetryPolicy() {
    return {
      mode: 'normal' as const,
      maxRetries: 3,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  override async listModels() {
    const host = await ModelHost.open(this.profilePath)
    return (await host.models()).map(model => ({ provider: MODEL_HOST_PROVIDER, id: model.id, name: model.name }))
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const host = await ModelHost.open(this.profilePath)
    const entry = (await host.models()).find(candidate => candidate.id === model)
    return {
      provider: MODEL_HOST_PROVIDER,
      id: model,
      name: entry?.name ?? model,
      ...(entry === undefined || entry.reasoningEfforts.length === 0 ? {} : {
        reasoning: {
          efforts: entry.reasoningEfforts.map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
          defaultEffort: ReasoningEffortId(host.profile.reasoningEffort ?? entry.reasoningEfforts[0]!),
        },
      }),
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      const host = await ModelHost.open(this.profilePath)
      for await (const event of host.generate({
        caller: this.caller,
        sessionId: String(options.sessionId ?? 'installer'),
        messages: dshMessages(options.messages),
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
        model: options.model,
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) {
        switch (event.type) {
          case 'text-start': yield { type: 'block-start', index: event.index, blockType: 'text' }; break
          case 'text-delta': yield { type: 'text-delta', index: event.index, text: event.text }; break
          case 'text-end': yield { type: 'block-end', index: event.index, block: { type: 'text', text: event.text } }; break
          case 'reasoning-start': yield { type: 'block-start', index: event.index, blockType: 'reasoning' }; break
          case 'reasoning-delta': yield { type: 'reasoning-delta', index: event.index, text: event.text }; break
          case 'reasoning-end': yield { type: 'block-end', index: event.index, block: { type: 'reasoning', text: event.text } }; break
          case 'tool-start': yield { type: 'block-start', index: event.index, blockType: 'tool-call' }; break
          case 'tool-delta': yield { type: 'tool-call-delta', index: event.index, id: ToolCallId(event.id), name: event.name, argumentsDelta: event.argumentsDelta }; break
          case 'tool-end': yield { type: 'block-end', index: event.index, block: { type: 'tool-call', id: ToolCallId(event.id), name: event.name, arguments: event.arguments } }; break
          case 'usage': yield { type: 'usage', usage: event }; break
          case 'finish': yield { type: 'finish', reason: event.reason === 'tool-calls' ? { kind: 'tool-calls' } : event.reason === 'max-tokens' ? { kind: 'max-tokens' } : event.reason === 'cancelled' ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'The model request was cancelled.' } } : { kind: 'stop' } }; break
        }
      }
    } catch (error) { throw failure(error) }
  }
}

export const name = 'machtiani-model-host'
export const inject = ['llm']

export function apply(ctx: Context): void {
  const profilePath = process.env.MACHTIANI_MODEL_PROFILE
  if (profilePath === undefined || profilePath === '') throw new Error('MACHTIANI_MODEL_PROFILE is required')
  const mode = process.env.MACHTIANI_AGENT_MODE
  const caller = mode === 'management' ? 'concierge' : mode === 'task' ? 'task' : 'installer'
  ctx.llm.registerAdapter([MODEL_HOST_PROVIDER], new MachtianiModelHostAdapter(profilePath, caller))
}

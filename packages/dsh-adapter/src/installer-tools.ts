import { protectPrivatePath } from '@dearmachine/machtiani-installer-credentials'
import { requestBackendLogin } from './backend-login.ts'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'machtiani-installer-tools'
export const inject = ['tools', 'systemPrompt']

export type InstallationOutcomeKind = 'success' | 'partial' | 'blocked'

export interface InstallationOutcome {
  version: 1
  outcome: InstallationOutcomeKind
  summary: string
  remainingAction?: string
  receipts: readonly string[]
}

export async function saveInstallationOutcome(path: string, outcome: InstallationOutcome): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(outcome, undefined, 2)}\n`, { mode: 0o600 })
  await protectPrivatePath(temporary, 0o600)
  await rename(temporary, path)
}

export function apply(ctx: Context): void {
  const outcomePath = process.env.MACHTIANI_INSTALLER_OUTCOME
  if (outcomePath === undefined || outcomePath === '') throw new Error('MACHTIANI_INSTALLER_OUTCOME is required')
  ctx.systemPrompt.section({
    name: 'tool:machtiani-installer-finish',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: 'Call finish_installation exactly once only after verified completion or when the human explicitly chooses to end the installation. A failed check, partial progress, or a blocker does not authorize closing the session. Explain the problem, recover within existing authorization, or ask for the choice or action needed to continue. Keep the conversation open while waiting. Use partial or blocked outcomes only when the human chooses to stop before completion. Base every receipt on observed command evidence. Distinguish pre-existing software from installer changes. Do not place credentials or credential fragments in any field.',
  })
  ctx.tools.register(defineTool({
    name: 'authenticate_backend',
    description: 'After the user chooses Claude Code subscription authentication, sign in through the trusted browser-link and masked-code interface. Never run claude auth login through bash. Does not change the installer model. Run the functional backend probe afterward.',
    parameters: {
      backend: { type: 'string', required: true, enum: ['claude'] },
      executable: { type: 'string', description: 'Absolute path of the user-selected Claude Code executable, if it is not discoverable on PATH.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { authenticated: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'Backend account sign-in verified. Run the functional backend probe next.' }] },
    async execute(args, exec) { await requestBackendLogin(args.executable, exec.signal); return { authenticated: true } },
    presentCall: () => ({ card: 'generic', title: 'Sign in to Claude Code', kind: 'other' }),
  }))
  ctx.tools.register(defineTool({
    name: 'finish_installation',
    description: 'Close the installer session with an evidence-based outcome only after verified completion or the human explicitly chooses to stop. Do not call merely because a command failed or progress is blocked; explain the problem and continue the recovery conversation.',
    parameters: {
      outcome: { type: 'string', required: true, enum: ['success', 'partial', 'blocked'] },
      summary: { type: 'string', required: true, description: 'Short plain-language outcome.' },
      remaining_action: { type: 'string', description: 'One actionable next step when incomplete.' },
      receipts: {
        type: 'array', required: true,
        items: { type: 'string' },
        description: 'Observed facts, including whether each component was pre-existing, installed, configured, or verified.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { recorded: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'The installer outcome was recorded and the session will close.' }],
    },
    async execute(args) {
      await saveInstallationOutcome(outcomePath, {
        version: 1,
        outcome: args.outcome as InstallationOutcomeKind,
        summary: args.summary,
        ...(args.remaining_action === undefined ? {} : { remainingAction: args.remaining_action }),
        receipts: args.receipts,
      })
      return { recorded: true }
    },
    presentCall: () => ({ card: 'generic', title: 'Finish installation', kind: 'other' }),
  }))
}

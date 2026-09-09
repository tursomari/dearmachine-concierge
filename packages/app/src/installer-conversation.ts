import type { DshAgentSession } from '@dearmachine/machtiani-installer-dsh-adapter'

export type InstallerAssistantState = 'setup' | 'ready' | 'unavailable'

/** Local startup/setup failures are not evidence that a remote provider failed. */
export async function submitInstallerMessage(
  text: string, state: InstallerAssistantState, agent: Pick<DshAgentSession, 'prompt'> | undefined,
  say: (message: string) => void,
): Promise<void> {
  if (state === 'setup') {
    say('Complete the setup menus before chatting with the installation assistant. Use /help for local controls or /quit to leave.')
    return
  }
  if (state === 'unavailable' || agent === undefined) {
    say('The installation assistant is not running because setup or startup failed. Use /status to check Dear Machine, or /help for local controls. After the reported problem is resolved, use /quit and reopen dearmachine to retry.')
    return
  }
  await agent.prompt(text)
}

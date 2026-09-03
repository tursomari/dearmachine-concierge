export const messages = {
  welcome: `Welcome to Dear Machine,

Your computer can have an inbox of its own. Email it from anywhere, and it can work locally and write back in the same thread.

Would you like to continue with the installation now?`,
  provider: "Machtiani powers Dear Machine's AI reasoning. Which LLM provider would you like Machtiani to use? OpenRouter is recommended, or you can name another supported provider.",
  model: (provider: string) => `Which ${provider} model would you like Machtiani to use? If you’re unsure, I can recommend one.`,
  llmCredential: (provider: string, model: string) => `Machtiani needs your ${provider} API key to use ${model} for Dear Machine.

In another shell, run:

\`enter-llm-key\`

Tell me when you're done.`,
  emailTransport: "Dear Machine needs an email service to receive messages and send replies. AgentMail provides that inbox and is recommended; OpenMail and Sendmux are also supported. Which would you like to use?",
  agentMailHelp: "If you don’t already have an AgentMail API key, a free tier is available. Do you need help getting one?",
  emailCredential: (transport: string) => `Dear Machine needs your ${transport} API key to connect to the email service you chose.

In another shell, run:

\`enter-email-key\`

Tell me when you're done.`,
  authorizedSender: 'What email address should be allowed to send work to Dear Machine?',
  backendReadiness: (detectedAgents: string) => `Dear Machine works through a backend agent. I found these supported agents already installed: ${detectedAgents}.

With your permission, I can check whether they are already signed in and ready to use with Dear Machine. May I do that?`,
  backendChoice: (readinessSummary: string) => `${readinessSummary}

Using an agent you already have through a subscription can make Dear Machine more capable and may lower separate API costs. Dear Machine supports Codex, Forge, and OMP.

Codex, Forge, and OMP can make changes on your behalf and will exercise common-sense care. Dear Machine will ask when authorization is needed.

If your preferred agent is not listed, I can help you create an adapter.

Which agent would you like Dear Machine to use?`,
  productInstallation: 'I have what I need. I’m installing Machtiani and Dear Machine now. This may take a few minutes.',
  testEmail: (inboxAddress: string) => `Please send a short test email to ${inboxAddress}.

If you don’t see the reply in your inbox, check your spam folder and mark it as “Not spam.”

Tell me when you’ve sent it.`,
} as const

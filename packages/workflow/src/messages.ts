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
} as const

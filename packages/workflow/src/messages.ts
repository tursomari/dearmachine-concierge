export const messages = {
  welcome: `Welcome to Dear Machine,

Your computer can have an inbox of its own. Email it from anywhere, and it can work locally and write back in the same thread.

Would you like to continue with the installation now?`,
  notNow: 'Of course. Nothing was changed, and you can return whenever you’re ready.',
  provider: "Machtiani powers Dear Machine's AI reasoning. Which LLM provider would you like Machtiani to use? OpenRouter is recommended, or you can name another supported provider.",
  model: (provider: string) => `Which ${provider} model would you like Machtiani to use? If you’re unsure, I can recommend one.`,
  llmCredential: (provider: string, model: string) => `Machtiani needs your ${provider} API key to use ${model} for Dear Machine.

Paste it into the secure field below and press Enter. Your input is masked, saved directly to a private file, and never added to the conversation or sent to the installer model.`,
  emailTransport: "Dear Machine needs an email service to receive messages and send replies. Supported services are AgentMail (US-based), OpenMail (EU-native), and Sendmux. Which would you like to use?",
  agentMailHelp: "If you don’t already have an AgentMail API key, a free tier is available. Do you need help getting one?",
  emailCredential: (transport: string) => `Dear Machine needs your ${transport} API key to connect to the email service you chose.

Paste it into the secure field below and press Enter. Your input is masked, saved directly to a private file, and never added to the conversation or sent to the installer model.`,
  authorizedSender: 'What email address should be allowed to send work to Dear Machine?',
  magnificaHumanitas: `Dear Machine can share a short quote from Magnifica Humanitas, Pope Leo XIV’s encyclical on artificial intelligence. It is entirely optional. For example:

“To disarm does not mean rejecting technology, but preventing it from dominating humanity.”

“Today, justice requires access to the benefits of innovation, including care, knowledge, tools and opportunities.”

“…freedom in the digital age is not merely a matter of interiority but also a public concern.”

A quote can appear in Dear Machine’s email footers and in Machtiani’s terminal banner. Including a quote requires no extra AI request.

Would you like to include these quotes? The default is “No, thanks.”`,
  backendReadiness: (detectedAgents: string) => `Dear Machine delegates work to a backend agent—a separate AI worker similar to a subagent. I found these supported agents already installed: ${detectedAgents}.

With your permission, I can check whether they are signed in and ready. May I do that?`,
  backendChoice: (readinessSummary: string, readyAgents: readonly string[]) => {
    if (readyAgents.length === 1) return `${readinessSummary}

Dear Machine only needs one backend; adding another is optional. ${readyAgents[0]} can make changes on your behalf, and Dear Machine will ask when authorization is needed.

Use ${readyAgents[0]}?`
    if (readyAgents.length > 1) return `${readinessSummary}

Dear Machine only needs one backend. The selected agent can make changes on your behalf, and Dear Machine will ask when authorization is needed.

Which ready agent should it use?`
    return `${readinessSummary}

Dear Machine needs one ready backend before installation can continue.

Which installed agent would you like to configure?`
  },
  productInstallation: 'I have what I need. I’m installing Machtiani and Dear Machine now. This may take a few minutes.',
  testEmail: (authorizedSender: string, inboxAddress: string) => `Please send a short test email from ${authorizedSender} to ${inboxAddress}.

If you don’t see the reply in your inbox, check your spam folder and mark it as “Not spam.”

Tell me when you’ve sent it.`,
  installationOutcome: (backend: string, inboxAddress: string) => `Installation outcome

SUCCESS

Machtiani and Dear Machine are installed, ${backend} passed its health check, and a live email to ${inboxAddress} received a reply.

Human actions: chose the provider, model, email transport, authorized sender, and backend; entered any needed credentials through private masked fields; and sent the test email.

Configuration: ~/.machtiani/config.toml and ~/.dearmachine/config/dearmachine.toml
Logs: ~/.dearmachine/log/dearmachine.log

No further manual action is required.`,
} as const

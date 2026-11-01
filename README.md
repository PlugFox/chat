# Vault Chat

> Working name. Early stage: milestone v1 is built, but it has had no
> independent security review and its formats may still change.

A self-hostable personal AI assistant: a chat with an LLM agent, a notebook,
saved messages and personal data tables (weight, steps, …). Data is stored
encrypted on the server under keys only your client holds; the agent sees a
piece of your data only when you approve a request for it.

Each user brings their own LLM: an OpenAI-compatible or Anthropic API, or a
self-hosted model such as Ollama.

## What is and is not protected

Protected: database, backup and storage leaks; an operator reading stored
data; the agent reaching data you did not grant.

**Not protected**: the server and your LLM provider see what is sent in a
turn — your message, the chat context and any data you approve. A malicious
server could also serve malicious client code. The full list is in
[docs/threat-model.md](docs/threat-model.md). Losing all your keys means
losing your data; there is no recovery by design.

## Documentation

[docs/README.md](docs/README.md) — threat model, cryptography, protocol, roadmap.

## License

[AGPL-3.0](LICENSE).

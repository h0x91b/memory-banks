# Project Rules — memory-banks

Project-local rules for Claude when working in this repo. The global `~/.claude/CLAUDE.md` still applies; rules here add detail or override only where stated.

## Git Commit Messages — detailed rules

Hard requirements for every commit in this repository:

- **English only.** Even if the user wrote the request in Russian (or any other language), the commit message is in English. Translate the intent, don't transliterate.
- **About code, not chat.** The message describes what the code now does / what was added / changed / removed. It does NOT describe how we got there, what the user asked, or how the conversation went.
- **No "lyrics" from chat.** Do not copy or paraphrase the user's verbatim phrasing. Examples of what NEVER goes into a commit message:
  - `Так, ну что, давай, собственно, …` (raw Russian dictation)
  - `Можешь, пожалуйста, добавить …`
  - `fetch https://flueframework.com/start.md to create a new agent` (describes the *process*, not the code)
  - `init` (vague — say what was initialized)
  - `as the user requested, …` / `per user feedback, …` (process narration)
- **Imperative subject line, ≤ ~72 chars.** Examples of good subjects:
  - `Add npm serve script with fixed port`
  - `Refactor curator role to drop grep`
  - `Pin OpenRouter provider order to Novita`
  - `Replace hello agent with memory-bank curator`
- **Body (when needed) explains the technical why** — measured effects, design tradeoffs, non-obvious constraints. Still English. Still about the code, not the conversation.
- **No personal/lyrical content in any commit, branch name, or PR description.** This repo is intended for public GitHub; assume every commit is reader-facing.

If in doubt: write the message as if you were the sole author and the chat had never happened.

## Public GitHub readiness

This repo is going to be published to public GitHub. Before suggesting any commit or push, double-check that the change does not introduce:

- Real secrets, tokens, API keys, or `.env` files (only `.env.example` with placeholder values is allowed).
- Personal data: real email addresses other than `arsenyp@wix.com` in commit metadata (which is intentional), private file paths that leak machine layout beyond what's already present, internal Wix/Base44 references that don't belong here.
- Anything that would embarrass either the project or the author if read by a stranger.

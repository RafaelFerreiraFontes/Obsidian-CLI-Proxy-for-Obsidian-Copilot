# Obsidian CLI proxy

A local Fastify server exposing `GET /v1/models`, `POST /v1/chat/completions`, and `GET /health`. Routes chat requests to the authenticated Codex or Antigravity CLI installed on your machine. Supports JSON completions and OpenAI SSE chunks.

## Run

Requires Node.js 22+, npm, and `codex` / `agy.exe` (Windows) or `agy` (macOS/Linux) on PATH. Authenticate each CLI interactively in your normal terminal first, using the same OS account as this server.

```powershell
npm install
npm run build
npm start
```

The default address is `http://127.0.0.1:3000`. For development, use `npm run dev`. Stop with Ctrl+C; active CLI processes are terminated during shutdown.

## Obsidian Copilot setup

In Providers/BYOK, add a custom OpenAI-compatible provider (called **3rd party (OpenAI format)** in older versions):

- Base URL: `http://127.0.0.1:3000/v1`
- API key: any placeholder, such as `local-cli`, if Copilot requires one. The proxy uses CLI authentication and does not validate this key.
- Models: discover models or manually enter `codex/default` and `agy/default`.
- Leave Copilot's **Enable CORS** workaround off to retain streaming. The proxy supplies `Access-Control-Allow-Origin: *`, which permits `app://obsidian.md`, and handles preflight requests.

Use Quick Chat/basic chat. This proxy does not implement the tool-calling protocol needed by agent integrations, embeddings, or multimodal requests.

## Models and configuration

`codex/default` and `agy/default` omit the CLI model override, using its configured default. Any `codex/<model-id>` or `agy/<model-id>` is routed to that CLI with `--model <model-id>`. The CLI validates availability. Model IDs are not translated or guessed from outdated examples.

`/v1/models` always lists the two defaults. To advertise additional models, set `PROXY_MODELS` to a comma-separated list of prefixed IDs obtained from your CLI/account. Antigravity exposes `agy models`; the inspected Codex CLI does not expose a model-list command.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | Listen port |
| `CLI_TIMEOUT_MS` | `120000` | Whole-request CLI timeout |
| `CODEX_BIN` | `codex` | Native executable name or absolute path |
| `AGY_BIN` | `agy.exe` on Windows, `agy` elsewhere | Native executable name or absolute path |
| `PROXY_MODELS` | empty | Extra prefixed IDs to advertise |

Pass executable paths without shell syntax or extra arguments. On Windows, use native `.exe` files, not `.cmd`/PowerShell shims. The server inherits your environment, including CLI credential-home settings such as `CODEX_HOME`. `.env` files are not loaded automatically.

The server binds to loopback and has no API authentication. With wildcard CORS, browser pages can also call it. Keep this in mind before exposing the port or changing `HOST`.

## CLI behavior

Codex runs:

```text
codex exec --skip-git-repo-check --ephemeral --color never --sandbox read-only -c approval_policy="never" [--model ID] -
```

The structured conversation is sent through stdin. Codex's plain stdout contains the final assistant message; diagnostics remain on stderr. SSE forwards output as soon as stdout arrives, but Codex can buffer the answer until the end of its turn. This does not promise token-by-token delivery.

Antigravity runs:

```text
agy --input-format stream-json --output-format stream-json --disable-slash-commands [--model ID]
```

One documented `user` event is sent through stdin, then stdin is closed. Only `agent_response.text_delta` values are forwarded; init/tool events and the duplicate final response are omitted. A result-only response is also supported. Failed or missing result events are errors, even if the process exits zero.

Messages with `system`, `developer`, `user`, and `assistant` roles are serialized into a JSON transcript. String content and arrays of text blocks are accepted. This preserves conversation context within a single invocation; CLI sessions are not reused between HTTP requests. Transcript instructions request chat-only behavior, but they do not disable the CLIs' tool capabilities. Codex runs read-only; Antigravity retains its existing permissions.

`temperature` is validated but ignored because neither inspected CLI provides a sampling-temperature flag. Additional OpenAI options such as token budgets and `stream_options.include_usage` are accepted for client compatibility but are not applied. Token usage is omitted rather than estimated. Only one completion is supported; tools and non-text content are rejected.

The request body limit is 4 MiB and CLI stdout is capped at 8 MiB. UTF-8 characters and ANSI sequences split across chunks are handled. Both modes have deadlines, capped stderr diagnostics, and process-tree cancellation. Windows cancellation uses `taskkill.exe /T /F`; Unix uses a dedicated process group. A normal request-body `close` event does not cancel a still-active response.

Errors before streaming return OpenAI-shaped JSON with an HTTP error status. Errors after SSE headers have been sent return an `error` frame followed by `[DONE]`, without a successful `finish_reason: "stop"` chunk. Successful streams end with a stop chunk and `[DONE]`.

## Verify

```powershell
npm run build
npm test
curl.exe -sS http://127.0.0.1:3000/health
curl.exe -sS http://127.0.0.1:3000/v1/models

'{"model":"codex/default","messages":[{"role":"user","content":"Reply with OK"}],"stream":false}' | Set-Content request.json
curl.exe -sS -H "Content-Type: application/json" --data-binary "@request.json" http://127.0.0.1:3000/v1/chat/completions

'{"model":"agy/default","messages":[{"role":"user","content":"Reply with OK"}],"stream":true}' | Set-Content request.json
curl.exe -N -H "Content-Type: application/json" --data-binary "@request.json" http://127.0.0.1:3000/v1/chat/completions
```

Tests compile with a separate TypeScript config and run through Node's test runner. They use native subprocess fixtures, require no CLI credentials, and verify routing, JSON/SSE formatting, CORS, Unicode/ANSI handling, errors, validation, deadlines, disconnects, and descendant cleanup during shutdown. Fixture success is distinct from authenticated live CLI success.

## References consulted

Consulted on 2026-10-24 before implementing the runners:

- [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), local `codex --help` and `codex exec --help`.
- [Antigravity CLI reference](https://antigravity.google/docs/cli/reference/), [headless protocol](https://antigravity.google/docs/cli/headless), local `agy.exe --help`, `agy.exe models --help`, and `agy.exe models`.
- [Copilot documentation repository](https://github.com/logancyang/obsidian-copilot/tree/master/docs), [current settings documentation](https://docs.obsidiancopilot.com/settings/), and [chat provider implementation](https://github.com/logancyang/obsidian-copilot/blob/master/src/LLMProviders/chatModelManager.ts).

In the restricted development environment, live Codex execution could not locate its home directory; Antigravity reported missing login and denied state/log writes. Antigravity's interactive login fallback is detected and terminated with a `cli_authentication_error`, instead of waiting for OAuth during an HTTP request. Live authenticated completions must be checked from a terminal that can access your existing CLI credentials and provider network. Neither credentials nor permissions are changed by this project.

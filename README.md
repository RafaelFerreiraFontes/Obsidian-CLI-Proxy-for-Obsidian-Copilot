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

Quick Chat/basic chat supports the Portuguese approval prompts described below. Valid OpenAI `tools`, assistant `tool_calls`, and `role: "tool"` messages are accepted. Codex can bridge client tools through its app-server dynamic-tool protocol; Antigravity's headless protocol does not provide client-defined dynamic tools. Embeddings, images, and audio are not supported.

## Models and configuration

`codex/default` and `agy/default` omit the CLI model override, using its configured default. Any `codex/<model-id>` or `agy/<model-id>` is accepted even if it is absent from `/v1/models`. The suffix is passed to the CLI without checking an allowlist. Only the seven known Codex aliases below are normalized to lowercase; custom IDs preserve their exact case.

`GET /v1/models` includes both defaults and these seven hardcoded Codex IDs:

```text
codex/gpt-6.1-sol
codex/gpt-6-astra
codex/gpt-6-sol
codex/gpt-6-luna
codex/gpt-5.6-sol
codex/gpt-5.6-terra
codex/gpt-5.6-luna
```

For example, `codex/GPT-6.1-Sol` routes to the same CLI model as `codex/gpt-6.1-sol`. Advertising these IDs does not guarantee access for your account.

Antigravity discovery runs `<AGY_BIN> models`, parses its table, and prefixes IDs with `agy/`. It has a five-second deadline, a 60-second in-memory cache, and shared in-flight discovery for concurrent requests. Missing executables, login errors, timeouts, and empty output fall back to:

```text
agy/gemini-4-argon-medium       agy/gemini-4-argon-high       agy/gemini-4-argon-low
agy/gemini-3.8-flash-high       agy/gemini-3.8-flash-medium   agy/gemini-3.8-flash-low
agy/claude-opus-5-5-low         agy/claude-opus-5-5-medium    agy/claude-opus-5-5-high
agy/claude-sonnet-5-5-low       agy/claude-sonnet-5-5-medium  agy/claude-sonnet-5-5-high
agy/gpt-oss-120b-medium
```

`PROXY_MODELS` still adds comma-separated custom IDs, with duplicates removed. Unlisted IDs such as `codex/my-custom-model` are passed through unchanged. A CLI rejection matching an invalid/unknown/unsupported model becomes an OpenAI error with HTTP 404, `code: "model_not_found"`, and `param: "model"`. If SSE headers were already sent, the error is an SSE frame followed by `[DONE]`, with no successful stop chunk.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | Listen port |
| `CLI_TIMEOUT_MS` | `120000` | Active execution timeout; restarted after each decision |
| `APPROVAL_TIMEOUT_MS` | `300000` | Time allowed for a pending chat/tool response |
| `CODEX_BIN` | `codex` | Native executable name or absolute path |
| `AGY_BIN` | `agy.exe` on Windows, `agy` elsewhere | Native executable name or absolute path |
| `PROXY_MODELS` | empty | Extra prefixed IDs to advertise |

Pass executable paths without shell syntax or extra arguments. On Windows, use native `.exe` files, not `.cmd`/PowerShell shims. The server inherits your environment, including CLI credential-home settings such as `CODEX_HOME`. `.env` files are not loaded automatically.

The server binds to loopback and has no API authentication. With wildcard CORS, browser pages can also call it. Keep this in mind before exposing the port or changing `HOST`.

## Interactive authorization in Copilot

1. Ask the model to run a command or edit a file.
2. When the CLI requests authorization, the proxy completes the current HTTP response with **⚠️ Solicitação de Permissão de Execução**, the proposed command/action or diff, working directory, and reason. The process remains paused in memory.
3. In the same chat, reply with exactly `aprovar`, `allow`, `y`, or `sim` to approve; reply `negar`, `deny`, `n`, `não`, or `nao` to deny. Case and surrounding whitespace are ignored.
4. The proxy responds to that CLI's pending request and streams the continued result. A new action requires a new approval. Other replies repeat the prompt without executing anything.

The client must preserve the assistant response, including its HTML session marker, and the prior conversation history in the next request. The pending action is bound to a conversation hash, canonical model, and the supplied Authorization/user/conversation identifiers. Switching models or credentials, editing the prior transcript, replaying an answered request, or approving an expired request cannot execute the action. A standalone `sim` without a pending action returns `approval_not_pending`. Expired actions return HTTP 410; context mismatches return 409. If Copilot trims the transcript/marker, submit the original task again.

Sessions are in memory, limited to 32 active/pending turns, and survive only while an action/tool is pending. Normal completed turns start fresh on the next request using its transcript. Restarting the proxy loses pending sessions. The default approval deadline is five minutes; active execution deadlines are suspended during this wait. Client disconnect during an active HTTP response, expiry, and shutdown terminate the process tree. Finishing the authorization-prompt response normally intentionally keeps the paused process alive.

### Codex approvals and native client tools

HTTP chat requests use `codex app-server --listen stdio://`. The proxy initializes a JSON-RPC connection, starts an ephemeral thread with `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"`, and `sandbox: "read-only"`, then starts a turn. It handles native command/file approval requests, displays all supplied request details and proposed changes, and responds with **one-action** `accept` or `decline`. It never grants `acceptForSession` or amends execution policy. Trusted operations may run without a request under the CLI's own policy; only native approval requests are held by this bridge. Unsupported interactive request types are rejected.

Client-provided function tools become Codex experimental `dynamicTools`. A native call is returned as an OpenAI assistant `tool_calls` message (or SSE delta) with `finish_reason: "tool_calls"`. The caller executes its own registered tool and returns a matching `role: "tool"`, `tool_call_id`, and content. The proxy delivers that output to the pending Codex request. The proxy does not execute client function tools itself.

Clients that implement a user-confirmation tool can optionally declare a function named `proxy_approve_action`. Its arguments contain `action`, `cwd`, and `reason`; it must return `{"approved":true}` or `{"approved":false}` **after collecting the user's decision**. The proxy then uses native tool-call messages for approvals. Ordinary Copilot chat does not need this tool and uses text prompts instead. Merely including unrelated tools never auto-approves a command.

### Antigravity approval hook

Antigravity's headless stream rejects `control_request` / `control_response`; tool progress events do not themselves authorize execution. Instead, the included `.agents/hooks.json` installs a workspace `PreToolUse` gate invoking `node dist/approval-hook.js`. Run the proxy from this project root and build it before using Antigravity, including before `npm run dev`. Every tool passes through this gate, including reads and file edits.

For each Antigravity invocation the proxy starts a private loopback approval bridge, with a random token supplied only in that child's environment. The hook holds execution while chat collects approval; explicit approval returns the documented `auto_approve` decision for that one invocation, honoring explicit deny rules. Denial returns `deny`. Missing bridge credentials, unreachable bridges, malformed payloads, and expiry fail closed. No shell command is extracted from model prose and executed by the proxy, and no global CLI settings or broad permission bypass flags are used.

The workspace hook also applies when you invoke `agy` directly **inside this project**: without the proxy bridge its tools are denied. It does not install a global hook or alter other workspaces. If running from another directory, that directory needs the equivalent hook plus built handler; a missing hook is reported as `approval_hook_missing`.

## CLI output and limits

The Codex runner retains its plain `exec` adapter for programmatic calls without an approval callback:

```text
codex exec --skip-git-repo-check --ephemeral --color never --sandbox read-only -c approval_policy="never" [--model ID] -
```

HTTP requests use the interactive app-server adapter described above, forwarding assistant text deltas rather than terminal output. The plain adapter emits only the final answer.

Antigravity runs:

```text
agy --input-format stream-json --output-format stream-json --disable-slash-commands [--model ID]
```

One documented `user` event is sent through stdin, then stdin is closed. The hook's private HTTP connection handles authorization independently of that stdin stream. Only `agent_response.text_delta` values are forwarded; init/tool progress and the duplicate final response are omitted. A result-only response is also supported. Failed or missing result events are errors, even if the process exits zero.

Messages with `system`, `developer`, `user`, `assistant`, and `tool` roles are serialized into a JSON transcript. String content and arrays of text blocks are accepted; assistant tool messages may have null content.

`temperature` is validated but ignored because neither inspected CLI provides a sampling-temperature flag. Additional OpenAI options such as token budgets and `stream_options.include_usage` are accepted for client compatibility but are not applied. Token usage is omitted rather than estimated. Only one completion is supported; non-text content is rejected.

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

Tests compile with a separate TypeScript config and run through Node's test runner. Native subprocess fixtures verify discovery/cache/fallback, model aliases and passthrough, model errors, JSON/SSE output, actual deferred sentinel writes on approval, denial, context isolation, replay/expiry, native tool round trips, the hook's fail-closed behavior, and descendant cleanup. Fixture success is distinct from authenticated live CLI success.

## References consulted

Consulted on 2026-10-24 before implementing the runners:

- [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [app-server protocol](https://learn.chatgpt.com/docs/app-server), local `codex app-server --help` and generated stable/experimental TypeScript protocol schemas.
- [Antigravity CLI reference](https://antigravity.google/docs/cli/reference/), [headless protocol](https://antigravity.google/docs/cli/headless), [PreToolUse hooks](https://antigravity.google/docs/hooks/), local `agy.exe --help`, `agy.exe models --help`, and `agy.exe models`.
- [Copilot documentation repository](https://github.com/logancyang/obsidian-copilot/tree/master/docs), [current settings documentation](https://docs.obsidiancopilot.com/settings/), and [chat provider implementation](https://github.com/logancyang/obsidian-copilot/blob/master/src/LLMProviders/chatModelManager.ts).

In the restricted development environment, live Codex execution could not locate its home directory; Antigravity reported missing login and denied state/log writes. Antigravity's interactive login fallback is detected and terminated with a `cli_authentication_error`. Live authenticated completions and the installed CLI's hooks must be checked from a terminal that can access your existing CLI credentials and provider network. Authentication credentials and global permission settings are not changed; this project includes the workspace approval hook described above.

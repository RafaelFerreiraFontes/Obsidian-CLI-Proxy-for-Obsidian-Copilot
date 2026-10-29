# Relatório de implementação — 2026-10-28

## Git e escopo

- Raiz: `C:/Users/fedet/OneDrive/Documentos/Web Projects/obsidian-cli-proxy`.
- Branch inicial/final: `master`.
- HEAD inicial/final: `c7ae79d270e6c3c27763b0fc29e971b953bafda1`.
- Preflight: havia somente `package.json` modificado, com o start carregando `.env`.
- O comportamento dessa alteração foi incorporado ao bootstrap comum de dev/start com `process.loadEnvFile`, ancorado no ServerRoot. O script start voltou a `node dist/index.js`; package.json coincide com o HEAD, mas continua carregando `.env`, agora opcional e independente do cwd.
- Não houve commit, push, merge, reset, checkout destrutivo, alterações na Starlight, login ou alteração de configurações globais de produtos.
- `.env` real não foi lido para diagnóstico, modificado nem registrado; continua ignorado. Fixtures copiam somente código e criam seus próprios arquivos de configuração fictícia.
- O Git exigiu safe.directory por ownership do sandbox: usado somente `git -c safe.directory=...` por comando, sem alteração global.

## Arquivos entregues

Novos:

- `.agents/approval-launcher.mjs`
- `.env.example`
- `src/config.ts`
- `src/utils/cli-error.ts`
- `test/helpers.ts`
- `test/hardening.test.ts`
- `IMPLEMENTATION_REPORT.md`

Modificados:

- `.agents/hooks.json`, `README.md`
- `src/index.ts`, `src/routes.ts`, `src/types.ts`, `src/sessions.ts`, `src/approval-hook.ts`
- `src/providers/base.ts`, `codex-runner.ts`, `codex-app-server.ts`, `agy-runner.ts`, `agy-approval-bridge.ts`
- `test/proxy.test.ts`, `test/features.test.ts`
- `test/fixtures/cli.mjs`, `test/fixtures/codex-app-server.mjs`

`.gitignore`, modelos, formatador de prompt, dependências, lockfile e engines não precisaram de alteração. Dist, schemas gerados e artefatos de testes permanecem ignorados pelo Git.

## Arquitetura e resultado

Configuração validada centralmente; ServerRoot e HookRoot resolvidos por localização física do módulo. WorkspaceRoot/SessionWorkingDirectory são escolhidos somente por IDs locais autorizados, após autenticação Bearer real. O default é configurado explicitamente. Realpath e identidade de diretório são fixados por inicialização e revalidados por requisição, spawn e continuação.

Sessões vinculam identidade autenticada, modelo canônico, contexto de workspace/perfil e ferramentas. Trocas enquanto há ação pendente retornam conflito; IDs OpenAI de tool calls têm namespace e aleatoriedade por sessão. A ferramenta de aprovação reservada não é exposta ao modelo. Mantidos tokens por ação, contexto de histórico, proteção contra replay, deadlines e cancelamento.

Codex recebe cwd no spawn e em thread/start, sem herdar process.cwd(). Preservados initialize/initialized, threads efêmeras, turnos, SSE, dynamicTools, correlação, reviewer user, untrusted e decisões accept/decline por ação. read-only/supervised usam sandbox read-only; write-enabled opt-in usa workspace-write. Nunca há danger-full-access nem fallback de modelo.

AGY conserva chat e aprovações com stream-json em workspace explicitamente autorizado que tenha o hook suportado — atualmente a instalação do proxy. O launcher resolve o handler compilado por import.meta.url; não existe cópia para .agents/dist. O preflight verifica o mesmo arquivo importado. Testes executam o launcher efetivo no Windows, incluindo caminhos com espaços/Unicode, handler ausente/inválido, negação e token ausente.

HTTP: loopback padrão, exposição remota opt-in com autenticação, CORS de origens exatas, limites por identidade e limite global de sessões, corpo 4 MiB. Ambiente dos filhos usa allowlist específica por provider, excluindo a chave local, clientes, segredos arbitrários e NODE_OPTIONS. Diagnósticos autenticados omitem saída bruta e não confundem presença do executável com login/inferência.

## Configurar e selecionar workspaces

Todas as opções estão em `.env.example` e no README: HOST, PORT, CLI_TIMEOUT_MS, CLI_STARTUP_TIMEOUT_MS, APPROVAL_TIMEOUT_MS, CLI_MAX_OUTPUT_BYTES, CODEX_BIN, AGY_BIN, PROXY_MODELS, PROXY_WORKSPACES, PROXY_DEFAULT_WORKSPACE, PROXY_PROFILES, PROXY_API_KEY, PROXY_CLIENTS, CORS_ORIGINS, ALLOW_REMOTE, MAX_SESSIONS, MAX_REQUESTS_PER_MINUTE e DIAGNOSTICS.

Codex: cadastre o caminho absoluto do worktree em PROXY_WORKSPACES, autorize o ID para a identidade e envie Bearer, X-Proxy-Workspace e opcionalmente X-Proxy-Profile. Configure o default para Copilot/clientes sem header. O diretório pode ser completamente diferente do proxy; isso foi testado em duas sessões concorrentes.

Antigravity: mesma seleção por ID, com modelo agy/... e perfil agy. Um workspace externo retorna approval_hook_missing antes de iniciar processo. Nenhum fallback para o diretório do proxy é permitido. Usar a instalação do proxy como workspace requer cadastrá-la e autorizá-la explicitamente; isso não substitui suporte externo.

## Completo, parcial e BLOCKED

| Área | Estado | Evidência/limite |
| --- | --- | --- |
| .env dev/start, precedência, ausência, falhas, watch | Completo | Processos npm reais em fixtures |
| Workspace Codex, concorrência e políticas | Completo no adaptador | Spawn/thread verificados por fixture; login real não exercitado |
| Autenticação, CORS, limites, sessões e ambiente | Completo para o contrato implementado | Testes positivos/negativos, duas identidades e workspaces |
| Copilot básico e aprovações em português | Regressão automatizada preservada | Cliente GUI real ainda requer validação manual e migração da API key |
| Launcher/bridge AGY local | Implementado e testado com fixtures | Hook efetivamente carregado pelo AGY autenticado requer teste manual |
| AGY externo sem alterar projeto/config global | BLOCKED | CLI/help não oferece injeção de hooks por invocação verificada |
| Ferramentas Codex/OpenAI JSON/SSE | Completo no adaptador | Round-trip, IDs únicos, concorrência e contexto testados |
| AGY/OpenAI client tools via MCP | BLOCKED | Sem registro isolado verificado; requisições retornam tool_not_supported |
| OpenCode 2.2.0 e Traycer A2A reais | Não validado | OpenCode ausente no PATH, sem captura de tráfego real nem execução de Traycer |

AGY documenta hooks em workspace/global/plugin instalado. Sua ajuda instalada não oferece hooks/settings/MCP config temporário por invocação. Não alteramos projetos externos nem configuração global para contornar esse limite. A alternativa pronta é Codex para workspaces externos e ferramentas de cliente. O plano específico para AGY/MCP, incluindo registro por sessão, autenticação, schema, continuação, resultados e limpeza, está no README. Não há tool_calls simulados extraídos de texto.

## Testes e verificações

- Baseline `npm test`: **40/40 passaram** antes de modificar código.
- `codex --help`, `codex --version`, `codex app-server --help`, `codex app-server generate-ts --help` e geração local de schema experimental: Codex **0.164.0**; opções e tipos conferidos.
- `agy --help`, `agy mcp --help`, `agy mcp add --help`, `agy plugin --help`: somente consulta; nenhum comando de configuração executado.
- `npm run build`: passou (TypeScript; também incluído em npm test).
- Suíte expandida `npm test`: **63 testes, 63 passaram, 0 falhas, 0 skips**. Inclui dev/start com .env próprio, precedência, ausência/invalidade, reload, credenciais não expostas no startup, workspaces com espaços/Unicode, junction retargeting, renomeação, concorrência, identidade/perfil/ferramentas, modelos, JSON/SSE, aprovações, replay/expiração e encerramento de descendentes Codex/AGY por timeout/desconexão/shutdown.
- `git diff --check`: passou. Diferenças de LF/CRLF são avisos do Git do ambiente, sem erros de whitespace.
- No sandbox Windows, testes via npm atravessaram o limite de permissão de processos. As árvores de teste identificadas foram encerradas com autorização e a suíte final executou no contexto normal, com limpeza bem-sucedida. Uma falha inicial de teardown (remoção antes de parar npm) foi corrigida. Não foram encerrados serviços do usuário.
- Nenhum teste de inferência com credenciais reais, escrita na Starlight ou A2A real foi executado.

## Riscos e validação manual

cwd correto não impede acesso fora do projeto; sandbox do provider, configurações/MCP locais e permissões da conta continuam relevantes. Existe janela TOCTOU entre validação de caminho e spawn: use isolamento de SO/VM para fronteiras hostis. Proteja instalação/hooks e configuração do proxy contra alteração pelo agente. Compartilhar API key significa compartilhar identidade. Operações confiáveis do Codex podem não gerar pedido de aprovação; write-enabled é opt-in explícito. Erros retornados ao cliente autenticado podem conter diagnóstico limitado do CLI. UNC/volumes remotos não tiveram teste real. O diagnóstico --help não comprova login ou acesso a modelo e se refere aos executáveis padrão, não aos overrides de cada perfil.

No Windows:

1. Revise o diff e as configurações existentes. Não sobrescreva seu .env; acrescente autenticação e IDs autorizados com base no .env.example.
2. Mantenha HOST=127.0.0.1 e ajuste PORT=3557 se quiser seguir os exemplos.
3. Rode `npm run build`, `npm test` e `npm start` (ou `npm run dev`).
4. Use `http://127.0.0.1:3557/v1`, chave real e o ID explícito do worktree. Exemplos PowerShell constam do README.
5. Faça smoke test autenticado de Codex em diretório temporário; confira cwd, negue uma ação e confirme ausência de sentinela escrita. Teste o AGY somente no workspace permitido e confira /hooks antes de autorizar ações.
6. Valide Copilot real, provider OpenCode na versão 2.2.0, duas sessões simultâneas, cancelamento e ferramentas A2A do Traycer. AGY externo/MCP continua com aceite separado e bloqueado.

O diff foi deixado disponível para revisão independente; nenhum commit foi criado.

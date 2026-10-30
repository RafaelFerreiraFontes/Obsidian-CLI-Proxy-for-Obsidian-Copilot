# Etapa 2.2 — evidências e limites

Data: 2026-10-29. Branch inicial de referência: `review/agy-proxy-local-state`. Branch de trabalho criada: `feat/agy-production-mcp-bridge`. HEAD inicial e final: `21b85e6977c9d1d01efd208d93376e22dfaee2ce`. Alterações locais sem commit, push ou merge. `master` local e `origin/master` permaneceram em `c7ae79d270e6c3c27763b0fc29e971b953bafda1`.

## Resultado dos gates

| Gate | Resultado | Evidência e alcance |
|---|---|---|
| A1 — prazos independentes | PASS | Spawn, init, atestação, execução ativa, aprovação, ferramenta e encerramento separados; testes e inicialização nativa acima de 120s |
| A2 — D2 humano | PASS | HTTP/AgentSession real, AGY real, escrita após decisão explícita; segunda ação exige nova decisão e foi negada |
| A3 — runner externo protegido de produção | BLOCKED | Adaptadores de prova não habilitam o runner padrão; A4 nativo completo e garantia anterior a ferramentas ainda não demonstrados |
| B1 — MCP nativo | PASS | Registro temporário, initialize, tools/list, tools/call autenticado, retorno e continuação, após aprovação humana específica |
| B2 — bridge OpenAI/MCP | PASS no adaptador de prova | AGY real + Fastify HTTP + AgentSession: tool_calls, role:tool, resultado MCP e continuação; IDs inválidos/replay rejeitados. JSON nativo; JSON/SSE com fixtures |
| B3 — tools:client em produção | BLOCKED | Parser e runner padrão continuam rejeitando; isolamento de duas conversas MCP nativas concorrentes ainda não comprovado |
| C1 — OpenCode + Gemini ponta a ponta | BLOCKED | Contrato do OpenCode 2.2.0 passou com HTTP de fixture e leitura real do cliente; não houve execução OpenCode → AGY no runner de produção |
| C2 — continuação no fluxo OpenCode/AGY | BLOCKED | Continuação AGY após role:tool passou em B2; o fluxo combinado com OpenCode ainda não foi validado |
| C3 — Traycer A2A | BLOCKED / não executado | Depende de C2; não havia ferramentas Traycer disponíveis nesta sessão. Nenhuma mensagem A2A foi enviada |
| D — build/regressão/diff | PASS | Build, 127/127 testes, diff sem erros; 99 testes anteriores preservados |

AGY externo em produção e AGY/OpenAI Dynamic Tools de produção continuam **BLOCKED**. A integração não está completa. Obsidian Copilot real não foi executado; os contratos de API e regressões existentes passaram. Traycer A2A continua não validado.

## Ambiente e preflight

Raiz, branch, HEAD, remoto e árvore limpa foram conferidos antes das alterações. A branch nova deriva do HEAD de referência. Relatórios históricos, scripts manuais, registro de workspaces, hooks, bridge, sessões, configuração, rotas e providers foram inspecionados. Não havia instruções AGENTS.md aplicáveis encontradas nos diretórios verificados.

Executável observado: `C:/Users/fedet/AppData/Local/agy/bin/agy.exe`, **AGY 1.4.10**. SHA-256 antes, durante e depois dos ensaios:

```text
fade3d94282b8c1b12a24e54ffa930183bd6f6ff7a73a90421fb0aab4d9402ba
```

Node canônico: `C:/ProgramData/nvm/v24.19.0/node.exe`, versão `v24.19.0`. Modelo explícito: `gemini-3.8-flash-medium`. Não houve comando de atualização ou mudança observada no hash. Estes resultados descrevem o executável instalado e não garantem compatibilidade universal.

Todos os ensaios nativos usaram subdiretórios de um único workspace descartável em `%TEMP%/agy-stage22-084c22f887f7478681435a633e9c9d75`. O launcher de hooks continuou usando o Node canônico sem aspas internas e script relativo à pasta `.agents`. O MCP usa command e args separados, sem shell. Não houve alteração de `.env` real, vault, Starlight, Traycer, credenciais ou configurações globais.

## Implementação

`AgyLifecycle` controla fases independentes e erros específicos. AGY só inicia o prazo ativo depois de init e atestação. Esperas humana e de ferramenta têm limites próprios. `startupTimeoutMs` conserva o comportamento anterior do Codex. O encerramento de SpawnRunner e Codex App Server é limitado; cancelamento também funciona quando stdout já encerrou mas o processo permanece vivo. Init ausente, duplicado ou incompatível com o workspace é rejeitado.

O registro MCP exige outro plano consentido, preserva servidores de terceiros e grava apenas configuração estática e launcher. Verifica hashes, identidade de arquivos/diretório, Node e handler compilado, recusa links/junctions e conflitos. Backups e journal de recuperação ficam fora do workspace. Configuração não é regravada por sessão. Remoção preserva adições posteriores de terceiros ou restaura os bytes originais. Veja [AGY_MCP_REGISTRATION.md](AGY_MCP_REGISTRATION.md).

O adapter stdio fala JSON-RPC delimitado por linha e encaminha apenas operações estruturadas para uma bridge HTTP loopback. Cada invocação recebe token aleatório, ID e catálogo próprios. A bridge exige init nativo correlacionado com UUID e raiz autorizada antes de listar/chamar ferramentas. Preserva schemas, valida argumentos com Ajv, limita tamanho/profundidade, mantém somente uma chamada pendente, rejeita replay e liga resultado ao pedido original. Timeout, desconexão e cancelamento encerram a sessão pendente. O resultado do cliente chega ao MCP por `AgentSession.onToolCall`; o proxy não executa a ferramenta do cliente.

`proxy_approve_action` não é anunciada ao Gemini via MCP. O PreToolUse pode validar somente `call_mcp_tool` do servidor gerenciado através do validador da sessão; mesmo uma chamada válida continua exigindo uma decisão humana separada na bridge. Outros nomes, servidores ou ações sem caminho verificável continuam negados. A aprovação MCP não concede autorização para operações de arquivo ou shell.

O transporte está conectado ao runner, mas dois gates internos continuam fechados por padrão: execução externa e client tools. O parser ainda exige `tools:none` para AGY. Não há flag HTTP/ambiente para liberar os gates. Scripts de prova sobrescrevem métodos somente em subclasses restritas ao diretório descartável, verificam registro/hash e, no ensaio HTTP/MCP, injetam um perfil em memória. Esse adaptador não é uma configuração de produção. `/v1/capabilities` permanece com ferramentas AGY e workspaces externos desabilitados na configuração normal.

## Aprovação humana e negação

Em `http-approval`, a solicitação real `write_file` chegou pelo launcher/handler à bridge. O operador aprovou exclusivamente `approved.txt`, conteúdo exato `AGY_HTTP_HUMAN_APPROVED`, `Overwrite:false`. Sua decisão foi retransmitida como `aprovar` ao histórico HTTP real, sem callback que retorne true automaticamente.

Evidências UTC: init às 20:05:13.731; atestação às 20:07:12.578; primeira aprovação pendente às 20:07:18.303; decisão positiva às 20:07:53.986. O arquivo estava ausente antes da decisão e apareceu com conteúdo exato após ela. A segunda escrita, `second.txt`/`AGY_HTTP_SECOND_DENIED`, apresentou outro marcador de autorização às 20:07:58.630 e recebeu deny. O arquivo permaneceu ausente, sem reutilizar a primeira decisão. Verificação independente de existência/conteúdo confirmou os resultados. A reconstrução do hash da ação confirmou também os três argumentos exatos Path/Content/Overwrite:false registrados no ensaio.

Tentativas anteriores expiraram em deny sem criar sentinela. Uma delas não podia receber stdin porque o harness foi iniciado sem PTY; não foi tratada como autorização. A repetição com PTY utilizou a mesma escrita expressamente autorizada, ainda não executada. Não se reutilizou essa aprovação para MCP ou qualquer outra ação.

## MCP nativo e ciclo OpenAI

Os primeiros ensaios comprovaram herança da credencial efêmera, initialize e tools/list. AGY apresentou `call_mcp_tool` com `ServerName`, `ToolName` e `Arguments`; o hook retornava allow para a fixture exata, mas a política nativa negava a chamada antes de tools/call. Allow não equivale a aprovação de uma operação nativa. Esses ensaios permaneceram BLOCKED, inclusive com anotações readOnlyHint. Nenhum bypass ou auto_approve geral foi usado.

No ensaio `mcp-human`, o operador aprovou exclusivamente `echo_fixture({nonce:"7afcb2137644ef29d38d2c52"})`. A decisão foi validada pela bridge; tools/call alcançou o adapter autenticado, o cliente de fixture retornou `ECHO:7afcb2137644ef29d38d2c52` e o AGY continuou a inferência usando esse resultado. Eventos publicados usam hashes de sessão, conversa e request. O teste demonstra que a política nativa pode ser satisfeita por aprovação humana específica, sem habilitar permissões gerais.

No ensaio separado `mcp-http`, nova autorização humana foi solicitada e recebida para nonce `d5be048f6164d44b4916f512`. O caminho real foi:

```text
AGY → MCP stdio → bridge autenticada → AgentSession.onToolCall
→ HTTP OpenAI tool_calls / finish_reason:tool_calls
→ cliente de teste → role:tool com ID correspondente
→ mesmo pedido MCP → AGY → resposta final / finish_reason:stop
```

O cliente de teste executou apenas o eco em memória, retornando `CLIENT_HTTP_ECHO:d5be048f6164d44b4916f512`. O resultado foi confirmado na resposta final. Tool_call_id inválido e replay retornaram 410. `/health` confirmou zero sessões residuais. A aprovação AGY e a execução da ferramenta do cliente foram fases distintas.

## OpenCode e Traycer

`C:/Users/fedet/.opencode/bin/opencode.exe --version` retornou **2.2.0**. O exemplo README foi corrigido para provider singular, npm `@ai-sdk/openai-compatible`, options.baseURL/apiKey/headers e chaves de modelo upstream. As configurações do ensaio ficaram somente no diretório temporário, com chave no ambiente e placeholders no JSON. Não se editou opencode.json global nem se usou --auto.

OpenCode enviou Authorization Bearer correto, X-Proxy-Workspace, X-Proxy-Profile e `agy/gemini-3.8-flash-medium`. A requisição principal anunciou 12 ferramentas. O contrato observado de read usa `path`, não filePath. Após verificar o schema real, o servidor de fixture solicitou apenas essa leitura em arquivo descartável. OpenCode leu o conteúdo e enviou role:tool com o ID original. A resposta seguinte foi consumida normalmente.

Essa prova utiliza um upstream HTTP de fixture, não Gemini. O primeiro harness ficou esperando EOF no stdin e expirou sem requests; ao encerrar stdin explicitamente, o mesmo formato de provider funcionou. A primeira tentativa de leitura não executou nada porque o campo esperado não existia; não houve fallback para outra raiz.

O fluxo OpenCode → proxy → AGY → ferramenta do cliente completo ainda depende da habilitação segura e de validação do fluxo de aprovação entre os produtos. C1/C2 permanecem bloqueados nesse alcance. Traycer A2A não foi iniciado, não houve mensagens a outros agentes e Starlight não foi modificada.

## Testes, arquivos e segurança

`npm run build`: PASS. `npm test`: **127/127 PASS**, incluindo os 99 anteriores e 28 novos casos. `git diff --check`: PASS. Há avisos de normalização LF/CRLF do Git no Windows, sem erro de whitespace.

Novos testes cobrem fases e limites independentes, cancelamento após fechamento de stdout, init inválido/duplicado, registro MCP consentido, terceiros, junctions e integridade, autenticação e binding, schemas, argumentos, replay, chamada única, duas bridges concorrentes, troca de modelo, peer desconectado, timeout/cancelamento, stdio e EOF, separação de aprovação nativa, ciclos HTTP JSON/SSE e integração do runner com fixtures. Os testes prévios continuam cobrindo Codex, Copilot/API, workspaces, bridge ausente, hooks ausentes/alterados e encerramento de descendentes. Fixtures não substituem os ensaios nativos descritos acima.

Arquivos de implementação: `src/config.ts`, `src/providers/base.ts`, `src/providers/codex-app-server.ts`, `src/providers/agy-runner.ts`, `src/providers/agy-approval-bridge.ts`, `src/providers/agy-lifecycle.ts`, `src/providers/agy-mcp-bridge.ts`, `src/mcp-stdio.ts`, `src/agy-mcp-workspaces.ts`, `src/agy-mcp-workspace-cli.ts`, `src/sessions.ts`, `src/routes.ts`. Dependência direta Ajv 8.20.0 e script de registro em package.json/package-lock.json.

Testes e provas: `test/agy-stage22.test.ts`, `test/fixtures/cli.mjs`, novos scripts `agy-stage22-setup.mjs`, `agy-http-approval.mjs`, `agy-mcp-native.mjs`, `agy-mcp-human.mjs`, `agy-mcp-http.mjs`, `opencode-provider-smoke.mjs` em test/manual; [evidência sanitizada](test/evidence/agy-stage22.json). Documentação: README, .env.example, este relatório e AGY_MCP_REGISTRATION. Os três relatórios históricos receberam somente nota atual de supersessão.

Para repetir em ambiente compatível, rode build e depois `node test/manual/agy-stage22-setup.mjs`. O helper cria uma nova fixture e manifesto ignorado, recusa sobrescrever evidências existentes e recusa binário diferente do hash revisado. Os scripts nativos são opt-in, não integram npm test e registram hooks/MCP somente nessa fixture. Execute os ensaios humanos em terminal interativo, revise a ação apresentada e digite aprovar/negar; não forneça aprovação automática por pipe. O script OpenCode aceita um rótulo novo por execução, por exemplo `node test/manual/opencode-provider-smoke.mjs read-observed-contract`. Configurações globais não são alteradas. Estes scripts refletem o executável e caminhos observados neste ambiente, não um instalador portátil.

As configurações de hooks/MCP do experimento foram removidas pelos próprios registros, e leases/credenciais efêmeras foram encerradas. Sentinela aprovada e evidências descartáveis foram preservadas. Logs brutos, bancos/cache do OpenCode, registros privados, dist, node_modules, .tmp e .env não integram o diff. Não foi encontrado segredo real no conjunto revisado; fixtures usam credenciais sintéticas e os registros publicados omitem tokens, headers, prompts completos e argumentos sensíveis.

## Bloqueios e próximos pré-requisitos

Atestação posterior ao spawn e hashes de arquivos não impõem uma barreira de sistema operacional contra um CLI que ignore o hook. Os ensaios mostram a ordem observada nessa versão, sem provar a inexistência de todos os caminhos sem PreToolUse. Não há isolamento completo de filesystem obtido apenas por cwd/--add-dir/sandbox de terminal. A política de compatibilidade do binário de produção e o conjunto A4 nativo completo ainda precisam ser estabelecidos. Por isso assertExternalHookSupport permanece fechado.

Herança de credenciais por um processo MCP e duas bridges concorrentes de fixture não comprovam que o backend AGY jamais compartilhe/reutilize workers entre conversas nativas. Falta o ensaio simultâneo de duas conversas, catálogos e workspaces reais, incluindo cancelamento. Essa é uma pré-condição de B3. Esquemas incompatíveis com Ajv estrito são recusados; compatibilidade de todos os schemas de clientes reais não é afirmada. Ferramentas do cliente continuam sujeitas às permissões do próprio cliente.

Não há instrução manual de ativação de produção nesta entrega. Para experimentar, use somente fixtures descartáveis, revise planos separados de hooks e MCP e mantenha decisões humanas por ação. Não aplique subclasses de prova no servidor em uso. O exemplo OpenCode é para revisão manual; ele não remove os bloqueios. Traycer, A2A e Copilot real precisam de seus próprios ensaios autorizados antes de se declarar integração completa.

Fontes primárias consultadas: [hooks AGY](https://antigravity.google/docs/hooks/), [MCP AGY](https://antigravity.google/docs/mcp/), [headless AGY](https://antigravity.google/docs/cli/headless/), [providers OpenCode](https://opencode.ai/docs/providers/), [configuração OpenCode](https://opencode.ai/docs/config/), [transportes MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Documentação orientou o experimento; os PASS acima dependem das evidências reais e testes indicados.

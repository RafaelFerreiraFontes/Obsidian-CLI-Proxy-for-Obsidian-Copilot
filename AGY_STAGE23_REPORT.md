# Etapa 2.3 — hardening AGY/MCP e limites de produção

Data: 2026-10-29. Branch inicial/final: `feat/agy-production-mcp-bridge`. HEAD inicial/final: `21b85e6977c9d1d01efd208d93376e22dfaee2ce`. Base `review/agy-proxy-local-state` no mesmo commit. Sem commit, push ou merge. Master local e remota preservadas em `c7ae79d270e6c3c27763b0fc29e971b953bafda1`.

## Resultado

| Gate da etapa 2.3 | Estado | Alcance |
|---|---|---|
| A — runner externo protegido | BLOCKED | Preflight explícito implementado; cobertura anterior a toda ação protegida e contenção efetiva não demonstradas |
| B — isolamento MCP nativo completo | BLOCKED | Transporte endurecido e testes de duas sessões; descoberta nativa no mesmo workspace e em workspaces diferentes; matriz nativa completa ainda pendente |
| C — integração habilitada em produção | BLOCKED | Dependências A/B; guards de configuração, rotas e runner preservados |
| D — OpenCode real com AGY de produção | BLOCKED / NOT RUN | Não foi contornado o Gate C; fixture OpenCode histórica não equivale a esse fluxo |
| E — Traycer A2A | BLOCKED / NOT RUN | Sem ferramentas/sessão Traycer autorizada disponíveis; Starlight não modificada |
| Build, regressões e diff | PASS | `npm run build`, `npm test`: 149/149; `git diff --check` sem erro de whitespace |

A integração continua incompleta. Os PASS de D2 humano e do round-trip HTTP/MCP da etapa 2.2 permanecem válidos no seu alcance histórico de adaptador de prova, não são promoção do runner. Relatórios históricos e `test/evidence/agy-stage22.json` preservados byte a byte em relação ao início desta etapa. A evidência nova está em [test/evidence/agy-stage23.json](test/evidence/agy-stage23.json).

## Preflight e executáveis

Raiz, branch, HEAD, origin, referências e operações Git conferidos; havia 30 arquivos locais modificados/novos da etapa anterior. Foram preservados, com inventário SHA-256 privado para distinguir mudanças desta etapa. Nenhuma operação Git incompleta identificada. Suíte inicial: 127/127 PASS. Hooks, registro MCP, credenciais privadas, sessões, rotas, runners, testes e relatórios foram inspecionados.

AGY efetivamente observado: `C:/Users/fedet/AppData/Local/agy/bin/agy.exe`, versão **1.4.10**, SHA-256:

```
fade3d94282b8c1b12a24e54ffa930183bd6f6ff7a73a90421fb0aab4d9402ba
```

Hash monitorado durante os ensaios; nenhuma mudança nem comando de atualização. Node canônico `C:/ProgramData/nvm/v24.19.0/node.exe` (`v24.19.0`), modelo explícito `gemini-3.8-flash-medium`. Os resultados são específicos desse binário Windows. A ajuda instalada confirma stream-json, settings por sessão e sandbox de terminal; não foi configurada sandbox adicional, Full Access ou bypass. A identidade de processo via CIM é evidência de propriedade do transporte, não confinamento do AGY.

## Mudanças verificáveis

- `agy-capabilities.ts`: fingerprint revisado imutável e relatório de pré-condições (contexto autorizado, identidade/sessão, perfil supervised, registros íntegros, executável nativo). O resultado permanece inelegível: não há flag, header ou assert do operador que habilite produção. `/v1/capabilities` expõe os bloqueios efetivos.
- Runner/AgentSession: sessão OpenAI confiável e PID real do spawn; falha na associação de processo rejeita a requisição e encerra o filho sem exception não tratada; verificação de chamada órfã antes de aceitar conclusão. O adaptador de prova continua sendo a única via experimental para ultrapassar os guards, restrita às fixtures dos scripts.
- Bridge MCP: snapshot imutável de identidade, sessão, workspace, modelo, perfil e catálogo; ID explícito de sessão obrigatório, sem identidade substituta; token por invocação; attach de um único worker e lease efêmero; correlação com init nativo. Revalidações antes/depois da chamada; nenhum roteamento pelo nome, último pedido ou workspace compartilhado.
- `agy-process-witness.ts`: consulta CIM somente de PID, pai, data de criação e imagem, com prazo de 5s e saída limitada. Exige filho direto do processo iniciado pelo runner e Node canônico; rejeita processo ausente, PID reutilizado ou imagem diferente. Falha de acesso a CIM nega a sessão. Plataformas não Windows não possuem testemunho implementado e falham fechadas.
- Catálogo: tools/list anterior a init aguarda sob prazo limitado sem expor ferramentas; cancelamento/encerramento rejeitam a espera. A ordem de entrega das duas streams não é usada como identidade.
- Aprovação: decisão humana específica no callback confiável do PreToolUse gera admissão interna para nome/argumentos exatos, uso único e 30s para iniciar a chamada. A bridge MCP não tem endpoint de concessão; token de transporte sozinho não publica onToolCall. Desconexão do hook antes da decisão não concede admissão. Nenhuma resposta MCP aprova outra ação.
- IDs JSON-RPC preservados, IDs de transporte exclusivos, replay/concorrência/limites/esquemas validados. Uma chamada pendente por invocação; tool timeout independente da inferência. Cancelamento, detach, reinício do worker, resultado tardio e contexto alterado revogam a instância.
- Stdio e entrada HTTP/hook preservam UTF-8 fragmentado. Prazo humano acompanha o lease privado fora do workspace (campo opcional compatível com leases antigos), limitado a 580000ms; não depende de ambiente herdado pelo hook.

Os registros consentidos e configurações de terceiros continuam preservados. Nenhum segredo foi gravado em `.agents/mcp_config.json` ou hooks.json. Atualizar handlers exige parar sessões e renovar registro consentido; alteração de integridade durante uma decisão nega a ação.

## Diferenças entre prova e produção

Os scripts de prova instalam registros consentidos em diretórios temporários, usam AGY real e callbacks de operador explícitos; não habilitam asserções do runner padrão. Fixtures automatizadas exercitam Fastify, AgentSession, JSON/SSE e os mesmos transportes com um CLI Node controlado. Nenhuma delas prova comportamento irrestrito do AGY instalado.

O runner padrão continua rejeitando execução externa em assertExternalHookSupport; config exige AGY tools:none, rotas rejeitam ferramentas e assertClientToolSupport continua fechado. As informações de capacidade não são autorização. Perfil válido e binário revisado não bastam para abrir o gate.

## Hooks: evidência e garantia residual

O teste read-only usa somente arquivo descartável de conteúdo aleatório desconhecido do modelo. A primeira tentativa não observou a ferramenta: resultado inconclusivo, não evidência de bloqueio nem de fail-open. As repetições com leitura concreta observaram PreToolUse nos três casos: decisão deny, JSON inválido e deny com exit code 1 do handler. Nos três, tool state ERROR e conteúdo não recebido; o caso exit 1 também produziu diagnóstico nativo de falha do hook. Um envelope nativo SUCCESS ocorreu mesmo com a ferramenta negada; por isso o envelope isolado não é aceito como prova.

Esses ensaios cobrem falhas específicas desse dispatcher, não todas as ferramentas, plugins, subprocessos ou corridas do ciclo de vida. Não existe neste trabalho garantia verificável de cobertura anterior a toda ação protegida nem segunda fronteira de SO validada. Cwd, realpath, atestação posterior e árvore de processos não constituem sandbox. A permanece BLOCKED; testes HTTP positivos de produção e nova escrita humana nativa não foram executados pelo runner bloqueado. As evidências de aprovação/negação da etapa 2.2 foram preservadas.

## MCP nativo: observações

Foram executados pares de processos no mesmo workspace e em workspaces diferentes, com configuração MCP única por workspace (nenhuma reescrita por sessão), catálogos A/B de mesmo nome e descrições distintas. Cada processo iniciou seu worker; as mensagens observadas discover/initialize/tools/list não continham conversation_id nos parâmetros ou meta. Isso impede usar MCP puro para escolher a conversa. O ambiente exclusivo foi observado nesses processos; não é assumido como contrato universal.

Uma corrida real anterior à correção produziu tools/list antes da entrega de init no stdout do AGY, encerrando o worker com erro. Depois da correção, a listagem aguardou init e o catálogo correto foi enviado. Descoberta também passou com o testemunho CIM padrão no mesmo workspace e em dois diferentes. Isso comprova descoberta associada a processos observados, não reutilização segura universal de servidores.

A aprovação solicitada no primeiro par expirou em deny; a resposta humana posterior não foi reaproveitada. Um segundo ensaio foi invalidado por rebuild do handler durante sua execução e suas duas ações foram negadas pelo executor do ensaio, sem aprovação humana positiva; não conta como evidência positiva. Um novo par foi iniciado somente após o build e a suíte, com prazo humano limitado, sem reciclar autorizações. As duas conversas desse par encerraram sem decisão humana positiva e sem tools/call/client call; as configurações gerenciadas e leases foram removidos. O CLI encerrou antes do prazo configurado do callback humano: a causa não foi determinada, portanto não se classifica esse evento como timeout de uma fase específica. Um timer restante do callback do script de prova foi terminado após a limpeza; o script foi corrigido para cancelar esse timer junto com o signal da sessão. Nenhuma aprovação tardia foi reaproveitada.

A matriz nativa completa (cancelar A com B concluindo, expirar A, rejeitar resultado tardio, reiniciar processo e ferramenta removida, nos dois layouts) ainda não foi concluída. Os testes automatizados dessas propriedades passaram; não substituem a matriz real. Nenhum servidor global foi instalado, nem houve serialização anunciada como concorrência.

## Testes automatizados

127 testes anteriores preservados; 22 novos, total 149/149 PASS, sem skips/falhas. Incluem duas identidades autenticadas no mesmo workspace e em dois diferentes, catálogos/results distintos com o mesmo nome, credenciais/IDs estrangeiros, replay, chamada órfã, cancelamento de A sem afetar B, resultado tardio/expiração, worker reiniciado/removido, processo inexistente/PID reutilizado/imagem incorreta, falha de attach, bridge fechada, integridade/contexto/modelo, admissão negada/única/expirada, hook desconectado, UTF-8 fragmentado e prazo privado compatível.

O teste adicional de falha no callback de associação do processo comprova rejeição sem derrubar o servidor e encerramento do filho. As regressões anteriores cobrem falha de init/atestação, negação/permissões, JSON/SSE, ciclos tool_calls/role:tool, Codex, contratos do Obsidian Copilot e encerramento de descendentes. O CLI de fixture agora inicia o verdadeiro worker stdio Node como filho antes do PreToolUse, exercitando o testemunho CIM real nos testes de wiring. Testemunhos e decisões positivos injetados nos testes unitários são identificados como fixtures; não são aprovações humanas nem evidência nativa.

## OpenCode e roteiro Traycer posterior

Gate C bloqueado: nenhum ensaio OpenCode→AGY de produção foi tentado. A configuração manual e evidência OpenCode 2.2.0 com servidor de fixture da etapa 2.2 permanecem documentadas; não foram promovidas a validação nativa. Não há nova configuração global ou chave persistida.

Não foi encontrada sessão Traycer autorizada nem ferramenta Traycer habilitada neste runtime. Roteiro posterior, somente depois de A/B/C e OpenCode real aprovados:

1. Criar repositório/worktree descartável autorizado; perfis Supervised e chaves temporárias por identidade. Não usar Starlight/vault.
2. Abrir Coordinator Codex e Documentation Researcher OpenCode no ambiente Traycer consentido. Conferir identidade, worktree, modelo exato Gemini e permissões da sessão efetiva.
3. Confirmar traycer_get_self e traycer_send_message nas definições realmente anunciadas pelo OpenCode e no tools/list associado ao seu processo, sem inferir pelo catálogo geral. Confirmar headers Authorization, X-Proxy-Workspace e X-Proxy-Profile no servidor sem registrar valores secretos.
4. Coordinator envia tarefa inofensiva; Researcher usa get_self e responde via send_message. Registrar tool_call_id, hashes de sessão, responseId e recebimento pelo pai, sem publicar conteúdo privado.
5. Coordinator encaminha a QA Codex; confirmar parecer devolvido e mensagem final no pai. Rejeitar resultado de outra sessão e validar cancelamento/limpeza.
6. Recusa de permissão MCP ou ausência de ferramenta implica BLOCKED; não reativar provider AGY nativo, mudar políticas ou contornar recusa.

## Riscos e configuração

A conta Windows, instalação Node/AGY, estado privado e bridge devem ser confiáveis. Os tokens/leases por processo não isolam contra outro processo privilegiado da mesma conta. Testemunho CIM sofre a superfície normal de corridas de processo e não assina a identidade nativa no protocolo MCP. Não foi estabelecida contenção para ferramentas internas AGY. Não existem garantias universais a partir de um binário observado. Permanecem faltando a matriz nativa adversarial completa, runner HTTP de produção protegido, OpenCode real e Traycer A2A.

Manter ferramentas AGY em tools:none; não existe configuração manual de desbloqueio. Para repetir provas, revisar os scripts manuais, usar build estável, Node canônico, workspace temporário e consentimentos separados de hooks/MCP. Nunca recompilar handlers enquanto o ensaio estiver aberto. Aprovar somente as operações concretas pendentes; expiração é deny e novo processo exige nova decisão.

## Arquivos e diff

Novos nesta etapa: `src/providers/agy-capabilities.ts`, `src/providers/agy-process-witness.ts`, `test/agy-stage23.test.ts`, `test/mcp-client.ts`, `test/manual/agy-session-isolation.mjs`, `test/manual/agy-hook-failure-boundary.mjs`, este relatório e `test/evidence/agy-stage23.json`.

Alterados nesta etapa: `src/approval-hook.ts`, `src/hook-credentials.ts`, `src/providers/base.ts`, `src/providers/agy-runner.ts`, `src/providers/agy-approval-bridge.ts`, `src/providers/agy-mcp-bridge.ts`, `src/mcp-stdio.ts`, `src/routes.ts`, `src/sessions.ts`, `test/fixtures/cli.mjs`, `test/agy-stage22.test.ts`, `test/hook-credentials.test.ts`, `test/manual/agy-mcp-human.mjs`, `README.md`, `.env.example`, `AGY_MCP_REGISTRATION.md`. Outros arquivos já modificados no início são entregas preservadas da etapa 2.2.

Revisão independente: git diff para rastreados e inspeção explícita dos novos listados, sem git add. Dist/node_modules/.tmp/.local e diretórios de experimento não entram no diff. Sem mudança de .env real, credenciais, políticas globais, Obsidian, Starlight ou master.

## Fontes primárias e alcance

- [AGY hooks](https://antigravity.google/docs/hooks/): contrato PreToolUse; não demonstra cobertura de todas as ações deste binário.
- [AGY MCP](https://antigravity.google/docs/mcp/): configuração por workspace; identidade/reuso foram investigados nos processos reais.
- [AGY sandbox](https://antigravity.google/docs/sandbox/): sandbox de terminal; não foi inferido confinamento completo do CLI.
- [Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process): identidade de PID exige considerar criação/reuso; pai sozinho não basta.


Verificação final: build e suíte final 149/149 PASS, nenhum skip; diff check PASS. Git apenas com alterações locais revisadas, sem staging/commit/push/merge; master e origin/master conferidas também por consulta remota read-only. O aviso de conversão LF→CRLF decorre dos atributos Git existentes, sem erro de whitespace. Auditoria dos arquivos alterados/novos não encontrou credenciais reais nem artefatos proibidos. O patch cumulativo de HEAD para o working tree, incluindo arquivos novos e entregas anteriores preservadas, está em `.tmp/agy-stage23-review.patch` (ignorado pelo Git); não é um commit nem um patch exclusivo da etapa 2.3.

Limpeza final: 12 PIDs AGY e 12 PIDs de workers conhecidos sem processos correspondentes nem filhos diretos dos AGYs na consulta CIM final; nenhum arquivo de credencial em `.local/agy-runtime`. Configurações gerenciadas das provas MCP removidas via planos de remoção; configurações das fixtures read-only removidas somente após o término dos processos. Evidências sanitizadas preservadas; nenhum processo de projeto real foi encerrado.

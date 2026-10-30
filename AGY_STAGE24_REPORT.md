# Etapa 2.4 — aprovação MCP, identidade nativa e contenção

Data: 2026-10-30. Branch inicial/final: `feat/agy-production-mcp-bridge`. HEAD inicial/final: `21b85e6977c9d1d01efd208d93376e22dfaee2ce`. Master e origin/master locais: `c7ae79d270e6c3c27763b0fc29e971b953bafda1`. Sem staging, commit, push ou merge.

## Preflight e escopo

Branch, HEAD e alterações locais conferidos antes das edições; o working tree já continha as entregas das etapas 2.2/2.3. Relatórios, evidências JSON, patch cumulativo `.tmp/agy-stage23-review.patch`, registry, leases, bridge de aprovação, transporte MCP, runner, SessionManager, rotas e regressões foram revisados. O inventário privado de hashes permite separar esta etapa das alterações anteriores. Baseline efetivamente executado: **149/149 PASS**.

Relatórios 2.2/2.3, suas evidências e o patch histórico foram preservados byte a byte. Alterações novas ficaram no repositório e em diretórios `agy-stage24-*` expressamente criados em TEMP. Não houve uso de vault, Starlight ou sessão Traycer. Os scripts não editaram credenciais existentes/configurações globais e não executaram comandos de atualização do AGY; as substituições automáticas do executável estão registradas abaixo.

## Gates

| Gate | Resultado | Evidência / limite |
|---|---|---|
| A — chamada MCP real aprovada e continuada | PASS | `l4TKoT`: duas decisões humanas específicas, MCP → HTTP tool_calls → role:tool → resultado MCP → continuação AGY nas próprias conversas, HTTP 200 |
| B — isolamento nativo completo | BLOCKED | Positivos e cancelamento A/B passaram nos dois layouts; reinício físico/worker órfão e ferramenta não registrada não foram exercitados com AGY real |
| C — hooks e contenção independente | BLOCKED | Leitura, escrita e comando negados em dispatchers observados; rede inconclusiva e nenhuma fronteira de SO do AGY inteiro validada |
| D — promoção do runner | BLOCKED | B/C insuficientes; guards, defaults e capacidades conservadores preservados |
| E — OpenCode / Traycer real | NOT RUN | Runner de produção bloqueado; nenhuma sessão/ferramenta Traycer autorizada disponível |

Os PASS de fixtures automatizadas não promovem esses gates. O primeiro round-trip autorizado que devolveu 502 permanece uma tentativa funcional **FAIL** histórica desta etapa; o PASS de A veio da repetição nativa correlacionada. Expiração ou encerramento sem decisão aplicada permanece **BLOCKED** e nega a ação.

## Mudanças independentes

- `mcp-stdio.ts` encaminha somente os campos de identidade nativa observados em `tools/call`: `_meta["antigravity.google/conversation_id"]` e `_meta["antigravity.google/root_conversation_id"]`.
- A bridge exige ambos iguais ao UUID nativo atestado, além de Bearer efêmero, sessão, workspace, peer, lease, testemunho de processo, schema e admissão humana específica. Identidade ausente/estrangeira é negada antes de consumir a autorização; não há fallback para PID, cwd ou nome da ferramenta. Conversas de subagentes não recebem autorização implícita.
- A desconexão do peer é revalidada também depois da verificação assíncrona final de processo, impedindo evento de resultado resolvido após essa desconexão.
- O sink confiável `RunnerConfig.agyMcpObserver` recebe hashes separados de sessão HTTP/MCP, conversa, peer, lease, request e RPC; PIDs observados; catálogo nativo; estados e etapa/código sanitizado de rejeição. Não recebe argumentos, tokens, prompts ou texto do resultado. Não existe opção HTTP que instale esse sink ou conceda ferramentas.
- Novos scripts usam fixtures com string fixa `SESSION_A_RESULT` / `SESSION_B_RESULT`, mesma ferramenta `echo_fixture`, schema `{type:"object",properties:{},additionalProperties:false}`. Decisões positivas dependem de registro explícito do operador para um request aleatório pendente; nenhum callback do ensaio nativo retorna true automaticamente.

O protocolo nativo de descoberta não trouxe identidade de conversa. O primeiro `tools/call` desta etapa trouxe chaves namespaced em `_meta`. A ausência na descoberta não justificava inferir ausência em todas as chamadas. O contrato experimental agora falha fechado para binários sem esses campos; o fingerprint/guard de produção não foi ampliado.

## Causa observável da etapa 2.3

As evidências históricas mostram callbacks de aprovação pendentes sem decisão positiva aplicada. Logo, não houve admissão de uso único, `tools/call` nem publicação de ferramenta do cliente nesses pares. Um ensaio expirou, outro foi invalidado por rebuild e outro encerrou nativamente antes do prazo configurado. A corrida `tools/list` anterior ao init já havia sido corrigida e a descoberta voltou a funcionar.

Não há evidência suficiente para atribuir retrospectivamente todo encerramento do 2.3 a um timeout interno específico. Nesta etapa foi observado novamente erro nativo aproximadamente cinco minutos após pedir aprovação, apesar do handler configurado para 600s e da bridge para 580s. Isso delimita uma espera observada; não prova qual camada nativa impôs esse limite. O ensaio passou a negar por expiração do operador em quatro minutos, antes dessa fronteira observada, sem prolongar nem reutilizar decisões.

## Primeira chamada com autorização humana nesta etapa

Experimento `agy-stage24-Co2bZv`, AGY **1.4.11**, modelo exato `gemini-3.8-flash-medium`. O operador selecionou expressamente a chamada única no canal de perguntas; o harness retransmitiu `aprovar` pelo histórico HTTP real de AgentSession. A ferramenta só retorna uma constante em memória.

| Correlação | Identificador sanitizado |
|---|---|
| Sessão HTTP autenticada | `928ced2776024b66f511b94327dc1017438b65b403f29a6228990a6e05d894b0` (SHA-256) |
| Conversa AGY | `b0926db85728d2e7d54b1585b060311dc8b703d5af1e4923ed4027a0ac708465` (SHA-256) |
| Sessão MCP | `c41af15371093188a7f00f2e42ca6fe3f892823c91989349befaad09f9438518` (SHA-256) |
| Request MCP | `5ffd22220229e61c5709cfea286b3f23bceeb5254099239ace9c471b0fc6de94` (SHA-256) |
| ID JSON-RPC tipado | `6b2b9445a26a8da077ef5a21e9aeb591585d37bebb41d043b6eb71dbef2e7a5a` (SHA-256) |
| ID OpenAI | `3c8526650975329c7b8834e106e3ea6da70899b8bff82ea70fc66cfb594c3305` (SHA-256) |
| AGY / worker | PID `7936` / `8092` |

Linha do tempo UTC:

1. 21:04:05.736 — aprovação PreToolUse solicitada para `echo_fixture({})`.
2. 21:07:36.954 — registro de decisão positiva explícita do operador.
3. 21:07:40.720 — AgentSession devolveu a decisão à bridge de aprovação.
4. 21:07:43.572 — admissão MCP específica gerada.
5. 21:07:50.724 — pedido MCP aceito e callback de ferramenta do cliente publicado.
6. 21:07:51.065 — HTTP retornou `tool_calls` com ID OpenAI correlacionado.
7. 21:07:51.617 — cliente enviou `role:tool` com `SESSION_A_RESULT` e o ID correto.
8. 21:08:06.390 — worker devolveu erro MCP `-32000`; HTTP final 502; nenhum `mcp_tool_resolved` nem continuação final válida observados.
9. 21:08:07.362 — runner encerrou; registros e leases foram limpos.

ID inválido e modelo trocado retornaram 410; reutilizar a aprovação consumida retornou 409; replay do resultado retornou 410. O diagnóstico anterior não registrava a etapa de rejeição da revalidação, portanto a causa exata desse 502 não pode ser recuperada das evidências existentes. Havia sondas nativas adicionais ativas; contenção de recursos/CIM é hipótese, não causa provada. A instrumentação nova distingue `process-before`, `client-result`, `context-after` e `process-after` sem publicar diagnósticos privados.

Uma resposta humana posterior para o experimento `82dijg` foi processada quando a conversa já havia terminado; não foi aplicada nem usada em outro request. O horário do clique original no cliente não foi medido, portanto não se atribui o atraso exclusivamente ao operador.

## Primeiro round-trip nativo completo e duas sessões simultâneas

Experimento `agy-stage24-l4TKoT`: dois clientes autenticados independentes, mesmo workspace temporário, mesma ferramenta/schema e resultados exclusivos. AGY 1.4.11 fixado por hash e file lease, modelo `gemini-3.8-flash-medium`, transporte HTTP JSON real. O operador aprovou A e B em respostas separadas aos requests `db874ae3-b3aa-4db9-a0a0-bad21aba402a` e `083cdf2d-ee38-4233-a63e-57f020884c89`. Decisões de ensaios encerrados, recebidas junto dessas respostas, não foram reaproveitadas.

| Identidade | Sessão HTTP (SHA-256) | Conversa nativa (SHA-256) | AGY / worker |
|---|---|---|---|
| A | `41e0ccf80abea27507d332382e3847fe519f3c1dcedd7395156aeebc309e4996` | `71b0d7c90946563464a7460f8702979da2d720e41a71274a75c3c1dbb641357d` | 4512 / 6732 |
| B | `50b1b7b89dc71c06de91a717169c4ea683b549956eae79b0cf71da860dc4e242` | `8d4d36ad70861f5a9022774e6ddc9d0312d2393a17e3193497d8c15ebe94a5a5` | 32736 / 10684 |

Os hashes completos de peer, lease, sessão MCP, request e RPC estão na evidência. As duas chamadas usaram o mesmo ID RPC local tipado, mas requests, sessões e IDs OpenAI distintos: request A `b1f2a6c965f517151ec4d38d9b0504a1a75a843fb068ce1008143547d8f45dfb`, ID OpenAI A `4f1b966b1f00fec271959628e51040d633d6d4e583291713787ca6a06fe21232`; request B `4eefbfa16d6d21203ceb354882eb452daa63b4a8766e66ac3c953bc3c5789258`, ID OpenAI B `169c4c19c24956b5c060e0d243d4019171a41544c18d8393db8fa302ff301b9f` (todos SHA-256).

Aprovações solicitadas às 21:59:58 UTC; os registros de decisão, admissão e tools/call constam separadamente no JSON. Os dois `role:tool` foram enviados às 22:01:23.987/988. Resultados MCP resolvidos às 22:01:24.879/999; estados nativos DONE às 22:01:25; SUCCESS e resposta final HTTP 200 às 22:01:28. Cada conversa recebeu sua própria string e nenhuma string estrangeira. Os IDs `_meta` de conversa/raiz coincidiram com o init de cada processo. Workers fizeram detach e os runners encerraram às 22:01:28/29; o helper de file lease fechou.

Em A e B, autorização de outra identidade retornou 409, ID/resultado estrangeiro e modelo alterado 410, workspace alterado 409, aprovação consumida 409 e replay do resultado 410. A configuração do workspace permaneceu única e não foi regravada por sessão. Essa prova satisfaz A e o round-trip positivo concorrente desse layout, sem estabelecer todos os casos adversariais de B ou contenção de SO.

### Raízes distintas e cancelamento

`agy-stage24-ViFB8u` repetiu o positivo com dois workspaces distintos, duas decisões humanas específicas e o mesmo AGY/modelo fixados. Ambas as respostas finais foram HTTP 200, cada uma contendo somente a constante da própria sessão; as verificações adversariais HTTP tiveram os mesmos códigos acima.

| Ensaio / sessão | Sessão HTTP (SHA-256) | Conversa AGY (SHA-256) | AGY / worker | Resultado |
|---|---|---|---|---|
| ViFB8u / A | `21cb7caf59df3c1c39c69199c7929de858dd71ce44ac96125ad9a22c3b237f6e` | `502db8d1ad71aab83cca33eeeea58814f7509491bba24e11a6d4097b24c1d4ce` | 18176 / 21192 | HTTP 200, SESSION_A_RESULT |
| ViFB8u / B | `5ecc948cfbbfdca398d74f80296c150661c4689377454c6e8efea658d796d121` | `65ec9c2a4582ed6cac197354ff6ed05b2d9e68f3d54199b84c1588f330fec67a` | 4568 / 4512 | HTTP 200, SESSION_B_RESULT |
| 0GRYKv / A (mesma raiz) | `9900bfb9dcd43f5223ebd26bb9c0029c2ec677bd9cff8ae0a7cfc3c0630902d3` | `3624b401c30894f0a717214ef94ba3b2ad7748cf154fb9b5df639d7d928d248a` | 17204 / 42084 | Cancelada enquanto MCP pendente; resposta tardia 410 |
| 0GRYKv / B | `78769a0871469dba5db4fdf74a0400071bf477dd0c33a8530ac8ed7a4e98e775` | `fb77a00ce4ba1c791cea9753442b8d2841dba6b4bd9172276104e4a42d829a38` | 47760 / 47176 | HTTP 200, SESSION_B_RESULT |
| d6dIu2 / A (raízes distintas) | `a94efbbe75a3cad7e12aad16ba8e77b3f259de6c8f5214225b71771a698c6d82` | `da980ee384fbce6c0c81c945798095744b1111b35fd64e6e315671e0d2c92e67` | 7936 / 28108 | Cancelada enquanto MCP pendente; resposta tardia 410 |
| d6dIu2 / B | `cd1ab8503a385276669156bf522f93d9eba4c6832bd23fe84a70b9a4d9445b09` | `75804a94928daeefb651c9822b951f201dac7a562a9bf1b509f87211412ecf4b` | 11800 / 12092 | HTTP 200, SESSION_B_RESULT |

Os dois ensaios de cancelamento tiveram novas autorizações humanas para A e B. O resultado de A foi tentado por uma nova requisição HTTP com sinal independente, depois do encerramento do runner nativo e antes de fechar o servidor HTTP: **410** em ambos. B permaneceu ativa e recebeu exclusivamente seu resultado. Replay e resposta tardia de B também receberam 410. Nos positivos anteriores l4TKoT/ViFB8u, o teste tardio antigo só constatava transporte fechado após app.close; não é usado como prova de HTTP 410.

O PID 4512 identifica AGY no ensaio l4TKoT e worker no ViFB8u, em momentos diferentes. Esse reuso real confirma a necessidade de nascimento do processo, parentesco, contexto, sessão e lease separados; PID isolado não é identidade de conversa.

## Executáveis e validade dos ensaios

O hash instalado inicial era o 1.4.10 histórico, `fade3d94282b8c1b12a24e54ffa930183bd6f6ff7a73a90421fb0aab4d9402ba`. Durante a primeira execução o arquivo passou a **1.4.11**, hash `b3a033afb92b3ffbb31e81e4897e0e3f5730a327fcd9a8c2920c6711715d9408`. Mais tarde passou a **1.4.12**, hash `b4bbcc9f65d355bc84523d4f43e1ead34992890baf60c24e4ccbf605e2da6858`. Nenhum comando update foi emitido pelo trabalho.

O monitor interrompeu os ensaios afetados; eles não contam como positivos. Uma cópia descartável do 1.4.11 também foi substituída pelo updater, preservando um `.old` com o hash anterior. O harness passou a manter um FileStream Windows de leitura sem compartilhamento de escrita/delete sobre a cópia TEMP, com helper próprio e encerramento por EOF. Essa medida serve à estabilidade do experimento, não à contenção das ferramentas. Não muda ACLs nem preferências globais. O backend e outros componentes nativos não têm uma política de compatibilidade universal provada por esse hash do CLI.

## Isolamento e exclusividade

A implementação preserva um bridge por invocação autenticada, binding imutável de contexto/catálogo, token e lease exclusivos, um worker filho direto com identidade de nascimento verificada e uma admissão por ação. A chamada exige agora os IDs nativos de conversa e raiz. Não há roteamento por nome, seleção pelo último request nem regravação de configuração por sessão.

O mecanismo permite bridges independentes; não introduz mutex nem fila global que finja concorrência. Exclusividade apenas no proxy não impediria outras instâncias AGY/backend da mesma conta, nem acesso do processo aos diretórios de outra sessão. Por isso não foi apresentada como substituta da contenção e da matriz nativa. Em produção todas as requisições AGY com client tools continuam explicitamente recusadas antes do spawn.

| Ensaio | Mesma raiz / raízes distintas | Resultado nativo |
|---|---|---|
| `m6JFES` | Mesma raiz, duas identidades | Dois workers/conversas/leases e catálogos observados; atualização da cópia interrompeu o teste antes das chamadas |
| `vcVZQf` | Duas raízes, duas identidades | Descoberta associada a workers/conversas/leases distintos; aprovação estrangeira negada com 409 nas duas direções; ambas decisões expiraram em deny, sem tools/call |
| `l4TKoT` | Mesma raiz, duas identidades, executável com file lease | PASS: ambas aprovações explícitas, resultados exclusivos e continuação; IDs/autorizações/resultados estrangeiros e replay negados |
| `ViFB8u` | Raízes distintas, executável com file lease | PASS: ambas aprovações explícitas, resultados exclusivos, continuação e verificações HTTP adversariais |
| `0GRYKv` | Mesma raiz, cancelamento de A | PASS: ambas chamadas autorizadas; A cancelada pendente, resposta tardia 410; B continua HTTP 200 |
| `d6dIu2` | Raízes distintas, cancelamento de A | PASS: ambas chamadas autorizadas; A cancelada pendente, resposta tardia 410; B continua HTTP 200 |

| Propriedade | Testes automatizados | Matriz AGY real completa |
|---|---|---|
| Chamadas positivas A/B, mesmo nome e resultados exclusivos | PASS em JSON/SSE e ambos layouts | PASS nos dois layouts, HTTP JSON; SSE nativo não executado |
| ID/resultado A em B, replay | PASS | PASS nos dois layouts; credenciais MCP deliberadamente transplantadas só na fixture automatizada |
| Autorização consumida e resposta tardia | PASS | PASS nos dois layouts; tardia 410 após encerramento nativo nos ensaios de cancelamento |
| Cancelar A com B ativa | PASS | PASS nos dois layouts |
| Worker reiniciado/órfão | PASS nos dois layouts | NOT RUN: reinício físico e morte/orfandade deliberada do worker real não executados |
| Ferramenta não registrada | PASS | Não executada como ferramenta nativa autorizada |
| Workspace/modelo trocado durante pendência | PASS, inclusive após resultado | PASS nos dois layouts: 409/410; a troca testada é do contexto HTTP, não mudança de workspace/modelo por comando nativo |

## Matriz real dos hooks

O catálogo completo anunciado no init 1.4.11 está na evidência sanitizada. Os nomes anunciados e os nomes internos do dispatcher divergem: `view_file` → `read_file(Path)`, `write_to_file` → `write_file(Path,Content,Overwrite)` nos ensaios observados. O comando observado não trouxe `Cwd` no payload do hook, portanto o validador atual não pode inferi-lo nem autorizá-lo por fallback.

| Categoria | Ferramentas efetivamente anunciadas/observadas | Cobertura |
|---|---|---|
| Leitura interna | `view_file`, `list_dir`, `find_by_name`, `grep_search`, `read_resource`, `list_resources`; dispatcher `read_file` efetivamente acionado | **Comprovada** somente para a leitura exata negada: hook observado, estado ERROR, string desconhecida não recebida. Demais caminhos **não comprovados** |
| Escrita interna | `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit`, `delete_knowledge`; dispatcher `write_file` acionado | **Comprovada** para a criação exata negada: hook observado, ERROR e arquivo ausente. Demais caminhos **não comprovados** |
| Execução de comandos | `run_command`, `send_command_input`, `command_status`, `notebook_execution`, `run_workflow`, `manage_task` | `run_command` chegou ao hook e foi negado/ERROR. Payload sem Cwd é **incompatível** com autorização positiva pelo validador atual. Demais caminhos **não comprovados** |
| MCP | `call_mcp_tool` | **Comprovada** para as chamadas exatas de echo_fixture, inclusive decisão humana, resultado e continuação nos dois layouts; outras ferramentas/caminhos e matriz adversarial completa **não comprovados** |
| Rede de ferramentas | `read_url_content`, `search_web`, família `browser_*`, `open_browser_url`, `read_browser_page`, `execute_browser_javascript` | **Não comprovada**: sonda loopback não invocou a ferramenta e não recebeu requests; não é demonstração de bloqueio |
| Subprocessos / colaboração | Worker MCP iniciado; `invoke_subagent`, `define_subagent`, `manage_subagents`, `browser_subagent`, `schedule`, `send_message` anunciados | **Incompatível** usar somente PreToolUse para proteger todo spawn: worker real iniciou antes da atestação. Ferramentas de colaboração não foram executadas e sua cobertura é **não comprovada** |
| Configuração local de projeto | `.agents/hooks.json`, `.agents/mcp_config.json`, launchers lidos no startup | **Incompatível** considerar PreToolUse uma barreira anterior à leitura desses arquivos: o CLI precisa consumi-los para carregar os próprios controles |
| Operações anteriores à atestação | Spawn, init, startup MCP, initialize/tools/list | **Comprovada** ocorrência anterior à atestação; **incompatível** tratá-las como já autorizadas pela atestação posterior. Rede de inicialização não foi medida |

As sondas de negação nunca concederam autorização positiva. O envelope final SUCCESS isolado não prova execução: os casos negados terminaram SUCCESS com ferramenta em ERROR. Não foi assumida cobertura universal a partir desses resultados. Ver [contrato primário dos hooks](https://antigravity.google/docs/hooks/).

## Contenção Windows

Não há sandbox independente do AGY inteiro validada. A consulta local ao registro retornou `ProductName=Windows 10 Home`, `DisplayVersion=26H2`, build `26300.9711`; esses valores não comprovam disponibilidade/ativação de Windows Sandbox ou PSE. O runtime `.local/agy-runtime` tem DACL herdada, sem proteção de herança; modos POSIX 0600/0700 não demonstram isolamento Windows entre processos da mesma conta. Nenhuma ACL foi modificada.

[AGY_WINDOWS_CONTAINMENT.md](AGY_WINDOWS_CONTAINMENT.md) descreve conta restrita, DACLs, token restrito, AppContainer/PSE, Job Objects e VM/Sandbox opt-in, riscos, pré-requisitos e canários sintéticos para validação. O hook atual precisa ler o lease privado sob o mesmo token do agente: conceder esse acesso à conta restrita não protege o lease contra o próprio AGY. Uma separação efetiva exige broker/IPC autenticado ou pilha experimental inteira isolada, sem montar segredos do host. Nenhuma dessas topologias foi promovida a implementação de produção.

## Runner, OpenCode e Traycer

Guards de configuração, rotas e runner preservados; AGY continua com `tools:none` por default, sem flag HTTP/ambiente de liberação. `proxy_approve_action` continua excluída do catálogo do modelo. Não há fallback silencioso para Codex nem AGY sem ferramentas. `/v1/capabilities` não foi ampliado.

OpenCode → Gemini pelo runner de produção: **NOT RUN/BLOCKED por D**. A prova histórica OpenCode com upstream de fixture não é reclassificada como produção. Obsidian Copilot real não foi operado; seus contratos/regressões automatizados passaram. Inventário de ferramentas do runtime não contém integração OpenCode/Traycer; nenhuma sessão Traycer autorizada foi usada ou mensagem A2A enviada.

Roteiro posterior, somente com A–D PASS:

1. Em workspace temporário, configurar provider OpenAI-compatible do OpenCode por arquivo local do ensaio, modelo exato `agy/gemini-3.8-flash-medium`, chave efêmera em ambiente e headers `Authorization`, `X-Proxy-Workspace`, `X-Proxy-Profile`. Confirmar presença/correção sem registrar a chave.
2. Anunciar somente ferramenta inofensiva com schema conhecido; obter decisão real do operador; conferir `tool_calls`, ID original em `role:tool`, retorno MCP e continuação na mesma conversa. Testar JSON/SSE, replay, cancelamento e zero resíduos. Resultado correto em todas as fases = PASS; bloqueio de runner, falta de aprovação ou fase ausente = BLOCKED; resultado trocado = FAIL.
3. Para Traycer, usar somente sessão real expressamente autorizada e projeto descartável. Conferir identidade efetiva e definições realmente anunciadas de `traycer_get_self` / `traycer_send_message`. Não usar Starlight.
4. Enviar tarefa inofensiva ao Researcher OpenCode/Gemini; obter resposta no Coordinator e encaminhar ao QA Codex somente conforme autorização A2A dessa sessão. Conferir IDs/hashs, recebimento pelo pai e isolamento entre conversas. Recusa, ferramenta/sessão ausente ou falta de acesso = BLOCKED; nunca contornar permissões. Fluxo integral correlacionado e cleanup = PASS.

## Validação e arquivos

`npm run build`: PASS. `npm test`: **170/170 PASS**, sem falhas/skips, preservando os 149 anteriores e adicionando 21 testes. `git diff --check`: PASS, com avisos históricos LF/CRLF sem erro de whitespace. Um recorte inicial executado no sandbox negou CIM em dois testes de wiring; a repetição fora do sandbox passou 62/62 e a suíte completa final passou 170/170, sem substituir o testemunho real por um permissivo.

Os 21 testes novos cobrem HTTP/MCP concorrente nos dois layouts e JSON/SSE, IDs/autorizações/resultados estrangeiros, replay, mudança de workspace/modelo, metadados nativos ausentes/inválidos/estrangeiros, falha de witness após resultado, desconexão durante revalidação final, auditoria sem conteúdo privado e timeout da continuação após role:tool. Oito deles repetem reinício, orfandade, cancelamento e ferramenta não registrada com dois clientes autenticados em ambos layouts; o witness desses oito é explicitamente uma fixture, sem reclassificação como prova de processo nativo. Casos de aprovação negada/expirada, token consumido, integridade/atestação, Codex e Copilot permanecem na suíte preservada.

A última edição após as provas nativas limitou o estado publicado pelo observer a ACTIVE/DONE/ERROR ou null e ampliou a asserção de privacidade, sem mudar transporte MCP/correlação. Build e suíte completa 170/170 foram repetidos depois dessa edição. A comparação dos 59 arquivos do inventário inicial identificou somente os oito arquivos de implementação/fixtures listados abaixo como alterados; guards/registries/leases preservaram os hashes do preflight. Os seis scripts novos passaram em node --check; a revisão de whitespace incluiu os arquivos novos, e o JSON público foi percorrido para rejeitar campos/valores privados.

Alterados nesta etapa: `src/providers/base.ts`, `src/providers/agy-runner.ts`, `src/providers/agy-mcp-bridge.ts`, `src/mcp-stdio.ts`, `test/mcp-client.ts`, `test/agy-stage22.test.ts`, `test/agy-stage23.test.ts`, `test/fixtures/cli.mjs`, `README.md`, `AGY_MCP_REGISTRATION.md`. Novos: `test/agy-stage24.test.ts`, scripts `agy-stage24-native.mjs`, `agy-stage24-hooks.mjs`, `agy-stage24-pin.mjs`, `agy-stage24-decision.mjs`, `agy-stage24-collect.mjs`, `agy-stage24-cleanup-audit.mjs`, `AGY_WINDOWS_CONTAINMENT.md`, este relatório e `test/evidence/agy-stage24.json`. Outros arquivos já modificados/novos no preflight são entregas anteriores preservadas.

Evidência sanitizada: [test/evidence/agy-stage24.json](test/evidence/agy-stage24.json), com 14 experimentos, decisões, IDs correlacionados por hash, catálogo observado e integridade histórica. A auditoria final consultou 42 PIDs conhecidos/filhos diretos e nomes de leases de 22 conversas: nenhum lease próprio restante. Um PID histórico (18664, helper já encerrado no ensaio l4TKoT) foi encontrado com nascimento às 22:15:08 UTC, posterior aos eventos de encerramento daquele ensaio às 22:01; foi classificado como reuso, sem matar processo alheio. Nenhum worker/AGY do ensaio correspondeu a processo remanescente nessa consulta. A consulta é uma fotografia dos PIDs conhecidos e filhos diretos, não uma prova de contenção de todo descendente arbitrário do backend.

Permanecem como bloqueios: diagnóstico reproduzível do primeiro 502, casos nativos de reinício/orfandade/ferramenta não registrada e transplante de credenciais, cobertura de ações internas/anteriores à atestação, contenção de SO, compatibilidade dos componentes nativos, OpenCode real e Traycer A2A. Gate A passou; isso não remove os guards de B/C/D.

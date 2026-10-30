# Correção AGY — registro externo e status das ferramentas

> Atualização de 2026-10-29: a etapa 2.2 comprovou D2 com aprovação humana pelo canal HTTP, em fixture descartável. O bloqueio do runner externo de produção permanece. Consulte [AGY_STAGE22_REPORT.md](AGY_STAGE22_REPORT.md) para os gates atuais. A evidência histórica abaixo foi preservada.

Base: `review/agy-proxy-local-state`, commit `285de74623f1ccce3ededb83aa87427b20ff18f5`. A implementação está na branch `fix/agy-external-workspace-tools`. Não houve alteração em master, no binário AGY, em credenciais ou configuração global. O vault real não foi modificado.

**Estado da entrega: parcial e local, sem commit/push.** O aceite real de segurança falhou: houve resposta OK do modelo, mas não atestação de hooks. Seguindo a condição da tarefa para falhas graves, a publicação foi suspensa. HEAD continua no commit base; a branch de correção não foi publicada. Não houve PR ou merge.

**Proteção final:** execução externa continua bloqueada antes do spawn em produção, mesmo com registro íntegro. Registro estático e detecção posterior de ausência de hooks não impedem uma ação caso o CLI ignore a configuração. O runner mantém esse bloqueio sem bypass HTTP/ambiente; somente o adaptador de CLI simulado dos testes substitui a verificação. Os testes reais descritos abaixo precederam essa proteção final. `/v1/capabilities` informa external_workspaces:false e o bloqueio native_hook_loading_unverified.

## Causas confirmadas e escopo entregue

`approval_hook_missing`: o runner recusava qualquer cwd diferente de ServerRoot. Existia autorização de workspace, mas não havia contrato para instalar/verificar o hook externo. Agora há um registro local explícito e consentido; a API não instala arquivos. Diretórios sem registro continuam bloqueados. O caminho do agente permanece o workspace autorizado, sem fallback ao proxy.

`tool_not_supported`: config, rota e runner impedem ferramentas de cliente no AGY porque não há bridge estruturada implementada. Essa recusa foi mantida: houve inferência real com resposta OK, mas não houve comprovação da carga dos hooks nem do ciclo MCP/OpenAI. Não seria correto habilitar tools:client com base em fixtures. A limitação é deste adaptador não validado, não uma afirmação de que o AGY seja incapaz de MCP.

O protocolo headless agora mantém stdin aberto até result, encerrando-o após o evento terminal. Isso corresponde ao processo contínuo documentado e é verificado por fixture que detecta EOF prematuro. Não se atribui a esse ajuste a resolução da falha real observada. Um envelope SUCCESS sem texto agora falha com cli_protocol_error em vez de representar sucesso funcional vazio.

## Registro consentido e integridade

`src/agy-workspaces.ts` separa plano, instalação, verificação e remoção. O comando em `src/agy-workspace-cli.ts` usa apenas IDs de PROXY_WORKSPACES. Instalar/remover exige o hash exato de um plano revisado; mudança nos arquivos/identidades invalida o consentimento. Não existe endpoint HTTP de instalação.

A instalação preserva hooks existentes e cria somente `.agents/hooks.json` e `.agents/obsidian-cli-proxy-launcher.mjs` no workspace selecionado. Entradas homônimas, launcher preexistente e PreToolUse ativos de terceiros são conflitos bloqueantes: poderiam alterar argumentos/decisões da ação aprovada. Não são removidos ou desabilitados silenciosamente. Outros hooks são preservados, inclusive com restauração dos bytes anteriores/BOM/CRLF na remoção sem mudanças intermediárias.

O launcher usa import de file URL para o handler compilado do servidor. O comando invoca o Node atual por caminho absoluto entre aspas; não procura node.exe dentro do workspace. Caminhos do workspace com espaços/Unicode não são interpolados em shell. Caracteres de shell inesperados no caminho do próprio Node são recusados. Não são gravados tokens, chaves ou argumentos de ferramentas no workspace.

Os registros/backups ficam em `.local/agy-workspaces/` do servidor, ignorado pelo Git. Contêm raiz canônica, identidade do diretório, fingerprints SHA-256/device/inode de hooks, launcher e handlers/helpers, e cópia da configuração anterior. Um journal privado preserva a configuração original antes da gravação e bloqueia nova instalação após interrupção. Backups podem conter a configuração privada de terceiros: proteja esse diretório e não o publique.

A checagem ocorre antes do spawn e antes/depois da aprovação. Recursos ausentes, inválidos, alterados, substituídos ou symlinks/junctions não aceitos bloqueiam a execução. Mudança do workspace continua sujeita a realpath/device/inode e ao contexto da sessão. Duas sessões em diretórios distintos têm bridges/tokens independentes. Cada decisão autoriza uma ação; proxy_approve_action permanece separado do modelo.

O hook também registra SessionStart/PreInvocation, que chamam `src/approval-ready.ts` por esse launcher com --ready. O bridge só aceita a atestação com token do processo e exatamente o workspace autorizado. Ferramentas são negadas antes desse sinal; timeout ou conclusão sem atestação geram approval_hook_failed. O handler de prontidão também é fingerprintado e não concede permissões. Isso testa se o CLI carregou a configuração, além de conferir arquivos; depende do contrato oficial de eventos antes da inferência/ação.

`src/hook-credentials.ts` correlaciona apenas o conversation_id emitido pelo init nativo. Cada sessão externa tem um registro de runtime exclusivo em .local/agy-runtime do servidor, fora do workspace, com URL/token e raiz canônica. O handler externo exige esse registro, ignorando credenciais herdadas que possam estar antigas em um backend persistente. O arquivo é removido ao encerrar e nunca é escrito no vault. IDs arbitrários/traversal e payloads de outro workspace são recusados. Se o runtime do servidor estiver dentro da raiz do agente, a correlação é bloqueada; o proxy deve ficar fora do vault. Este é um recurso privado do servidor, não configuração global AGY nem ferramenta exposta ao modelo. Proteja as ACLs Windows. Depois de crash abrupto pode restar arquivo inerte; não o publique.

O runner monta a raiz autorizada em --add-dir, além de cwd. A documentação de projetos informa que o default-cli-project não depende do diretório atual; nenhuma flag project livre é recebida do cliente e nenhum projeto global é criado automaticamente.

Uma remoção consentida restaura o arquivo original se os bytes instalados não mudaram. Com alterações somente de terceiros, remove a entrada gerenciada e preserva os demais hooks. Não apaga `.agents`. Alterações na própria entrada/launcher impedem remoção automática. Instalação parcialmente interrompida não recebe registro confiável: exige inspeção explícita, sem fallback permissivo.

## MCP: investigação e bloqueio atual

As ajudas reais `agy.exe --help`, `mcp --help`, `mcp add --help` e `plugin --help` não oferecem configuração de hooks/MCP efêmera por processo. A documentação oficial confirma `.agents/mcp_config.json` por workspace, stdio, schemas e timeouts configuráveis; não é necessário afirmar que só existe configuração global.

O caminho técnico recomendado é outra instalação consentida de um servidor stdio estático do proxy. O AGY deve passar ao MCP filho a URL/token exclusivos herdados do ambiente; o servidor obtém apenas os schemas da sessão em um bridge loopback autenticado. tools/call valida nome/argumentos, encaminha a onToolCall e permanece pendente enquanto o cliente recebe tool_calls e devolve role:tool. O resultado/erro deve voltar ao mesmo request MCP, com correlação, cancelamento, timeout e isolamento. Nenhum client tool deve executar no host do proxy. A ferramenta reservada de aprovação não pode aparecer no catálogo MCP.

Esse caminho **não foi implementado/habilitado**, pois falta comprovar o ciclo real AGY → MCP → OpenAI → MCP → continuação, inclusive herança de ambiente e nomes de ferramentas no hook nativo. Instalar o hook não altera mcp_config.json. Config continua recusando tools:client em perfis AGY e requisições com tools retornam tool_not_supported antes do spawn. Não existem tool_calls extraídos de texto ou sucessos simulados.

## Testes automatizados e reais

- Baseline: os **63 testes anteriores passaram** antes da correção.
- Suíte expandida: **91 testes passaram**, incluindo os 63 anteriores, com bloqueio de produção antes do spawn, atestação SessionStart/PreInvocation simulada, autenticação de prontidão, correlação nativa sem herança de ambiente, limpeza privada e recusa de conclusão sem sinal.
- `npm run build`: passou. `git diff --check` da correção: passou. O whitespace do hooks.json já presente no commit base não foi modificado nem reintroduzido no diff.
- Novos testes: consentimento e plano obsoleto; ausência de instalação pela API; hooks/launcher conflitantes; preservação/restauração de terceiros; BOM/CRLF; hook desabilitado/ausente/alterado; launcher ausente/alterado/substituído; handler alterado; junction da pasta de hooks e raiz redirecionada; autorização; duas sessões externas; aprovação/negação; alteração durante aprovação; expiração/shutdown; timeout/descendentes; stdin/result; SUCCESS vazio; Gemini explícito sem tools; JSON/SSE; rejeição segura de tools. Os testes usam Node como CLI falso, diretórios temporários e sentinelas, não o vault.
- Chamadas reais: duas tentativas de runner com gemini-3.8-flash-medium em workspace temporário consentido (antes/depois do ajuste de stdin) expiraram no deadline de 90s, sem texto nem pedidos de aprovação.
- Diagnóstico direto, independente do proxy: chamadas `--print` limitadas retornaram init/result, status SUCCESS, response vazio e usage inteiramente zero. Não contam como inferência bem-sucedida. Não se inferiu uma causa de autenticação/rede apenas desses sinais.
- Descoberta real via `agy models`: retornou 13 modelos, incluindo gemini-3.8-flash-medium. Isso não valida inferência nem acesso efetivo à conta/modelo.
- Em tentativas posteriores com prazo de inicialização maior, o Gemini retornou OK em diretório temporário externo. O proxy rejeitou a conclusão com approval_hook_failed porque a carga dos hooks não foi atestada. Não se declarou sucesso protegido com base apenas no texto OK.
- O teste real negativo solicitou uma única escrita de sentinela em diretório temporário, com toda aprovação negada pelo bridge. Terminou em cli_error, com zero solicitações de hook e sem sentinela. Esse resultado é inconclusivo quanto a PreToolUse; não foi contado como uma negação comprovada pelo hook.
- Não houve teste real bem-sucedido de PreToolUse, MCP, Copilot GUI, OpenCode GUI ou Traycer A2A. A validação final de Gemini respondendo com o hook realmente carregado permanece pendente. Os resultados de fixtures não substituem esse aceite. Mesmo com --add-dir, correlação nativa e prazo de inicialização ampliado, o CLI não confirmou os hooks registrados.
- Diretórios de diagnóstico que ficaram temporariamente em uso foram removidos após liberação, somente dentro de .tmp. Não foram encerrados serviços do usuário.

## Configurar notes e testar

As instruções completas, comandos de remoção e exemplos HTTP estão no README. São procedimentos preparados para diagnóstico com consentimento: nesta entrega o request externo continuará bloqueado antes do spawn até comprovar o contrato nativo. Não instale no vault para tentar contornar esse bloqueio. Resumo, na raiz do proxy:

1. No `.env` existente, mapeie notes ao caminho absoluto correto em PROXY_WORKSPACES. Autorize notes e o perfil agy para a identidade em PROXY_CLIENTS, ou use deliberadamente a chave compartilhada local. Se o perfil tiver allowlist de modelos, inclua gemini-3.8-flash-medium. Mantenha supervised/tools:none.
2. Rode `npm run build` e `node dist/agy-workspace-cli.js plan-install --workspace notes`. Apenas revise o plano: não cria arquivos no vault.
3. Somente se consentir especificamente na instalação no vault mostrado, execute `node dist/agy-workspace-cli.js install --workspace notes --consent '<HASH-DO-PLANO>'`.
4. Confira `node dist/agy-workspace-cli.js status --workspace notes`. Isso comprova integridade dos recursos, não carga no CLI real.
5. Rode npm start. No Copilot básico sem tools, selecione agy/gemini-3.8-flash-medium, Bearer real e http://127.0.0.1:3557/v1. Use default notes ou X-Proxy-Workspace=notes e perfil agy.
6. No OpenCode, configure o mesmo upstream/headers, mas confirme que o request realmente omite tools. Se o cliente sempre as envia, ainda estará bloqueado. Permissões deny no cliente não comprovam omissão de definições de ferramentas.
7. O request sem tools do README atualmente deve receber approval_hook_failed antes do spawn, mesmo com registro. Para destravar o desenvolvimento, verifique /hooks no CLI em diretório descartável e comprove uma ação negada. Só após demonstrar esse contrato nativo será seguro remover o bloqueio no código e exigir OK, aprovação correspondente e confirmação de que a ação negada não ocorreu.

## Arquivos e riscos residuais

Novos: `src/agy-workspaces.ts`, `src/agy-workspace-cli.ts`, `src/approval-ready.ts`, `src/hook-credentials.ts`, `test/agy-workspaces.test.ts`, `test/hook-credentials.test.ts`, este relatório. Alterados: handler/runner/bridge AGY, interfaces e ciclo de stdin em base.ts, capabilities em routes.ts, fixture CLI, package.json, .gitignore, .env.example, README e indicação histórica em IMPLEMENTATION_REPORT.md. Nenhuma dependência nova nem mudança na implementação Codex App Server.

cwd não é sandbox; existe janela entre checagem de filesystem e uso pelo CLI. Não deixe processos hostis escreverem na instalação/registro. A composição com PreToolUse de terceiros exige revisão explícita, sem combinação automática de políticas. Build/atualização/mudança do Node ou handler pode exigir registrar novamente. Um arquivo gerenciado ausente/modificado bloqueia também uso normal do AGY naquele projeto até reparo/remoção. Não copie a integração para o vault sem consentimento. MCP, A2A e execução real com aprovação ativa continuam pendentes de aceite.

## Bloqueio para concluir e publicar

É necessário verificar, no terminal normal da conta usada pelo servidor e em diretório descartável, se /hooks realmente lista os eventos gerenciados e se os handlers conseguem responder ao bridge. O retorno OK confirma inferência, mas não identifica por que a configuração não foi atestada. Não se concluiu que hooks sejam impossíveis nessa versão; também não se assumiu herança de ambiente, trust de workspace ou compatibilidade headless sem evidência. Os dois MCPs stdio globais existentes foram apenas contados para diagnóstico, sem ler seus valores nos logs ou alterá-los. Não houve descompilação, patch, login novo ou bypass de permissões. Qualquer mudança de trust/projeto/configuração global exige autorização adicional explícita, conforme a tarefa.

Referências primárias: [hooks](https://antigravity.google/docs/hooks/), [CLI e flags](https://antigravity.google/docs/cli/reference/), [headless](https://antigravity.google/docs/cli/headless/), [MCP por workspace](https://antigravity.google/docs/mcp/), [projetos e default-cli-project](https://antigravity.google/docs/projects?tab=cli). A documentação estabelece o contrato esperado; as observações reais acima delimitam o que foi comprovado neste computador.

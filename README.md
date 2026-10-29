# Obsidian CLI Proxy

Servidor Fastify local com `GET /health`, `GET /v1/models` e `POST /v1/chat/completions`, JSON e SSE. Codex usa App Server com ferramentas dinâmicas; Antigravity usa headless stream-json com aprovações por hook. Não fornece embeddings, imagens, áudio ou execução direta de ferramentas do cliente.

## Instalação e ambiente

Requer Node.js **22 ou superior**, npm e executáveis nativos `codex` e/ou `agy.exe` (`agy` no Unix). Os CLIs precisam estar previamente autenticados na mesma conta do sistema operacional. Este servidor não realiza login nem altera credenciais.

```powershell
npm install
Copy-Item .env.example .env # Somente se ainda não existir .env
# Edite .env: chave local, IDs de workspace e caminhos reais autorizados.
npm run build
npm start
# Desenvolvimento com reload:
npm run dev
```

`dev` e `start` carregam automaticamente **o mesmo `.env` da instalação do servidor**, localizado a partir do módulo e do `package.json`, independentemente do cwd usado para iniciar o programa. Variáveis já definidas no processo prevalecem. `.env` ausente é permitido: defaults são aplicados, mas execução exige chave e workspace configurados. Um `.env` em projeto externo nunca é carregado pelo proxy. O próprio CLI pode ler configurações/instruções de seu workspace e de sua conta.

A alteração local anterior de `start` (`node --env-file=.env dist/index.js`) foi incorporada ao bootstrap com `process.loadEnvFile()`. Isso mantém o carregamento e a precedência, resolve o arquivo pela raiz real e funciona no mínimo Node 22 sem dependência adicional. `--env-file-if-exists` exigiria Node 22.9; não é usado. O loader programático não aplica `NODE_OPTIONS` do arquivo. `build` e `test` não carregam o `.env` real nem exigem credenciais.

O bind padrão continua `127.0.0.1`, porta padrão `3000`. Os exemplos deste ambiente usam **3557**, configurável. Ctrl+C encerra sessões e árvores de processos.

## Configuração

Veja [.env.example](.env.example). JSON em variáveis deve ser colocado em uma única linha; use aspas simples externas no `.env` para preservar as aspas duplas do JSON.

| Variável | Default | Uso |
| --- | --- | --- |
| HOST / PORT | 127.0.0.1 / 3000 | Endereço local / porta |
| PROXY_API_KEY | vazio | Bearer local, mínimo 24 caracteres; vazio desabilita acesso autenticado compartilhado |
| PROXY_CLIENTS | {} | Identidades com chaves distintas e listas de IDs de workspace/perfil autorizados |
| PROXY_WORKSPACES | {} | IDs mapeados para diretórios absolutos |
| PROXY_DEFAULT_WORKSPACE | vazio | Workspace para clientes que não enviam header de seleção |
| PROXY_PROFILES | perfis codex / agy | Políticas locais descritas abaixo |
| CLI_TIMEOUT_MS | 120000 | Prazo ativo; reiniciado após resposta de aprovação/ferramenta |
| CLI_STARTUP_TIMEOUT_MS | 30000 | Inicialização do Codex até thread/start; AGY até primeiro stdout |
| APPROVAL_TIMEOUT_MS | 300000 | Espera por aprovação/ferramenta; máximo 580000 para respeitar deadline do hook |
| CLI_MAX_OUTPUT_BYTES | 8388608 | Limite de stdout por execução |
| CODEX_BIN / AGY_BIN | codex / agy.exe | Executável nativo, sem argumentos ou shell |
| PROXY_MODELS | vazio | IDs adicionais separados por vírgula, com prefixo codex/ ou agy/ |
| CORS_ORIGINS | app://obsidian.md | Origens exatas separadas por vírgula; wildcard rejeitado |
| ALLOW_REMOTE | false | Exposição externa exige true e autenticação; nunca habilitada automaticamente |
| MAX_SESSIONS | 32 | Limite global de execuções ativas ou pendentes |
| MAX_REQUESTS_PER_MINUTE | 120 | Limite por identidade autenticada |
| DIAGNOSTICS | false | Habilita GET /v1/diagnostics autenticado |

Nunca coloque credenciais em URL, prompt, screenshot ou logs. `.env` permanece ignorado pelo Git. Não há modo de execução legado com chave fictícia. A migração exige configurar a mesma chave real no cliente. A chave local não substitui autenticação do CLI.

## ServerRoot, workspace e worktree

- **ServerRoot**: instalação física do proxy, seu package.json e dist.
- **HookRoot**: `.agents` dentro dessa instalação; handler compilado em `ServerRoot/dist/approval-hook.js`.
- **WorkspaceRoot**: raiz canônica de um ID autorizado pelo operador.
- **SessionWorkingDirectory**: diretório canônico passado ao processo e ao Codex thread/start. Atualmente coincide com WorkspaceRoot.
- **Worktree do Traycer**: projeto separado que deve ser cadastrado como seu próprio ID; não é descoberto automaticamente a partir de texto ou headers de caminhos.

```dotenv
PROXY_WORKSPACES='{"engine-task":"C:/Projects/Engine-worktrees/task-123"}'
PROXY_DEFAULT_WORKSPACE=engine-task
```

Selecione com `X-Proxy-Workspace: engine-task`, depois de autenticar. Sem esse header, utiliza-se exclusivamente o ID default configurado. Não são aceitos caminhos HTTP, traversal, argumentos do modelo ou `x-opencode-directory` como fonte de autorização. Para clientes sem headers personalizados, use uma instância com um default explícito e credencial limitada ao workspace correspondente.

As raízes são canonicalizadas e fixadas na inicialização com realpath e identidade do diretório (device/inode). Junctions/symlinks explicitamente configurados apontam para a raiz canônica fixada; retargeting, remoção e renomeação invalidam o vínculo. Diretórios inexistentes retornam workspace_not_found; após criá-los, reinicie o proxy. Não há comparação textual de prefixos, nem seleção de subdiretórios arbitrários. Caminhos Windows, volumes e UNC dependem de existir e serem acessíveis à conta local; cadastrar UNC é uma autorização explícita a esse recurso. Os testes Windows cobrem junction, espaços e Unicode; não validam compartilhamentos UNC reais.

**cwd não é isolamento de filesystem.** Existem janelas de corrida entre validação e spawn e configurações/ferramentas locais dos CLIs. Para fronteiras hostis, use conta/VM/sandbox externa e proteja a instalação do proxy e as configurações locais contra escrita pelo agente. Nenhum workspace é implicitamente o diretório do servidor.

## Perfis e identidades

`X-Proxy-Profile` escolhe um perfil autorizado; o default é o nome do provider (`codex` ou `agy`). O cliente não pode enviar flags, sandbox ou permissões livres. Campos HTTP extras continuam aceitos por compatibilidade, mas não alteram políticas.

Cada perfil aceita `provider`, `policy`, `models` (sufixos exatos; `*` permite override), `tools` (`client`/`none`), `timeoutMs`, `startupTimeoutMs`, `maxOutputBytes` e `executable` opcional. Valores ausentes dos três limites herdam as variáveis globais. O executável opcional é definido exclusivamente pelo operador; o default vem de CODEX_BIN/AGY_BIN.

| Política Codex | sandbox | aprovação |
| --- | --- | --- |
| read-only (default) | read-only | untrusted, reviewer user |
| supervised | read-only | untrusted, reviewer user |
| write-enabled (opt-in) | workspace-write | untrusted, reviewer user |

supervised é um nome lógico para o mesmo mapeamento conservador de read-only. write-enabled permite operações locais que o sandbox/política do Codex já permitem sem perguntar; não significa aprovação de cada leitura/escrita. Quando o CLI pede aprovação, só recebe accept/decline para aquela ação. Nunca recebe acceptForSession, Full Access ou fallback de modelo. Threads são efêmeras; a execução viva mantém thread e turn durante esperas. Chamadas programáticas sem callback usam codex exec read-only/never e exigem cwd explícito.

Antigravity aceita exclusivamente `supervised` com `tools:none`; não se presume equivalência de sandbox com Codex. Todas as ações interceptadas pelo PreToolUse exigem decisão explícita. Outras políticas retornam erro de configuração. Não se usa dangerously-skip-permissions.

Para separar clientes, prefira chaves por identidade:

```dotenv
PROXY_CLIENTS='{"obsidian":{"key":"SUBSTITUA-POR-UMA-CHAVE-ALEATORIA-DE-32-CARACTERES","workspaces":["notes"],"profiles":["codex"]}}'
```

PROXY_API_KEY, se configurada, representa a identidade compartilhada local e autoriza todos os IDs/perfis locais. Quem usa a mesma chave compartilha a identidade: `user` e `conversation_id` fornecem contexto adicional, não autenticação.

## Modelos e ferramentas

`codex/default` e `agy/default` usam o modelo configurado no CLI. Um sufixo explícito é passado exatamente ao CLI; aliases Codex conhecidos são normalizados para lowercase. Perfis podem restringir os sufixos. `/v1/models` mantém catálogo e descoberta AGY com cache/fallback; sua presença no catálogo **não comprova autenticação, autorização, disponibilidade ou conclusão de inferência**. PROXY_MODELS anuncia IDs, sem ampliar permissões dos perfis.

Codex registra os schemas recebidos como dynamicTools e devolve chamadas nativas em `tool_calls`, com IDs únicos por sessão e `finish_reason: tool_calls`. O cliente executa suas ferramentas segundo suas permissões e devolve `role:tool` e o mesmo tool_call_id. O proxy apenas encaminha o resultado à chamada nativa pendente. JSON e SSE possuem testes de round-trip. Ferramentas não registradas são recusadas. Alterar a lista/schema de ferramentas enquanto uma chamada está pendente gera session_conflict.

A ferramenta reservada `proxy_approve_action` pode ser declarada por clientes que coletam confirmação humana: seus argumentos são action/cwd/reason e o resultado é `{"approved":true|false}`. Ela **não é disponibilizada como dynamicTool ao modelo**, impedindo que ele peça sua própria aprovação. O cliente deve obter uma decisão humana antes de produzir esse resultado.

Antigravity não oferece ferramentas dinâmicas OpenAI neste adaptador: requisições com tools retornam HTTP 400 tool_not_supported antes do spawn. Não se extrai tool_calls de texto/JSON gerado pelo modelo. MCP por si só não resolve registro isolado e continuação do protocolo; veja o status bloqueado abaixo.

Sampling temperature, max_tokens e usage não têm mapeamento implementado nos CLIs: opções extras são aceitas/ignoradas e usage não é inventado. Conteúdo não textual e múltiplas completions são rejeitados.

## Obsidian Copilot

Configure o provider customizado OpenAI-compatible (BYOK):

- Base URL: `http://127.0.0.1:3557/v1`.
- API key: chave real de PROXY_API_KEY ou PROXY_CLIENTS.
- Modelo: `codex/default`, ou modelo autorizado explícito.
- Cadastre o vault/workspace local como ID e configure PROXY_DEFAULT_WORKSPACE se Copilot não enviar headers.
- Mantenha o workaround Enable CORS desligado para preservar streaming. A origem padrão permitida é app://obsidian.md.

O fluxo de chat básico mantém o pedido em português. Responda exatamente `aprovar`, `allow`, `y`, `sim`, ou `negar`, `deny`, `n`, `não`/`nao`. O cliente precisa preservar histórico e marcador HTML de aprovação. Cada decisão se vincula à ação pendente, identidade, modelo, workspace, perfil e ferramentas. Replay, mudança de contexto e expiração não executam a ação. O fim normal da resposta de aprovação preserva o processo pausado; desconexão durante uma resposta ativa, timeout e shutdown encerram a árvore de processos.

## OpenCode e Traycer

A documentação atual de OpenCode v2 permite headers e configuração explícita do provider OpenAI-compatible. Exemplo ilustrativo (valide contra o schema da versão instalada):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "local-proxy": {
      "name": "Local CLI Proxy",
      "package": "@opencode/ai/providers/openai-compatible",
      "env": ["LOCAL_PROXY_KEY"],
      "settings": { "baseURL": "http://127.0.0.1:3557/v1" },
      "headers": { "X-Proxy-Workspace": "engine-task", "X-Proxy-Profile": "codex" },
      "models": { "codex-local": { "modelID": "codex/default", "name": "Codex local" } }
    }
  }
}
```

OpenCode não foi localizado no PATH deste ambiente; OpenCode **2.2.0 e Traycer Desktop não foram executados nem tiveram seus requests reais capturados**. Não há evidência de que seus metadados internos de diretório cheguem ao upstream Chat Completions de forma confiável. O proxy exige vínculo explícito via ID/default e credencial. Configure o ID do worktree exato criado pelo Traycer, não a raiz do proxy nem outro checkout. Não alteramos configuração global desses produtos.

Traycer A2A: **não validado**. O caminho Codex tem bridge estruturada testada com fixtures, mas schemas/resultados reais das ferramentas A2A precisam de teste ponta a ponta no cliente. AGY com ferramentas de cliente é BLOCKED. Não anuncie suporte A2A completo.

## Hook Antigravity e workspaces externos

O erro original foi corrigido em `.agents/hooks.json`: agora `node approval-launcher.mjs` resolve o launcher na pasta de hooks que o AGY utiliza. O launcher importa `../dist/approval-hook.js` relativo a import.meta.url. Não depende do cwd do servidor nem concatena caminhos em shell; espaços/Unicode não viram argumentos extras. O preflight confere essa configuração, o launcher e **o mesmo handler** em ServerRoot/dist. Não copiamos o handler para `.agents/dist`.

A cada invocação há um bridge loopback com token aleatório exclusivo. O token fica no ambiente do subprocesso e, para workspaces externos, no registro privado temporário do servidor descrito abaixo; nunca no workspace do agente. Hook ausente, handler indisponível, token ausente, URL inválida, bridge inacessível, payload inválido, timeout e negação bloqueiam a ação. O handler só aceita HTTP loopback, não segue redirects e usa prazo limitado. O bridge mostra o workspace autorizado, sem confiar em Cwd informado pelo modelo. A aprovação não é inferida de respostas do agente.

A implementação local oferece registro consentido de hooks, mas **a execução externa permanece bloqueada antes do spawn em produção**, mesmo com registro íntegro. A etapa 2.1.1 comprovou launcher/handler/bridge nativos e negação de escrita (C/D1 PASS); aprovação humana D2 continua BLOCKED, conforme `AGY_LAUNCHER_WINDOWS_REPORT.md`. Sem registro retorna approval_hook_missing; com registro retorna approval_hook_failed. Não há flag de ambiente/HTTP para contornar esse bloqueio. O fluxo abaixo não habilita uso normal no vault. Autorizar o workspace na API não autoriza instalar configuração. O proxy HTTP nunca instala arquivos.

O registro insere somente a entrada gerenciada em `.agents/hooks.json` (SessionStart, PreInvocation e PreToolUse) e cria `.agents/obsidian-cli-proxy-launcher.mjs`. No Windows, usa o Node canônico absoluto **sem aspas**, seguido do nome relativo do launcher: `C:/ProgramData/nvm/v24.19.0/node.exe obsidian-cli-proxy-launcher.mjs`. O dispatcher AGY 1.4.10 falhou nativamente com o executável entre aspas. Caminhos do Node que exijam quoting (espaços, Unicode ou caracteres de shell) são recusados no planejamento; use uma instalação padrão. O caminho do workspace pode conter espaços/Unicode, pois não é interpolado no comando. Não se procura Node no workspace. No Unix, o executável continua entre aspas. O launcher importa os handlers do servidor por file URL. Nenhum token é gravado no workspace. Hooks de terceiros são preservados; entradas homônimas, arquivos existentes e outros PreToolUse ativos são conflitos que exigem revisão manual. Não são desabilitados automaticamente.

Registros Windows anteriores com Node entre aspas exigem migração explícita: pare as sessões, revise `plan-remove`, execute `remove` com aquele consentimento e depois revise `plan-install` e execute `install` com um novo consentimento. `status` bloqueia o formato antigo; nenhuma configuração é reescrita automaticamente. A remoção mantém as verificações dos recursos antigos e restaura os hooks anteriores.

A bridge valida o contrato de cada ferramenta: `read_file`/`write_file` exigem `Path`, `view_file` exige `AbsolutePath`, escritas documentadas exigem `TargetFile`, e `run_command` exige `Cwd` e `CommandLine`. Ferramentas desconhecidas, parâmetro ausente, alvo fora do workspace, redirecionamento por link/junction ou sessão divergente são negados. Os argumentos originais são mantidos na solicitação ao operador, inclusive conteúdo e aspas; não há fallback de parâmetro para ServerRoot.

No fluxo preparado, SessionStart ou PreInvocation envia uma atestação autenticada, com o workspace real, ao bridge exclusivo do processo. Ela não aprova ferramentas. Sem esse sinal dentro de CLI_STARTUP_TIMEOUT_MS, a execução é cancelada com approval_hook_failed; uma conclusão sem atestação não pode retornar sucesso. O bridge recusa ações antes do sinal. Porém, observar a ausência do sinal após iniciar o CLI não impede uma ação se o CLI ignorar hooks. Por isso o bloqueio anterior ao spawn permanece até verificar o contrato nativo; testes com fixtures não o habilitam em produção.

O `conversation_id` do evento nativo init vincula uma credencial efêmera ao workspace em `.local/agy-runtime/` do servidor, nunca ao vault. O handler externo usa essa correlação em vez de presumir que um backend persistente herdou variáveis atuais do CLI. O arquivo é exclusivo, tem modo 0600 quando suportado e é removido no finally da execução; mantenha o diretório privado também nas ACLs Windows. Um crash abrupto pode deixar registro inerte, sem bridge vivo: inspecione-o com o servidor parado. Se o servidor estiver dentro do próprio workspace autorizado, essa alternativa é recusada para não gravar credenciais no workspace; instale o proxy fora do vault. Somente IDs UUID nativos são aceitos, e o workspace do payload também é validado. Não há caminho ou ID escolhido pelo modelo/HTTP para essa correlação.

O runner também passa a raiz autorizada em --add-dir: a documentação informa que o projeto default do AGY independe de cwd. Não se cria projeto global nem se aceita project/flags livres do cliente. A atestação continua exigindo exatamente a raiz autorizada; raízes adicionais inesperadas são recusadas.

Hashes SHA-256 e identidade de arquivo/diretório são registrados em `ServerRoot/.local/agy-workspaces/` (ignorado pelo Git), juntamente com a configuração anterior para remoção. Arquivo ausente, editado, desabilitado ou substituído é recusado. A validação ocorre antes do spawn e antes/depois da decisão de cada ação. Atualizar/mover o servidor ou handler pode exigir remover e registrar novamente. Proteja a instalação e esse registro contra escrita por terceiros; isso não é sandbox nem defesa completa contra corridas de filesystem após a última checagem.

### Registrar o workspace notes com consentimento separado

No `.env` **existente do servidor**, mantenha a chave real e acrescente/mescle as configurações, sem sobrescrever outros IDs/clientes. O caminho abaixo é ilustrativo:

```dotenv
PROXY_WORKSPACES='{"notes":"C:/Notes/My Vault"}'
PROXY_DEFAULT_WORKSPACE=notes
# Perfil agy padrão já usa supervised/tools:none.
# Se PROXY_PROFILES estiver personalizado, inclua agy com esses valores e
# autorize gemini-3.8-flash-medium em models (ou mantenha * deliberadamente).
# Se usar PROXY_CLIENTS, conceda notes e agy à identidade do cliente.
```

Na raiz do proxy:

```powershell
npm run build
node dist/agy-workspace-cli.js plan-install --workspace notes
# Revise os caminhos, os dois arquivos e o aviso. Só prossiga se consentir
# especificamente em instalar o hook no vault mostrado. Copie o hash consent:
node dist/agy-workspace-cli.js install --workspace notes --consent '<HASH-DO-PLANO>'
node dist/agy-workspace-cli.js status --workspace notes
npm start
```

Também há `npm run agy:workspace -- <operação> ...`. O consentimento só vale para os bytes/identidades do plano: se os arquivos mudarem, gere e revise outro plano. `status` verifica arquivos/configuração, **não comprova** que o CLI real carregou o hook ou concluiu inferência. Não execute o install no vault apenas para testar: use primeiro um workspace temporário.

Para remover, pare as sessões AGY e revise outro plano:

```powershell
node dist/agy-workspace-cli.js plan-remove --workspace notes
node dist/agy-workspace-cli.js remove --workspace notes --consent '<HASH-DO-PLANO-DE-REMOCAO>'
```

Se hooks.json não mudou após instalar, seus bytes originais são restaurados (ou o arquivo é removido se não existia). Se somente hooks de terceiros foram acrescentados, remove-se apenas a entrada gerenciada e preservam-se os demais. O launcher gerenciado é removido; `.agents` não é apagado. Recursos gerenciados alterados bloqueiam a remoção automática: inspecione/restaure-os antes. Uma instalação interrompida fica bloqueada sem registro válido; examine os dois arquivos e o backup privado antes de tentar novamente. Não remova manualmente operator.lock sem confirmar que não há operação ativa.

### Ferramentas MCP: bloqueio mantido

**BLOCKED: bridge MCP AGY/OpenAI, ainda não implementada.** A documentação oficial confirma stdio e `.agents/mcp_config.json` por workspace. Isso oferece um caminho com consentimento separado, mas não comprova o ciclo tools/call → tool_calls → role:tool → continuação da mesma inferência. O Gemini respondeu OK no teste real, mas a carga dos hooks não foi atestada e nenhum ciclo MCP/OpenAI foi validado. Perfis AGY continuam aceitando somente tools:none e a API rejeita tools antes do spawn. Nada é instalado em mcp_config.json por este registro.

Próxima implementação verificável: registrar com outro plano consentido um servidor MCP stdio estático do proxy no workspace; herdar URL/token aleatórios do processo AGY para o subprocesso MCP (sem gravá-los); listar somente schemas da sessão via bridge autenticado loopback; validar tools/call e encaminhar a onToolCall; suspender até role:tool e retornar conteúdo/erro ao mesmo request MCP. É necessário provar herança de ambiente, nomes reais, timeout durante a espera, correlação, concorrência e limpeza no AGY real antes de habilitar tools:client. O nome reservado proxy_approve_action não poderá ser exposto ao modelo. Use Codex para ferramentas do cliente enquanto isso.

### Testar Gemini nos clientes

Os exemplos abaixo descrevem o contrato pretendido para o aceite futuro. Nesta entrega, requests em notes são bloqueados antes do spawn com approval_hook_failed mesmo após registro; não há configuração que habilite a execução externa nativa ainda não comprovada.

No Copilot, use chat básico sem ferramentas, URL `http://127.0.0.1:3557/v1`, a chave local real e modelo `agy/gemini-3.8-flash-medium`. Configure PROXY_DEFAULT_WORKSPACE=notes ou envie X-Proxy-Workspace=notes; selecione perfil agy quando houver override. Preserve o histórico de aprovação e teste primeiro uma negação. Modos agent que enviam tools ainda recebem tool_not_supported.

No OpenCode, adapte o provider ilustrativo acima: headers X-Proxy-Workspace=notes e X-Proxy-Profile=agy, modelo upstream agy/gemini-3.8-flash-medium. Só pode funcionar para requests efetivamente sem tools; negar execução de ferramentas nas permissões do cliente não comprova que suas definições deixam de ser enviadas. Se a versão instalada sempre enviar tools, este modo permanece bloqueado: não há configuração de compatibilidade automática no proxy. Para confirmar o contrato sem depender do cliente:

```powershell
$headers = @{ Authorization = "Bearer $env:LOCAL_PROXY_KEY"; 'X-Proxy-Workspace' = 'notes'; 'X-Proxy-Profile' = 'agy' }
$body = @{ model = 'agy/gemini-3.8-flash-medium'; stream = $false; messages = @(@{ role = 'user'; content = 'Responda apenas OK' }) } | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:3557/v1/chat/completions -Headers $headers -Method Post -ContentType application/json -Body $body
```

**Validação real protegida ainda pendente:** antes do bloqueio final de produção, tentativas iniciais expiraram após 90s; com prazo maior o Gemini respondeu OK, mas o proxy recusou a conclusão por falta de atestação dos hooks. Isso comprova a resposta do modelo, não a aprovação segura. Uma chamada direta print com prazo curto também retornou SUCCESS vazio e usage zero; isso não conta como sucesso funcional. Nenhum vault foi alterado nem houve novo login. Stdin permanece aberto até result e SUCCESS vazio gera erro de protocolo. Os resultados atuais, incluindo a verificação negativa de PreToolUse, estão em [AGY_INTEGRATION_REPORT.md](AGY_INTEGRATION_REPORT.md).

## Segurança, diagnóstico e erros

Sem chave válida, endpoints /v1 retornam 401 antes de iniciar processos. CORS não é autenticação. Origens são exatas; clientes desktop sem Origin funcionam com Bearer válido. Bind externo exige opt-in ALLOW_REMOTE=true e autenticação. Não há TLS neste servidor; acesso remoto deve usar transporte seguro controlado pelo operador.

A herança de ambiente usa allowlist de variáveis de sistema, homes de credenciais e credenciais específicas dos CLIs. PROXY_API_KEY, PROXY_CLIENTS, segredos arbitrários e NODE_OPTIONS não são repassados. CLIs ainda podem acessar arquivos da conta conforme seus próprios sandboxes; esta filtragem não é isolamento de credenciais no filesystem.

Logs padrão contêm requestId, sessionId opaco, provider, modelId, workspaceId, durationMs e outcome. Não registram prompts, histórico, arquivos, headers de autorização nem stdout/stderr completos. Erros CLI enviados ao cliente autenticado podem incluir diagnóstico limitado do CLI; trate-os como dados privados. Sessões ficam só em memória; reiniciar perde chamadas pendentes.

`/health` é público e reporta processo/sessões, sem testar conta do CLI. `/v1/capabilities` exige chave e mostra recursos declarados e IDs permitidos. DIAGNOSTICS=true habilita `/v1/diagnostics`: executa apenas --help dos executáveis padrão, com prazo de 3s e saída omitida. Perfis com executable próprio exigem verificação separada. Nenhum desses endpoints afirma autenticação funcional.

Códigos incluem authentication_error (401), workspace_not_authorized/model_not_authorized/profile_not_authorized (403), workspace_not_found/model_not_found (404), session_conflict e conflitos de aprovação (409), approval_timeout/approval_expired (410), tool_not_supported (400), cli_not_found/approval_hook_missing (503), cli_authentication_error e falhas de protocolo/execução (502), cli_timeout (504), client_disconnected (499), limites de requisição (429) e sessões (503). SSE já iniciado entrega error + [DONE], sem stop bem-sucedido.

## Validar no Windows

```powershell
npm run build
npm test
$headers = @{ Authorization = "Bearer $env:LOCAL_PROXY_KEY"; 'X-Proxy-Workspace' = 'engine-task' }
Invoke-RestMethod http://127.0.0.1:3557/health
Invoke-RestMethod http://127.0.0.1:3557/v1/capabilities -Headers $headers
Invoke-RestMethod http://127.0.0.1:3557/v1/models -Headers $headers
$body = @{ model = 'codex/default'; messages = @(@{ role = 'user'; content = 'Informe seu diretório de trabalho.' }); stream = $false } | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:3557/v1/chat/completions -Headers $headers -Method Post -ContentType application/json -Body $body
# Para SSE, use curl.exe -N com o mesmo Bearer e X-Proxy-Workspace.
```

Não coloque a chave literal no histórico de comandos. LOCAL_PROXY_KEY é uma variável do cliente; o proxy usa PROXY_API_KEY ou PROXY_CLIENTS. Para AGY, perfil/modelo/workspace precisam ser autorizados; workspaces externos continuam bloqueados pela verificação nativa pendente, mesmo após registro consentido.

Os testes usam CLIs Node falsos, fixtures e diretórios temporários, incluindo writes de sentinelas aprovadas. Nunca usam a Starlight real. Nenhum teste exige login ou inferência paga. A suíte cobre dev/start, reload, configuração, autenticação, workspace, junction, concorrência, políticas, JSON/SSE, aprovações, tools Codex, negação AGY, hook e cancelamento de descendentes de ambos os providers. No sandbox Windows, testes que passam por npm podem exigir permissão para encerrar a árvore completa; execute em um terminal normal para a validação local.

Pendências manuais: validar CLI real autenticado em diretório temporário; verificar hook carregado em /hooks e negar uma ação; testar Copilot real; confirmar configuração OpenCode 2.2.0, payloads A2A e worktree Traycer; testar duas identidades simultâneas; validar cancelamento no ambiente de produção. Não rode testes de escrita em projetos reais.

## Evidências consultadas em 2026-10-28

- [Node process.loadEnvFile](https://nodejs.org/api/process.html#processloadenvfilepath), [flags de ambiente](https://nodejs.org/api/cli.html#--env-file-if-existsfile): loader nativo compatível com Node 22.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): ciclo JSON-RPC e ferramentas. Observado localmente: Codex CLI 0.164.0, --help, app-server --help e schema TypeScript experimental gerado em .tmp (não versionado). Esse schema confirma untrusted, sandbox, cwd e allowProviderModelFallback.
- [Antigravity CLI](https://antigravity.google/docs/cli/reference/), [headless](https://antigravity.google/docs/cli/headless/), [hooks](https://antigravity.google/docs/hooks/): formato e locais de configuração. Observadas as ajudas agy --help, mcp --help, mcp add --help e plugin --help; não se fizeram login nem mudanças globais.
- [OpenCode providers v2](https://dev.opencode.ai/v2/docs/providers/): configuração explícita de provider, headers e baseURL. Não equivale a evidência de tráfego real do Traycer.
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools): schemas e chamadas estruturadas; não comprova injeção isolada no AGY.

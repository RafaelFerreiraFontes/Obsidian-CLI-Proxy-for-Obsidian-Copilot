# AGY — experimento nativo 2.1, 2026-10-29

**Resultado:** hooks de workspace externos foram descobertos e o handler diagnóstico bloqueou leitura e escrita no AGY real. A integração completa do proxy não passou: o registro real não produziu atestação nem chamada à bridge antes do prazo. O bloqueio de produção deve permanecer. Não houve commit, push, MCP ou alteração de código de produção nesta etapa.

## Gates e origem da evidência

| Gate | Resultado | Evidência e limite |
| --- | --- | --- |
| A — descoberta e PreToolUse | **PASS** | `/hooks` interativo listou a entrada de workspace; handler executado no interativo e no headless. No headless, `read_file` passou de ACTIVE para ERROR com negação de hook; callback correlacionado à mesma conversa. |
| B — negar escrita | **PASS** | Callback real de `write_file`, `decision:deny`, alvo `fixture/should-not-exist.txt`; evento ERROR por negação. Sentinela ausente, amostra intacta. |
| C — launcher/bridge reais | **BLOCKED** | Registro, integridade e ausência de tokens verificados. Prova isolada recebeu init com cwd correto, mas zero atestações/solicitações à bridge em 45s. Processo encerrado e instalação removida. |
| D1 — negar pela bridge | **BLOCKED** | C não passou. A negação diagnóstica de B não é negação pela bridge. |
| D2 — aprovação por ação | **BLOCKED** | Não avançou após C; nenhuma aprovação gerada automaticamente ou atribuída ao operador. |
| E — negativos em fixtures | **PASS (fixtures)** | 11 verificações específicas de preflight/handler, mais cancelamento/timeout/descendentes na suíte. Não representam execução nativa de todos os cenários. Nativamente, o comando diagnóstico inválido também bloqueou a leitura. |
| Regressão | **PASS** | Build, 91/91 testes, zero skips, diff --check e sintaxe dos três scripts manuais. |

Não há PASS para a integração AGY/proxy externa completa. Há PASS para o hook diagnóstico nativo nos limites observados.

## Ambiente e Git

- Branch inicial e final: `fix/agy-external-workspace-tools`.
- HEAD inicial e final: `285de74623f1ccce3ededb83aa87427b20ff18f5`.
- As 18 alterações/criações locais anteriores foram preservadas. Somente este relatório e três scripts em `test/manual/` foram acrescentados nesta etapa; dist e artefatos de teste continuam ignorados.
- Node: `v24.19.0`.
- Executável canônico: `C:\Users\fedet\AppData\Local\agy\bin\agy.exe`.
- O banner interativo mostrou **1.4.9** na primeira execução autenticada e **1.4.10** nas seguintes. FileVersion/ProductVersion estavam vazios e --help não oferece --version.
- SHA-256 inicial: `cffaeb65f38d048747e447632d70660406d8b214ca724c5e240a5cfc724aabcb`.
- SHA-256 posterior: `fade3d94282b8c1b12a24e54ffa930183bd6f6ff7a73a90421fb0aab4d9402ba`.

O arquivo no caminho instalado mudou durante o experimento. Nenhum comando update, patch ou escrita no executável foi realizado pelo teste. Autoatualização ou alteração por outro processo são hipóteses; a origem da mudança não foi comprovada. Os gates válidos de leitura/escrita ocorreram na versão 1.4.10, com o hash posterior. Essa variação limita a reprodução da primeira execução.

O primeiro processo no sandbox não tinha acesso à autenticação/rede. Foi encerrado; os testes seguintes usaram o contexto permitido com a sessão já existente. A restauração automática mostrou “Signing in”; não houve seleção de login/OAuth nem edição de credenciais. Um primeiro envio de Escape junto de /hooks perdeu a barra e enviou apenas hooks como texto: o turno foi interrompido e não foi contado como gate.

## Workspace e configuração efetiva

Experimento: `f5e5c339-6a6c-4d74-ab1c-fad0eb09a273`.

Raiz absoluta e realpath, iguais:

```text
C:\Users\fedet\AppData\Local\Temp\agy-hook-smoke-NvRPiG
```

Criada com mkdtemp no TEMP canônico; comprovadamente externa ao ServerRoot e sem junction/symlink. `.agents`, `fixture` e `evidence` foram criadas pelo teste. sample.txt contém exatamente STARLIGHT_AGY_HOOK_TEST, sem newline, com SHA-256 `ead8001cd40dc4e3d0ed16b39f73431b21c497221f20752973f8ca0c1d1f7510`.

Configuração diagnóstica válida nos gates A2/B:

```json
{
  "agy-native-smoke-deny": {
    "enabled": true,
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "C:/ProgramData/nvm/v24.19.0/node.exe C:/Users/fedet/AppData/Local/Temp/agy-hook-smoke-NvRPiG/.agents/diagnostic-deny.mjs",
        "timeout": 10
      }]
    }]
  }
}
```

SHA-256: `d1791a96590f4516c4d2b1a3d923761737020e8ffcf0cfa589147f5ccaf670f4`.

O diagnóstico lê stdin, registra nome da ferramenta, nomes dos campos, hash dos argumentos, vínculo ao workspace, cwd do handler e hash da conversa. Não registra conteúdo de arquivo, prompt, credencial ou argumentos integrais. Retorna sempre `{"decision":"deny"}` e não executa a ferramenta. Seu acesso a evidências fica dentro da raiz temporária. Não houve allow/auto_approve diagnóstico.

A primeira configuração usava o executável entre aspas; hash `45974034a96e7daa91aeb030906a9225c77abc87624921b9aacfeea105690d30`. O erro nativo interativo foi:

```text
JSON hook ... failed: command failed: exit status 1
'\"C:/ProgramData/nvm/v24.19.0/node.exe\"' não é reconhecido como um comando
```

Isso prova tentativa de execução e bloqueio por falha, não execução do handler. A fixture foi alterada para caminhos absolutos sem espaços/metacaracteres, verificados antes de montar o comando. Esse contorno vale somente para estes caminhos de teste: **não valida quoting de executáveis com espaços/Unicode** nem altera o launcher de produção. A versão anterior da configuração foi arquivada.

## Eventos reais e filesystem

Nos headless A2/B, init anunciou modelo gemini-3.8-flash-medium, cwd exatamente igual à raiz temporária e permission_mode `proceed-in-sandbox`. Anunciou, entre outras ferramentas, view_file e write_to_file. A lista completa sanitizada está nos JSONs de evidência.

O comportamento real foi diferente dos nomes anunciados/documentados:

| Execução | Payload nativo do hook | Resultado independente |
| --- | --- | --- |
| Interativo, 15:20:16 UTC | read_file, campos Path, deny | TUI: tool call denied by pre-tool hook; log do handler na mesma raiz |
| Headless A2, 15:20:58 UTC | read_file, campos Path, deny | Ferramenta ACTIVE → ERROR, hookDenied:true; result SUCCESS é a resposta explicando a negação |
| Headless B, 15:23:28 UTC | write_file, campos Content/Overwrite/Path, deny | Ferramenta ACTIVE → ERROR, hookDenied:true; should-not-exist.txt ausente |

O processo do handler teve cwd `<workspace>\.agents`; workspacePaths correspondeu à raiz autorizada. A2 e B foram correlacionados pelo hash do conversation_id nativo. O hash dos argumentos de leitura corresponde independentemente a `{Path:<caminho real de sample.txt>}`.

Na primeira instrumentação, targetInside:false no registro de leitura significava que o coletor ainda não reconhecia o campo Path, não que o alvo fosse externo. A conferência independente do hash confirmou o alvo correto; o coletor foi ajustado antes da escrita para reconhecer Path. Essa alteração foi apenas de diagnóstico e não mudou deny.

A1 headless terminou com ERROR, exit 3 e zero callbacks; não foi contado como PASS. A2, a segunda e última tentativa headless de leitura, terminou com SUCCESS/exit 0 após aproximadamente 161s, com callback e ferramenta negada. Não houve terceira tentativa. A ausência da sentinela em B foi verificada diretamente no filesystem, não inferida da resposta do modelo.

## Prova isolada da integração real do proxy

Somente após A/B passarem, o diagnóstico foi arquivado e removido de hooks.json. O mecanismo AgyWorkspaceRegistry instalou a entrada real usando o hash do plano salvo. A autorização desta tarefa cobre somente essa instalação temporária; não autoriza instalar no vault.

Foram usados contexto autenticado temporário, workspace canônico, política existente, bridge loopback em porta efêmera e credenciais aleatórias mantidas fora do workspace. registry.verify foi executado antes do spawn e configurado antes/depois das decisões; a correlação usa o init nativo e HookCredentialLease. O launcher e handlers foram fingerprintados e a configuração não continha tokens.

O harness usa diretamente esses componentes para a prova isolada autorizada, sem modificar/chamar o runner de produção para contornar seu bloqueio. O bridge exigiu prontidão e negaria qualquer ação recebida. Nenhuma requisição chegou ao callback de aprovação; não houve decisão de aprovação atribuível ao operador.

Resultado C: init com cwd correto, sem atestação, sem tool/result observados antes do prazo de 45s; árvore do processo de teste encerrada. A instalação e lease foram removidos. O comando registrado usa o mesmo padrão de executável entre aspas que falhou no diagnóstico. Isso é uma **causa provável**, não uma causa demonstrada pelo stderr de C: nessa execução não foi capturado o mesmo erro. O prazo também é um limite do experimento, e sua expiração isoladamente não prova falta de suporte aos eventos.

O TUI /hooks mostrou cinco tipos de evento e não exibiu SessionStart, embora a documentação o descreva. Isso é outra divergência a investigar; não prova, sozinho, que o evento seja ignorado em todas as execuções. PreInvocation estava listado, mas não produziu atestação comprovada na prova C.

**Não é seguro remover o bloqueio externo.** Uma próxima tarefa funcional deve validar a construção do comando Windows e depois repetir C/D com o launcher real, incluindo uma decisão explícita do operador e a tentativa de reutilizá-la. Não se deve aplicar automaticamente o comando sem aspas da fixture a caminhos arbitrários.

## Negativos e regressão

`node test/manual/agy-hook-negatives.mjs` passou nas 11 verificações: hook ausente/desabilitado/JSON inválido; launcher ausente; cópia privada do handler ausente; hash divergente; workspace não autorizado/substituído; bloqueio de produção antes do spawn; token ausente e bridge inacessível. As duas últimas executam o handler compilado real com payload sintético. Nenhum handler de produção foi removido ou renomeado; somente cópias/arquivos temporários foram alterados e restaurados.

`npm test`: **91 testes, 91 passaram, 0 falhas, 0 skips**. Inclui cancelamento, timeout, encerramento de descendentes, contexto de sessões, launcher em espaços/Unicode, aprovação por ação e não regressão Codex. São fixtures, sem equivalência automática a inferência nativa. `npm run build` e `git diff --check` passaram. O whitespace histórico de .agents/hooks.json não foi alterado; não há whitespace novo nos scripts/relatório.

## Comandos executados e reprodução controlada

Preflight: git status/branch/rev-parse com safe.directory apenas por comando; node --version; Get-Command agy.exe; FileVersion/ProductVersion; agy.exe --help, help e changelog --help; hashes; leitura dos arquivos indicados; npm run build. /hooks foi apenas inspecionado, sem toggles, criação ou exclusão pela UI.

Os scripts são opt-in e não fazem parte de npm test. Uma nova execução cria **outro** TEMP; não reutilize uma execução com inferência já registrada:

```powershell
node test/manual/agy-native-hooks.mjs prepare 'C:\Users\fedet\AppData\Local\agy\bin\agy.exe'
node test/manual/agy-native-hooks.mjs interactive
# Digitar /hooks, inspecionar e sair sem alterar configurações.
node test/manual/agy-native-hooks.mjs headless A1
# Somente após constatar a falha de quoting neste ambiente:
node test/manual/agy-native-hooks.mjs repair-diagnostic
node test/manual/agy-native-hooks.mjs headless A2
node test/manual/agy-native-hooks.mjs interactive read
node test/manual/agy-native-hooks.mjs repair-evidence
node test/manual/agy-native-hooks.mjs headless B
node test/manual/agy-native-hooks.mjs summarize
# Só prossegue se a evidência nativa de A/B passar nas verificações do script:
node test/manual/agy-native-proxy-proof.mjs
node test/manual/agy-hook-negatives.mjs
node test/manual/agy-native-hooks.mjs status
npm run build
npm test
git diff --check
```

Os gates headless usam --add-dir, --model, --print, --print-timeout 180s, --output-format stream-json e --log-file dentro do workspace. A prova C usa --input-format stream-json, --output-format stream-json e --disable-slash-commands, mantendo stdin até result/cancelamento. Há prazo externo para encerrar somente a árvore criada pelo teste. Nenhuma flag de bypass de permissões foi usada.

## Evidências preservadas e limpeza

O workspace temporário foi **preservado**, não removido, para inspeção. evidence contém manifest, configurações anteriores e efetivas, hashes, transcript de UI sanitizado, eventos A1/A2/B/C, callbacks e resultados E. Logs brutos transitórios foram reduzidos a observações estruturadas e removidos; nenhum raw.log ficou no diretório. Emails exibidos pela UI foram substituídos por `<email>` nas evidências salvas. Alguns logs de inicialização registraram autenticação ainda indisponível antes da restauração da sessão; não são prova de falha de autenticação das inferências concluídas.

Não há hooks.json ativo nem launcher gerenciado do proxy na raiz ou na subfixture negativa. Restaram somente scripts diagnósticos inertes, sample.txt e evidências. Registros e credenciais efêmeras do teste foram removidos; o diretório de runtime do servidor ficou sem arquivos. Os PIDs headless conhecidos e o language server identificado na primeira execução já não existiam na conferência final. Os processos interativos foram encerrados; nenhum processo ou servidor de produção foi encerrado. Não se realizou limpeza ampla de TEMP nem de serviços compartilhados.

O .env real, vault, Starlight e configurações globais não foram editados. Nenhuma porta 3557/servidor de produção foi reiniciada. A bridge do experimento usou somente loopback e porta alocada pelo SO.

Referências consultadas: a [documentação de hooks](https://antigravity.google/docs/hooks/) descreve configuração por workspace, /hooks e contrato de negação; a [documentação headless](https://antigravity.google/docs/cli/headless/) e a [referência CLI](https://antigravity.google/docs/cli/reference/) descrevem os modos/flags usados. Os resultados nativos acima delimitam as divergências observadas, sem presumir equivalência entre documentação e executável.

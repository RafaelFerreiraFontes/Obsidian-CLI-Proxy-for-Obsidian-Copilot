# AGY — etapa 2.1.1, launcher Windows e bridge nativa

> Atualização de 2026-10-29: a etapa 2.2 comprovou D2 com aprovação humana pelo canal HTTP, em fixture descartável. O bloqueio do runner externo de produção permanece. Consulte [AGY_STAGE22_REPORT.md](AGY_STAGE22_REPORT.md) para os gates atuais. A evidência histórica abaixo foi preservada.

Experimento de 29/10/2026. Correção local, sem commit, push, merge, MCP ou configuração global. As alterações locais anteriores foram preservadas.

## Resultado

| Gate | Estado | Evidência |
| --- | --- | --- |
| C | **PASS** | AGY real → launcher → handler compilado → `/ready` e `/approve` autenticados → callback de aprovação. Mesma conversa e workspace. |
| D1 | **PASS** | `write_file` real negado pela bridge; argumentos conferidos por hash; sentinela ausente. |
| D2 | **BLOCKED** | Solicitação concreta apresentada ao operador, mas expirou sem aprovação humana. Escrita negada; nenhum arquivo criado. |
| AGY externo | **Ainda bloqueado em produção** | O bloqueio anterior ao spawn permanece no runner. A prova isolada não altera essa política. |
| AGY/OpenAI tools | **BLOCKED** | MCP não foi implementado nem alterado. |

## 1. Preflight e ambiente

- Branch inicial/final: `fix/agy-external-workspace-tools`.
- HEAD inicial/final: `285de74623f1ccce3ededb83aa87427b20ff18f5`.
- Lidos integralmente os dois relatórios anteriores e os três scripts manuais: `agy-native-hooks.mjs`, `agy-native-proxy-proof.mjs`, `agy-hook-negatives.mjs`.
- Inspecionados hooks/launcher da raiz, handler, readiness, runner, bridge, registro/CLI de workspace e leases de credenciais.
- O Git no sandbox recusou inicialmente a propriedade do repositório. Usou-se `git -c safe.directory=...` por comando; nenhuma configuração global foi gravada.
- Node real: `C:\ProgramData\nvm\v24.19.0\node.exe`, versão `v24.19.0`. O comando resolvido no PATH aponta inicialmente para `C:\nvm4w\nodejs\node.exe`; o registro fixa o realpath.
- AGY: `C:\Users\fedet\AppData\Local\agy\bin\agy.exe`, **1.4.10**, confirmado pelo banner interativo e pelos logs nativos.
- SHA-256 do AGY, inicial e final: `fade3d94282b8c1b12a24e54ffa930183bd6f6ff7a73a90421fb0aab4d9402ba`.
- O harness verifica o hash antes/depois de cada execução e a cada dois segundos durante o processo. Mudança invalida e interrompe o experimento; versões observadas são comparadas à versão fixada. Não se observou mudança nesta etapa. Nenhum update foi executado.

Workspace novo, externo ao servidor e descartável:

```text
C:\Users\fedet\AppData\Local\Temp\agy-launcher-211-kb50vh\workspace com espaços 世界
```

Evidências sanitizadas, preservadas em:

```text
C:\Users\fedet\AppData\Local\Temp\agy-launcher-211-kb50vh\evidence
```

Manifest: experimento `0de723d4-4d2c-4615-91be-7c4bf97f71f0`. Os diretórios são canônicos e não são junctions/symlinks. Nenhum vault ou worktree real foi usado.

## 2. Causa confirmada e limites da conclusão

O dispatcher instalado falha ao resolver o executável Node quando o comando registrado contém aspas duplas, mesmo com um caminho sem espaços. A comparação nativa reproduziu `read_file` ACTIVE → ERROR, falha do hook, executável não reconhecido e nenhum início nativo do launcher. Aspas simples também falharam. O comando com o mesmo Node sem aspas iniciou corretamente o script e recebeu o payload real.

O pai do Node no despacho nativo foi identificado como `C:\WINDOWS\system32\cmd.exe`, com `/c`. A aplicação exata de escapes dentro do AGY não foi inspecionada; atribuir o algoritmo interno ao quoting do Go continua sendo hipótese. Um teste Windows reproduz separadamente a forma observada com aspas escapadas em `cmd.exe`.

Há também um limite temporal confirmado: na prova C corrigida, o spawn ocorreu às **16:53:40.857 UTC** e o primeiro launcher de prontidão começou às **16:55:42.648 UTC**, cerca de **122 segundos** depois. O prazo anterior de 45 segundos não alcançaria esse evento. Portanto, o bug de quoting está confirmado, mas não se atribui exclusivamente a ele a ausência de callbacks no experimento antigo.

## 3. Comparação efetiva dos comandos

Todos os casos abaixo usaram o dispatcher AGY real, modelo explícito `gemini-3.8-flash-medium`, cwd no workspace descartável e uma leitura do arquivo de fixture. O diagnóstico sempre devolve `deny`.

| Formato | Launcher nativo | Resultado da ferramenta | Exit do AGY |
| --- | --- | --- | --- |
| `"C:/ProgramData/nvm/v24.19.0/node.exe" diagnostic.mjs` | Não iniciou | Erro de resolução/hook | 3 |
| `C:/ProgramData/nvm/v24.19.0/node.exe diagnostic.mjs` | Iniciou | Negada pelo handler | 0 |
| Node e script absolutos, ambos sem espaços e sem aspas | Iniciou | Negada pelo handler | 0 |
| `'C:/ProgramData/nvm/v24.19.0/node.exe' diagnostic.mjs` | Não iniciou | Erro de resolução/hook | 3 |
| Node sem aspas e script absoluto com espaços/Unicode entre aspas duplas | Não iniciou | Erro de hook | 0 |
| `C:\ProgramData\nvm\v24.19.0\node.exe diagnostic.mjs` | Iniciou | Negada pelo handler | 0 |

Exit 0 e um result SUCCESS podem representar uma resposta explicando erro/negação; não comprovam execução de ferramenta. Os registros de início, stdin e bridge são a evidência utilizada.

Estratégia implementada para Windows:

```text
C:/ProgramData/nvm/v24.19.0/node.exe obsidian-cli-proxy-launcher.mjs
C:/ProgramData/nvm/v24.19.0/node.exe obsidian-cli-proxy-launcher.mjs --ready
```

O comando é resolvido na pasta `.agents`; o AGY tem cwd no workspace; o Node filho tem cwd em `<workspace>\.agents`. O launcher resolve o handler por file URL absoluta. Assim, espaços/Unicode do workspace e do servidor não precisam de quoting no shell. Node é fixado por caminho canônico absoluto, sem busca no workspace.

Uma instalação de Node cujo caminho contenha espaços, Unicode ou caracteres fora da gramática segura é **recusada no planejamento**. Não foi criado um quoting universal para esse dispatcher. No Unix, mantém-se a estratégia anterior com aspas. Registros antigos podem ser removidos pelo mecanismo existente, mas `verify/status` exige migração explícita: `plan-remove` → `remove` com consentimento → `plan-install` → `install` com novo consentimento. O plano agora apresenta a entrada exata que será registrada.

## 4. Teste direto e instrumentação

`direct.json` registra a execução anterior à correção; `direct-fixed.json` repete com o registro corrigido e handlers finais. Em ambos, Node iniciou na pasta `.agents`, o launcher correto foi resolvido, stdin chegou, readiness foi aceita e a escrita de fixture recebeu deny pela bridge. Bridge inacessível e JSON inválido devolveram deny. Nenhuma ferramenta é executada pelo teste direto.

A instrumentação foi acrescentada exclusivamente ao launcher de teste gerado por uma subclasse do registro no harness. O corpo normal do launcher e os handlers compilados reais foram usados. O registro verifica os fingerprints desse launcher instrumentado, dos handlers e do helper. Nenhuma instrumentação foi adicionada ao produto ou aos hooks da raiz do repositório.

Os NDJSONs registram início, versão/caminho do Node, cwd, argumentos estáticos de fixture, pai do processo, chegada/validade do JSON, nomes de campos, hashes da conversa e dos argumentos, presença/import do handler, tentativa de fetch, status e resultado booleano da bridge. Não contêm tokens, headers Authorization, variáveis secretas, prompts completos ou conteúdo de ferramentas reais.

As fases distinguem descoberta da configuração sem execução, resolução que não iniciou o launcher, falha de import, bridge inacessível, resposta rejeitada e callback recebido. Falhas ausentes não são inferidas de timeout. O teste direto usa uma marca `direct-end`; somente registros posteriores são contados como invocação nativa na matriz.

Na primeira coleta de `relative.ndjson`, a comparação textual de `workspacePaths` marcou false por diferenças entre `/` e `\`. A comparação canônica e o hash independente do alvo confirmam o mesmo workspace. A instrumentação foi corrigida para realpath nos casos seguintes, sem mudar decisões. Também não se interpreta o campo `ready:false` dos registros de resposta `/approve` como perda de prontidão: nessa revisão ele representa ausência de `ready` no JSON de aprovação; `c-native.json.ready` mede o estado real da bridge e é true.

## 5. Evidência correlacionada do Gate C e D1

Arquivos: `c-native.json`, `c-native.ndjson`, `c-native-plan.json` e `summary.json`.

Hash da conversa nativa: `d57592e65303c4e0056c983b6f8ffce8adabd9f72474ed85dce23a4a7b21955d`.

| Horário UTC | Observação |
| --- | --- |
| 16:53:44.104 | Init: cwd correto, modelo explícito; lease registrado somente a partir do ID nativo |
| 16:55:42.648 | Primeiro launcher `--ready` iniciou em `.agents`, Node v24.19.0 |
| 16:55:43.394–43.457 | Handler de prontidão contatou `/ready`; HTTP 200, ready true |
| 16:55:49.893 | Launcher PreToolUse iniciou |
| 16:55:50.579–50.586 | Import do handler e JSON real `write_file`, campos `Content` e `Path`, mesma conversa/workspace |
| 16:55:50.593 | Handler tentou `/approve` |
| 16:55:50.637 | Callback real recebido pela bridge, workspace correto, decisão deny |
| 16:55:50.652–50.691 | HTTP 200 approved false; ferramenta terminou ERROR por negação |

O hash da ação exibida foi `b5b6f93e956a1880360c633ab0594aab854209651b2bbcb546757e0328066c34`. O resumo compara independentemente o hash com o caminho esperado `fixture/denied-native.txt`, conteúdo `AGY_211_DENIED`, representações de barras e ordens de campos. A comparação passou. A sentinela não existe; a amostra inicial permanece intacta. O callback negou imediatamente, a bridge foi fechada e o lease removido; não há aprovação residual.

Antes do spawn, o workspace estava autorizado pelo contexto autenticado de teste, o registro íntegro, a bridge loopback acessível (403 sem Bearer), modelo/cwd explícitos e nenhum token na configuração do workspace. O harness não removeu nem sobrepôs o bloqueio do runner de produção.

Handler final SHA-256: `eced46a793717bf93151a722cf30ab72dadc36cf00e74c20a07754049a67c2b7`. Fingerprints adicionais estão no JSON. Os hooks `--ready` compartilham o mesmo comando para SessionStart/PreInvocation; a coleta comprova prontidão anterior à ação, sem atribuir cada invocação individual a um desses dois eventos.

## 6. D2 — solicitação humana sem aprovação no prazo

`d2-native.json` e `d2-native.ndjson` registram outra conversa real, com hash `0f9303bd7f7b796cb9df90dc752c71848e537364ba61ac6dc965b06ce2317103`. A bridge recebeu a primeira escrita às **16:59:26.562 UTC**. A operação concreta foi apresentada pelo canal de pergunta ao operador:

```text
write_file
Path: <workspace>\fixture\approved-native.txt
Content: AGY_211_HUMAN_APPROVED
Overwrite: false
```

Hash da ação: `3da980750eaf6bc30bab335537b3c57eaea7750f5adb05fbd869a2f4cc357d37`. O callback manteve a decisão pendente, confirmou a ausência do alvo e não aprovou automaticamente. Nenhuma resposta humana foi recebida no prazo de 240 segundos. Às **17:03:26.577 UTC**, o callback expirou com deny. Isso é **negação por expiração**, não uma decisão humana de negar.

O arquivo permaneceu ausente antes e depois da decisão; a ferramenta terminou ERROR por hook deny. `approved-native.txt` e `second-native.txt` estão ausentes. A segunda operação não foi tentada após a primeira ser negada. Portanto, criação após aprovação, conteúdo aprovado e nova aprovação da segunda ação **não foram validados nativamente**. D2 fica BLOCKED. O teste automatizado por ação permanece PASS, sem substituir esse aceite humano. Uma resposta tardia não reutiliza o processo/bridge já encerrados.

## 7. Contrato e correção de autorização

O handler agora valida JSON/estrutura antes de qualquer comunicação. A bridge reconhece `read_file`/`write_file` com `Path`, `view_file` com `AbsolutePath`, escritas documentadas com `TargetFile`, e `run_command` com `Cwd` e `CommandLine`. Ferramenta desconhecida ou parâmetro ausente não cai em ServerRoot: deny.

`workspacePaths` é validado canonicamente. Quando prontidão é exigida, o UUID da conversa fica vinculado à sessão, e chamadas divergentes são negadas. Alvos relativos, fora da raiz, com redirecionamento por link/junction ou ambiguidades de caminho Windows são recusados. Alvo/contexto/integridade são revalidados depois da decisão. Os argumentos originais permanecem na apresentação ao operador, inclusive aspas e conteúdo; não são substituídos ou normalizados no payload aprovado.

A [documentação oficial de hooks](https://antigravity.google/docs/hooks/) descreve nomes/campos documentados e o contrato JSON. Os nomes `read_file`/`write_file` e `Path` acima foram confirmados no executável instalado. O suporte permanece conservador: outras ferramentas são negadas até terem validação definida.

## 8. Testes e arquivos desta etapa

- `npm run build`: PASS.
- `npm test`: **99/99**, zero falhas, skips ou cancelamentos; referência anterior 91/91.
- `git diff --check`: PASS (avisos de conversão LF/CRLF, sem erro de whitespace).
- `node --check test/manual/agy-launcher-windows.mjs`: PASS.
- Oito novos testes: caminhos relativos/absolutos com espaços/Unicode e argumentos com aspas; gramática Windows; migração consentida; reprodução do escape em cmd; handler ausente/bridge inacessível; contrato Path/negações; cancelamento; integridade durante aprovação.
- Os testes existentes continuam cobrindo timeout, descendentes, Codex, Copilot/HTTP, autenticação e decisões por ação. Fixtures não substituem a evidência nativa acima.
- A primeira suíte no sandbox não concluiu `hardening.test.js`; foi encerrada somente a árvore identificada desse teste. A ausência de saída não comprova sua causa interna. Fora do sandbox, uma execução revelou 98/99: o teste antigo esperava que `Cwd:untrusted` chegasse ao callback. Foi corrigido para exigir deny sem callback e testar separadamente um Cwd válido. A repetição final passou 99/99.

Alterados nesta etapa: `README.md`, `src/agy-workspaces.ts`, `src/approval-hook.ts`, `src/providers/agy-approval-bridge.ts`, `test/fixtures/cli.mjs`, `test/agy-workspaces.test.ts`, `test/hardening.test.ts`.

Criados nesta etapa: `test/agy-launcher-windows.test.ts`, `test/manual/agy-launcher-windows.mjs`, este relatório. Os demais arquivos já modificados/criados no preflight foram mantidos. `dist` e os artefatos `.tmp` de build/teste permanecem ignorados.

Estado final do Git: branch/HEAD inalterados, sem alterações staged. Permanecem 12 caminhos rastreados modificados: `.env.example`, `.gitignore`, `IMPLEMENTATION_REPORT.md`, `README.md`, `package.json`, `src/approval-hook.ts`, `src/providers/agy-approval-bridge.ts`, `src/providers/agy-runner.ts`, `src/providers/base.ts`, `src/routes.ts`, `test/fixtures/cli.mjs`, `test/hardening.test.ts`. Os relatórios AGY, módulos de registro/readiness/credenciais, testes associados e `test/manual/` continuam untracked, como no fluxo local anterior, acrescidos dos três arquivos desta etapa. Nada foi adicionado ao index.

## 9. Limpeza, limites e próximo aceite

Conferência final: hooks/launcher gerenciados removidos do workspace descartável; registro privado vazio; runtime do servidor sem leases; nenhum raw log restante; PIDs nativos conhecidos de C/D2/última comparação já encerrados. A amostra inicial está intacta e todas as sentinelas estão ausentes. Evidências e scripts diagnósticos inertes foram preservados para revisão. `summary.json` registra C PASS, D1 PASS, D2 BLOCKED e as verificações de limpeza.

O runner externo continua bloqueado. Além do aceite de autorização humana, uma ativação futura precisa validar o ciclo do runner/cliente real e compatibilizar o prazo de startup com a latência observada: o default de 30 segundos não alcança os aproximadamente 122 segundos desta inicialização. Esta etapa não alterou timeouts, não habilitou bypass e não liberou execução externa via HTTP/ambiente.

Não houve alteração no `.env` real, vault, Starlight, Traycer, OpenCode, credenciais ou configurações globais do AGY. A TUI apenas inspecionou `/hooks`, sem toggles/edições/login novo. Não se encerrou servidor de produção ou serviço compartilhado. Não houve atualização do AGY.

Persistem as limitações de corrida entre validação e uso pelo CLI e a necessidade de proteger as ACLs do runtime privado. A matriz não comprova quoting universal nem execução de Node instalado em caminhos arbitrários. MCP/AGY/OpenAI tools continuam BLOCKED.

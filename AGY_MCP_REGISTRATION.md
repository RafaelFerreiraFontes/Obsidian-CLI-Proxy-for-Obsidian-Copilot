# Registro MCP experimental

O registro MCP tem consentimento separado dos hooks. Não habilita `tools:client`, não altera os perfis AGY e não remove o bloqueio externo do runner. Consulte [o relatório da etapa 2.2](AGY_STAGE22_REPORT.md) antes de usar os componentes experimentais.

Após `npm run build`, com um ID já autorizado em `PROXY_WORKSPACES` e perfil AGY configurado:

```powershell
npm run agy:mcp-workspace -- plan-install --workspace fixture
# Revise arquivos, executable, args, cwd e consentimento do plano.
npm run agy:mcp-workspace -- install --workspace fixture --consent HASH_DO_PLANO
npm run agy:mcp-workspace -- status --workspace fixture
npm run agy:mcp-workspace -- plan-remove --workspace fixture
npm run agy:mcp-workspace -- remove --workspace fixture --consent HASH_DE_REMOCAO
```

O operador concede consentimento para o plano atual; alterações tornam o hash anterior inválido. O mecanismo preserva servidores de terceiros em `.agents/mcp_config.json`, recusa conflitos com `obsidian-cli-proxy-tools`, instala apenas um launcher e não toca MCP global. Node utiliza `command` com `args` separados, sem shell. O executável, handler compilado, launcher, configuração e identidade do diretório são verificados. Cada sessão deve fornecer credenciais efêmeras próprias pelo ambiente; nenhuma credencial do proxy é gravada na configuração do workspace. Sem essas credenciais, o adapter encerra sem oferecer ferramentas.

O catálogo de ferramentas fica em memória na bridge por invocação. Não se reescreve a configuração por sessão. `initialize` do MCP pode ocorrer antes do `init` AGY, a listagem aguarda a correlação com UUID nativo e workspace autorizado sob prazo de init; execução antecipada é rejeitada. A herança observada num processo MCP não comprova isolamento entre duas conversas nativas concorrentes. Essa validação continua sendo pré-requisito para habilitação em produção.

A bridge encaminha chamadas estruturadas ao callback de ferramentas do cliente e não executa comandos ou arquivos. O nome `proxy_approve_action` é excluído. A aprovação de uma operação interna do AGY é uma decisão separada na bridge PreToolUse, vinculada à ação exata; uma resposta MCP não pode autorizá-la.

## Recuperação

O estado privado fica em `.local/mcp-workspaces`, fora do workspace. A instalação usa lock e journal `.pending`; se for interrompida, novas instalações são recusadas. Pare os processos desse experimento, compare o journal privado com os arquivos atuais e revise a recuperação manualmente. Não publique o journal: backups podem preservar configurações privadas de terceiros. Não exclua `.agents` nem substitua servidores de terceiros para recuperar o registro.

A remoção restaura os bytes anteriores quando nada mudou; adições posteriores de terceiros são preservadas. Se o launcher ou entrada gerenciada foi alterado, a remoção automática recusa a operação. Um rebuild que altere o handler exige nova revisão do plano e registro consentido. `status` comprova integridade estática, sem afirmar disponibilidade nativa ou compatibilidade de versão.


## Contrato de transporte da etapa 2.3

O worker realiza attach autenticado uma única vez por invocação. Além do Bearer efêmero, recebe um lease somente em memória; listagem/chamada exigem esse lease e IDs JSON-RPC preservados. O runner fornece o PID real de spawn. No Windows a bridge verifica filiação direta, imagem e data de criação via consulta CIM limitada, sem ler command line nem ambiente. Não há seleção por nome de ferramenta, último pedido ou workspace compartilhado. Falha dessa verificação nega o attach; outra plataforma exige um testemunho de processo implementado e validado, mantendo o bloqueio atual.

As mensagens discover/initialize/tools/list inspecionadas não transportaram conversation_id. A descoberta usa a instância criada pelo processo, credencial exclusiva, testemunho de processo e init nativo entregue pelo runner. A listagem pode esperar init, com cancelamento e prazo; não faz fallback para outro contexto. Alterar ferramentas, modelo ou perfil exige outra invocação. O encerramento, detach ou tentativa de reutilizar/reiniciar um worker revoga a instância. Nenhum segredo é persistido em mcp_config.json.

Uma aprovação humana específica na bridge PreToolUse é necessária antes de publicar onToolCall; seu repasse interno expira em 30 segundos e é consumido uma vez. A autorização não é obtida do resultado MCP nem de texto do modelo. Resultados tardios e replay são recusados. Consulte [o relatório da etapa 2.3](AGY_STAGE23_REPORT.md) para distinguir testes unitários, descoberta nativa, chamadas nativas e gates ainda bloqueados. Pare todos os processos antes de remover registros; o launcher antigo, após rebuild do handler, requer remoção e novo registro consentidos.

## Correlação por chamada — etapa 2.4

O primeiro `tools/call` observado no AGY 1.4.11 trouxe `_meta["antigravity.google/conversation_id"]` e `_meta["antigravity.google/root_conversation_id"]`. O adapter encaminha apenas esses dois campos de identidade para a bridge; ambos devem coincidir com o UUID nativo atestado. Campos ausentes, inválidos ou estrangeiros negam a chamada antes de consumir a aprovação. A descoberta sem esses campos não autoriza execução. Chamadas de subagentes com outro UUID também são recusadas; não há concessão automática ou fallback para PID/cwd.

Esse requisito endurece o contrato experimental: binários que não forneçam esses metadados em `tools/call` são incompatíveis até nova revisão. Não se infere suporte de todas as versões a partir da descoberta ou da documentação. O fingerprint de produção permanece conservador e a existência dos campos não comprova confinamento do backend.

O sink opcional `RunnerConfig.agyMcpObserver` pertence ao servidor confiável, não à API HTTP. Registra hashes separados de sessão HTTP, sessão MCP, conversa, peer, lease e request, além de PID do processo/worker e etapa de rejeição. Não inclui tokens, argumentos ou resultados. A verificação de processo ocorre também depois do resultado do cliente; falha ou desconexão nessa fase impede a publicação do resultado. Consulte [AGY_STAGE24_REPORT.md](AGY_STAGE24_REPORT.md) e [contenção Windows](AGY_WINDOWS_CONTAINMENT.md) antes de repetir provas descartáveis.

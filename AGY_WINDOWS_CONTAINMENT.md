# Contenção Windows — investigação da etapa 2.4

Este documento é um procedimento opt-in de laboratório, não uma configuração de ativação do runner. Nenhuma conta, ACL, firewall, política global ou credencial do usuário foi alterada nesta investigação. Os guards de produção continuam necessários.

## Fronteira que precisa existir

O AGY inteiro, seu backend, workers MCP, hooks e descendentes devem iniciar dentro da fronteira antes de ler configurações de projeto ou iniciar ferramentas. Atestação posterior ao spawn, diretório de trabalho e testemunho CIM não impõem essa restrição. Um hook executado pelo mesmo usuário não protege seus próprios arquivos contra outro processo com os mesmos direitos.

| Recurso | Acesso requerido do agente | Validação de laboratório |
|---|---|---|
| Código, `.env` e configuração do proxy no host | Sem leitura de segredos e sem escrita | Canários sintéticos de leitura/escrita em uma cópia descartável; negar ambos antes da atestação e depois dela |
| Chaves locais, perfis e credenciais do host | Nenhum | Canários fora da raiz concedida; nunca usar credenciais reais para o teste |
| Workspace concedido | Somente o acesso consentido | Ler canário permitido; escrever somente após decisão específica |
| Workspaces e diretórios de outras sessões | Nenhum | Canários distintos por sessão; negar leitura, escrita e travessia por links |
| Hooks, launchers, Node e handlers | Leitura/execução da cópia imutável; sem modificação | Tentativas de substituir arquivo/diretório e retarget de junction negadas pelo SO |
| Registro privado, backups e leases | Sem acesso direto do agente | Negar enumeração e leitura; broker confiável atende apenas a sessão autorizada |
| Processos e canais de outra sessão | Nenhum | Negar abertura de handles, reutilização de IPC e conexão a bridges estrangeiras |
| Rede | Egress explícito e limitado | Permitir somente endpoints necessários; negar LAN, host e endpoints de outras sessões |

As validações devem usar um processo deliberadamente sem hooks, além de ferramentas nativas. Se o processo puder acessar um canário protegido diretamente, não há uma segunda fronteira independente. Um teste negado pelo hook não comprova a ACL/sandbox.

## Opções e limites

| Mecanismo | Utilidade | Limite para este proxy |
|---|---|---|
| Conta Windows padrão dedicada | Separa perfil, credenciais e permissões do usuário interativo | Contas padrão ainda leem diretórios concedidos a grupos amplos. É necessário verificar permissões efetivas e herança de cada diretório; trocar só o usuário não basta |
| Token restrito | Remove privilégios e limita SIDs efetivos | Requer launcher nativo e revisão das permissões de objetos. Não torna caminhos privados automaticamente inacessíveis; a Microsoft também recomenda desktop separado para evitar mensagens a aplicações não restritas |
| DACLs específicas de laboratório | Permitem conceder somente caminhos necessários | Não aplicar deny/remoção de herança na árvore real do usuário. Exigem validação de leitura, escrita, delete-child, owner e reparse points |
| AppContainer/PSE | Pode limitar recursos, rede e interação entre processos | Compatibilidade do AGY, autenticação, Node, CIM e bridge loopback precisa de prova. Este runner não inicia o AGY em AppContainer/PSE |
| Job Object | Agrupa processos para limites e encerramento | Complementa cleanup; não é uma política de acesso ao filesystem. Associações e exceções de breakaway precisam de validação |
| Sandbox de terminal do AGY | Restringe comandos de terminal quando disponível | Não comprova isolamento do próprio CLI, ferramentas internas, configuração, hooks ou workers. Documentação prevê hosts nos quais a flag não tem efeito |
| VM descartável ou Windows Sandbox | Separa kernel/ambiente do host e permite uma fronteira mais ampla | Montagens, clipboard e rede podem reexpor o host. Exige instalação/autenticação separadas e validação; não está integrado ao runner atual |

Fontes primárias: [tokens restritos](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens), [AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [sandbox de terminal AGY](https://antigravity.google/docs/sandbox/). As avaliações de adequação ao proxy são inferências de engenharia; não são resultados de execução desses mecanismos nesta máquina.

## Procedimento opt-in recomendado para a próxima prova

1. Usar VM descartável separada por sessão, com imagem suportada e sem compartilhamento do perfil do host. Windows Sandbox é uma alternativa somente onde a edição e a virtualização o suportarem. Conferir pré-requisitos com o administrador; não habilitar recursos do Windows como parte dos scripts deste repositório.
2. Preparar uma cópia revisada do build e dos binários. Não mapear o diretório real do proxy, `.local`, home, vault, Starlight, `.ssh`, `.aws`, perfis de navegador ou outros workspaces. Usar canários sintéticos em todas as áreas protegidas.
3. Desabilitar clipboard, dispositivos e compartilhamentos desnecessários. Caso seja necessário transportar fixtures, montar apenas uma pasta de entrada dedicada como somente leitura. Uma pasta exportada com escrita deve ser descartável e exclusiva da sessão. Uma montagem read-only ainda permite exfiltrar seu conteúdo.
4. Usar identidade de teste e autenticação nova dentro do convidado, explicitamente provisionadas pelo operador. Não copiar credenciais existentes. Conservar o modo supervisionado e aprovações por ação. Não usar modos de autoexecução ou bypass.
5. Começar sem rede e executar canários locais. Para a inferência real, habilitar somente egress necessário com política validada. O loopback do convidado não é o loopback do host; não publicar a bridge efêmera por uma interface de rede para fazê-la funcionar.
6. Executar proxy, bridge, hook e worker da prova dentro do convidado, mantendo os clientes e canais de controle em uma topologia documentada. Testar autenticação, IDs, expiração, replay, cancelamento e cleanup novamente nessa topologia.
7. Verificar os canários com ferramentas de SO fora do agente, antes da inicialização, durante aprovação pendente e depois do encerramento. Testar descendentes e escapes por links. Registrar usuário/token efetivos e processos associados sem capturar credenciais.
8. Encerrar o convidado, descartar seu estado e revogar a identidade de teste. Exportar apenas evidências sanitizadas. Repetir a matriz entre dois convidados e entre duas sessões no mesmo convidado caso esse último arranjo seja desejado.

Configurações `.wsb` podem restringir montagens, rede, clipboard e dispositivos; os defaults não são suficientes para essa proposta. Ver [configuração Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) e [pré-requisitos](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview). Não há arquivo `.wsb` autoexecutável fornecido nem implantação automática neste trabalho.

## Incompatibilidade importante do runtime atual

O hook atual importa handlers do diretório do proxy e lê um lease privado em `.local/agy-runtime`. Executar esse hook sob a mesma conta restrita do AGY e conceder leitura do lease também concede ao AGY o acesso correspondente. ACLs não distinguem dois processos sob o mesmo token pelo nome do executável.

Para separar o host seria necessário um broker de confiança com IPC autenticado e identidade do processo/sessão, ou mover a pilha experimental inteira para um ambiente descartável sem segredos do host. Nenhuma dessas alternativas é declarada implementada. Não conceder acesso amplo à conta restrita para contornar uma falha de autenticação/lease e não abrir o gate de produção com base apenas nesse procedimento.

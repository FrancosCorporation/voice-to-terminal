# MELHORIAS — voice-to-terminal

> **Atualizado:** 2026-10-11 · Node.js 22/24 · Express + Socket.IO + Google Identity
> Executa shell remoto por decisão de produto; autenticação e isolamento são essenciais.

## 0. Como usar este documento

1. As prioridades seguem P0 → P1 → P2 → P3.
2. Cada achado corresponde ao código que existia antes desta atualização.
3. `shell: true` permanece porque a finalidade é um terminal; a implantação recomendada o
   restringe a um container não-root com filesystem e recursos limitados.
4. **TEST-01 permanece pendente.** Nesta rodada foram feitas checagens estáticas, auditoria
   de dependências e build de imagem; não foram criados nem executados testes automatizados.

## 1. Diagnóstico executivo

O app já verificava o ID token Google e comparava o e-mail com `EMAIL_ADMIN`. A interface e o
servidor, porém, aceitavam qualquer origem, o shell herdava todo o ambiente do Node, não havia
limites de execução/saída nem auditoria persistente, o CSP estava desligado e o Dockerfile
executava como root. O README também não explicava o risco real do terminal.

Agora a origem Socket.IO é restrita, o ID token exige e-mail verificado, comandos recebem um
ambiente mínimo e têm limites de frequência, concorrência, duração e saída. A auditoria JSONL
rotaciona e tem retenção; a interface usa texto seguro e recursos externos compatíveis com CSP.
O Compose isola comandos em container não-root, publicado apenas no loopback. `shell: true`
permanece intencional.

## 2. Tabela de prioridades

| ID | Item | Severidade | Estado |
|---|---|---:|---|
| SEC-01 | CORS amplo em HTTP e Socket.IO | P1 | Implementado |
| SEC-02 | Ambiente completo herdado pelo processo filho | P1 | Implementado |
| SEC-03 | Sem rate limit ou teto de processos | P1 | Implementado |
| SEC-04 | CSP desativada | P2 | Implementado |
| SEC-05 | Saída sem limite | P2 | Implementado |
| SEC-06 | Origem remota HTTP permitida na configuração | P1 | Implementado com validação fail-fast |
| BUG-01 | Diretório de trabalho hardcoded | P2 | Implementado |
| BUG-02 | Filhos sem encerramento gracioso | P2 | Implementado |
| BUG-03 | Health não refletia disponibilidade | P2 | Implementado com fail-fast de configuração |
| IMP-01 | Auditoria ausente | P1 | Implementado; arquivo local não é imutável |
| IMP-02 | Client ID público sem documentação | P3 | Implementado/documentado |
| TEST-01 | Sem testes de autenticação e execução | P1 | Pendente |
| DEVOPS-01 | Sem CI | P2 | Implementado; CI remoto verde em `a1c1eb1` |
| DEVOPS-02 | Shell arbitrário sem limites operacionais | P1 | Limites implementados; shell mantido por decisão de produto |
| DEVOPS-03 | Container executava como root | P2 | Implementado |
| DOC-01 | README não explicava o risco do shell | P1 | Implementado |
| DOC-02 | Falta de SECURITY.md | P3 | Implementado |

## 3. Segurança

### SEC-01 · CORS amplo · [P1]

- **Arquivo:** `server.js:139-151`
- **Evidência:** o HTTP usava `cors()` aberto e Socket.IO aceitava `origin: '*'`.
- **Mudança:** remover CORS HTTP desnecessário no serviço same-origin; restringir polling à origem `FRONTEND_ORIGIN` e validar a origem também em `allowRequest`.
- **Aceite:** browser de origem diferente não completa o handshake; o token Google continua obrigatório.
- **Verificação:** `rg -n 'cors\(|origin:|allowRequest|FRONTEND_ORIGIN' server.js`

### SEC-02 · Segredos herdados pelo shell · [P1]

- **Arquivo:** `server.js:100-107`
- **Evidência:** `spawn` recebia `{ ...process.env }`, incluindo configurações do servidor.
- **Mudança:** fornecer somente `PATH`, `HOME`, `TERM`, `LANG` e `USER` ao filho.
- **Aceite:** `GOOGLE_CLIENT_ID` e outras variáveis do app não aparecem no ambiente passado ao shell.
- **Verificação:** `rg -n 'CHILD_ENV|process\.env|env:' server.js`

### SEC-03 · Execução sem limites · [P1]

- **Arquivo:** `server.js:333-421`
- **Evidência:** cada evento criava processo sem teto, frequência ou tempo máximo.
- **Mudança:** no máximo três processos no serviço, um por socket, 20 tentativas/minuto por conta e timeout de cinco minutos; desconexão encerra os processos daquela sessão.
- **Aceite:** comandos acima dos limites são recusados e processos longos terminam.
- **Verificação:** `rg -n 'MAX_ACTIVE_COMMANDS|MAX_COMMANDS_PER_MINUTE|MAX_COMMAND_DURATION_MS|terminationCause' server.js`

### SEC-04 · CSP desligada · [P2]

- **Arquivo:** `server.js:167-184`, `public/index.html`, `public/app.js`, `public/styles.css`
- **Evidência:** `contentSecurityPolicy: false`; JavaScript, CSS e handlers ficavam inline.
- **Mudança:** habilitar CSP com origens necessárias ao Google Identity Services; externalizar CSS/JS e remover handlers e estilos inline.
- **Aceite:** política ativa sem `unsafe-inline`; conteúdo da UI usa `textContent` e lista de classes permitidas.
- **Verificação:** `rg -n 'contentSecurityPolicy|unsafe-inline|innerHTML|onclick=|onkeydown=|style=' server.js public`

### SEC-05 · Saída ilimitada · [P2]

- **Arquivo:** `server.js:392-415`
- **Evidência:** stdout e stderr eram retransmitidos sem contar bytes.
- **Mudança:** limitar a saída transmitida por comando a 1 MiB por padrão e interromper o processo ao atingir o teto.
- **Aceite:** saída excedente não é encaminhada e o cliente recebe um aviso explícito.
- **Verificação:** `rg -n 'MAX_COMMAND_OUTPUT_BYTES|outputLimited|output_limit' server.js`

### SEC-06 · Origem remota sem HTTPS · [P1]

- **Arquivo:** `server.js`, `readFrontendOrigin`
- **Evidência:** a configuração aceitava qualquer origem `http://`, embora o token Google e os comandos administrativos trafeguem pela conexão do browser; em HTTP remoto, o tráfego pode ser observado ou alterado na rede.
- **Mudança:** permitir HTTP somente para nomes/IPs de loopback (`localhost`, `.localhost`, `127.0.0.0/8` e `::1`); origens HTTP remotas falham na inicialização com orientação para usar HTTPS.
- **Aceite:** desenvolvimento local continua possível; acesso remoto deve usar origem HTTPS por proxy reverso.
- **Verificação estática:** `rg -n 'isLoopbackHostname|FRONTEND_ORIGIN remoto precisa usar HTTPS' server.js`

### DEVOPS-02 · Shell arbitrário · [P1]

- **Arquivo:** `server.js:351-367`
- **Evidência:** a finalidade do produto é executar comandos fornecidos pelo administrador com `shell: true`.
- **Mudança:** manter o shell, mas exigir autenticação Google e limitar origem, frequência, concorrência, duração, ambiente e saída; executar o container como usuário sem privilégios.
- **Aceite:** comandos continuam funcionais dentro do ambiente restrito e o risco residual está explícito no README e em `SECURITY.md`.
- **Verificação:** `rg -n 'shell: true|MAX_COMMAND_DURATION_MS|MAX_COMMAND_OUTPUT_BYTES' server.js`

### DEVOPS-03 · Container privilegiado · [P2]

- **Arquivo:** `Dockerfile:1-17`, `compose.yaml`
- **Evidência:** a imagem antiga não definia `USER` e o Compose inexistente era anunciado no README.
- **Mudança:** usar Node 24 LTS, `USER node`, filesystem somente leitura, volumes dedicados, `cap_drop: ALL`, `no-new-privileges`, limites de CPU/memória/PIDs e porta em loopback.
- **Aceite:** o processo de aplicação e os comandos rodam sem root dentro do container.
- **Verificação:** `docker compose config --quiet` e `docker build --tag voice-to-terminal:local .`

## 4. Bugs e defeitos funcionais

### BUG-01 · Diretório de trabalho hardcoded · [P2]

- **Arquivo:** `server.js:70-76`
- **Evidência:** `cwd` caía em `/home/servidor` quando `HOME` não existia.
- **Mudança:** aceitar `WORKDIR` configurável, resolver o caminho e validar que ele existe e é uma pasta; o Compose usa `/workspace`.
- **Aceite:** nenhum nome de usuário local está no caminho padrão.
- **Verificação:** `rg -n '/home/servidor|WORKDIR' server.js compose.yaml`

### BUG-02 · Processos filhos sem shutdown · [P2]

- **Arquivo:** `server.js:293-314`, `server.js:442-477`
- **Evidência:** não havia tracking de processos nem tratamento de SIGTERM/SIGINT.
- **Mudança:** rastrear filhos, encerrar grupos de processos e aguardar o fechamento do Socket.IO e a gravação de auditoria.
- **Aceite:** desconexão, sinal do sistema, timeout e limite de saída encerram os processos ativos.
- **Verificação:** `rg -n 'activeProcesses|SIGTERM|SIGINT|killProcess|io\.close' server.js`

### BUG-03 · Health sem estado de prontidão · [P2]

- **Arquivo:** `server.js:188-196`, inicialização da configuração
- **Evidência:** `/health` sempre dizia `ok`, inclusive durante encerramento ou falha de auditoria.
- **Mudança:** configuração obrigatória/formato inválido falha no boot; `/health` retorna 503 durante shutdown ou se a auditoria não puder gravar.
- **Aceite:** health representa a disponibilidade operacional que o serviço consegue verificar localmente.
- **Verificação:** `rg -n 'app\.get\("/health"|auditHealthy|shuttingDown|GOOGLE_CLIENT_ID' server.js`

## 5. Qualidade: observabilidade e testes

### IMP-01 · Sem auditoria persistente · [P1]

- **Arquivo:** `server.js:201-293`, `compose.yaml`
- **Evidência:** comandos eram registrados somente em texto no console, sem resultado estruturado.
- **Mudança:** gravar JSONL com timestamp, conta, socket, IP, SHA-256 do comando, resultado, código de saída, duração e bytes; arquivo `0600`, rotação por tamanho e retenção de 90 dias.
- **Aceite:** execução e recusa geram eventos sem armazenar o comando em texto claro.
- **Verificação:** `rg -n 'auditEntry|appendAudit|rotateAuditLogIfNeeded|AUDIT_RETENTION_DAYS' server.js`
- **Limite:** o shell autorizado roda como o mesmo usuário da aplicação e pode adulterar arquivos acessíveis. A auditoria local não é imutável; `SECURITY.md` recomenda encaminhamento externo para esse requisito.

### IMP-02 · Google Client ID no endpoint público · [P3]

- **Arquivo:** `server.js:198-201`, `SECURITY.md`
- **Evidência:** `/api/config` retorna o Client ID usado pelo botão de login.
- **Mudança:** manter o identificador público necessário ao navegador e documentar que ele não é um Client Secret.
- **Aceite:** não há Client Secret Google no código, na imagem ou no ambiente de comandos.
- **Verificação:** `rg -n 'client_secret|CLIENT_SECRET' --glob '*.js' --glob '*.md' .`

### TEST-01 · Ausência de testes · [P1]

- **Arquivo:** *(a criar)* `tests/`
- **Evidência:** os caminhos de autenticação, rate limit e finalização de processos ainda não têm suíte automatizada.
- **Mudança:** futuramente cobrir tokens ausentes/inválidos, conta diferente, ambiente mínimo do shell, limites e health sem rede real.
- **Aceite:** `npm test` cobre a decisão da conta admin e os limites de execução sem invocar comandos destrutivos.
- **Estado:** pendente; não foram adicionados nem executados testes nesta rodada.
- **Verificação futura:** `npm test`

## 6. DevOps / Infra

### DEVOPS-01 · CI ausente · [P2]

- **Arquivo:** `.github/workflows/ci.yml`, `package.json`
- **Evidência:** não havia workflow, checagem sintática nem auditoria de dependências no push.
- **Mudança:** CI executa `npm ci`, `npm run check`, `npm audit --omit=dev --audit-level=high` e uma barreira para a comparação com `EMAIL_ADMIN`.
- **Aceite:** workflow versionado e execução hospedada verde; incluir `npm test` quando TEST-01 existir.
- **Verificação local:** `npm run check && npm audit --omit=dev --audit-level=high`
- **Estado:** workflow publicado; execução no commit `a1c1eb1` concluída com sucesso. `npm run check` e audit de produção passaram; o workflow não executa testes.

## 7. Documentação

### DOC-01 · README não explicava o risco · [P1]

- **Arquivo:** `README.md`
- **Evidência:** instruía Docker sem Compose e não declarava que a conta admin controla um shell arbitrário.
- **Mudança:** documentar setup real, loopback, HTTPS, origem OAuth, container isolado, limites e risco residual.
- **Aceite:** implantação documentada sem sugerir que autenticação transforme shell arbitrário em sandbox.
- **Verificação:** `rg -ni 'shell|terminal|risco|HTTPS|Docker Compose' README.md`

### DOC-02 · Política de segurança ausente · [P3]

- **Arquivo:** *(a criar)* `SECURITY.md`
- **Evidência:** faltava resumo do modelo de acesso, limites e risco de comandos shell.
- **Mudança:** documentar autenticação, ambiente do processo filho, container, auditoria mutável e implantação.
- **Aceite:** SECURITY.md descreve o e-mail verificado como porta de entrada e os limites reais do isolamento.
- **Verificação:** `rg -n 'verifyIdToken|EMAIL_ADMIN|shell|não é imutável|HTTPS' SECURITY.md`

## 8. Ordem de execução

1. **Onda 1 — P1:** SEC-01, SEC-02, SEC-03, IMP-01, TEST-01.
2. **Onda 2 — P1/P2:** SEC-05, DEVOPS-02, BUG-03, DEVOPS-03, BUG-01 e BUG-02.
3. **Onda 3 — P2/P3:** SEC-04, DEVOPS-01, DOC-01, DOC-02 e IMP-02.

As alterações de produção e documentação foram aplicadas. TEST-01 permanece pendente; o
primeiro CI hospedado passou no commit `a1c1eb1`.

## 9. Fora de escopo e riscos

- `shell: true` e a execução de comandos arbitrários permanecem como função principal.
- O container fornece isolamento operacional, mas não é uma sandbox para comandos do admin.
- O shell autorizado pode ler ou alterar arquivos graváveis pelo usuário `node`, inclusive o
  arquivo local da auditoria; encaminhe logs para um destino externo se precisar de trilha
  resistente a adulteração.
- A versão local não tem isolamento de filesystem/CPU/PIDs e deve rodar com conta sem privilégios.
- Não foi executada uma autenticação real Google nem um comando remoto nesta entrega.

## 10. Definição de pronto

**Segurança**

- [x] SEC-01 — origem exata e same-origin HTTP.
- [x] SEC-02 — ambiente de processo filho mínimo.
- [x] SEC-03 — rate limit, concorrência e duração.
- [x] SEC-04 — CSP ativa sem código/estilo inline.
- [x] SEC-05 — teto de saída e encerramento do processo.
- [x] SEC-06 — origem HTTP remota rejeitada na inicialização.
- [x] DEVOPS-02 — shell documentado e limitado operacionalmente.
- [x] DEVOPS-03 — container não-root e endurecido.

**Funcional**

- [x] BUG-01 — `WORKDIR` configurável, sem caminho pessoal hardcoded.
- [x] BUG-02 — encerramento de filhos e shutdown gracioso.
- [x] BUG-03 — health reflete auditoria/shutdown e configuração inválida falha no boot.

**Observabilidade e entrega**

- [x] IMP-01 — auditoria JSONL rotacionada, com limite e retenção; risco de adulteração documentado.
- [x] IMP-02 — Client ID público documentado; sem Client Secret.
- [ ] TEST-01 — suíte offline pendente.
- [x] DEVOPS-01 — workflow publicado e execução remota verde em `a1c1eb1`.
- [x] DOC-01 — README atualizado.
- [x] DOC-02 — SECURITY.md criado.

**Validações executadas:** `npm ci`, `npm run check`, `npm audit --omit=dev --audit-level=high`
(0 vulnerabilidades), `docker compose config --quiet`, build Docker, guarda estática de email
admin e `git diff --check`. Testes e autenticação Google não foram executados.

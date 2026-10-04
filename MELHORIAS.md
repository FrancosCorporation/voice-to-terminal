# MELHORIAS — voice-to-terminal

> **Gerado por análise de código em 2026-10-02** · Stack: Node + Express + Socket.io + Google OAuth (`google-auth-library`) + `child_process.spawn`
> Branch `main` · base `75bf55d` · 680 LOC · 0 testes · Dockerfile+compose · **executa comandos shell**
>
> **Este arquivo é um plano de execução.** Cada item tem ID, `arquivo:linha`, mudança exata,
> critério de aceite e comando de verificação.

---

## 0. Como usar este documento

1. Execute na ordem **P0 → P1 → P2 → P3**, respeitando as ondas da §8.
2. Ao terminar um item: marque `- [x]`, rode o **Verificação**, comite `fix(<ID>): descrição`.
3. **⚠️ Este projeto é o mais perigoso do acervo**: roda **shell comandos arbitrários** no servidor
   (`spawn(comando, [], { shell: true })`, `server.js:141`). Não é defeito — é a **finalidade**.
   A correção aqui é **endurecer a porta de entrada**, não remover a funcionalidade.
4. **A porta de entrada já está bem protegida** (ver §1) — leia por quê antes de mexer.
5. **Idioma:** português.

---

## 1. Diagnóstico executivo

Comando por voz que o servidor executa no terminal. O fluxo: front obtém token Google → conecta via
Socket.io → envia comando → servidor executa com `shell: true` e **transmite stdout em tempo real**.

**O que está bem e foi verificado (não reaça — é o melhor do acervo):**

| Item | Evidência |
|---|---|
| Token **verificado** com `verifyIdToken` (não decodificado) | `server.js:78-83` |
| **Email exato** igual a `EMAIL_ADMIN` — comparação de igualdade | `server.js:90-95` |
| **Fail-closed**: qualquer erro → `next(new Error(...))` | `server.js:97-100` |
| Env **validada no boot** com `process.exit(1)` | `server.js:30-33` |
| `helmet` presente | `server.js:47` |
| `/health` para orquestrador | `server.js:44-46` |
| `connectTimeout` no Socket.io (10 s) | `server.js:64` |
| Log de tentativa rejeitada (`[SECURITY]`) | `server.js:91` |
| Validação de tipo do comando (`typeof !== 'string'`) | `server.js:125` |
| Comentário de risco escrito no próprio arquivo | `server.js:10` (`shell: true (cuidado!)`) |

**O que está quebrado:**

1. **`cors()` com wildcard** (HTTP) e `io.cors.origin: '*'` (Socket) — mesmo com auth, abre
   superfície desnecessária.
2. **O filho recebe `process.env` inteiro** (`server.js:144`) — o comando herda **todos** os segredos
   (`GOOGLE_CLIENT_ID`, e qualquer outro `.env`).
3. Sem **rate limit** de execução e sem teto de processos simultâneos.
4. `contentSecurityPolicy: false` no helmet — desabilita CSP.

---

## 2. Tabela de prioridades

| ID | Título | Sev | Arquivo | Depende de |
|---|---|---|---|---|
| SEC-01 | CORS `*` no Socket.io e `cors()` no HTTP | **P1** | `server.js:58-62` | — |
| SEC-02 | Filho herda `process.env` inteiro (segredos) | **P1** | `server.js:144` | — |
| SEC-03 | Sem rate limit / teto de processos simultâneos | **P1** | `server.js:141` | — |
| SEC-04 | `contentSecurityPolicy: false` no helmet | **P2** | `server.js:47-49` | — |
| SEC-05 | Sem limite de buffer do stdout (resposta ao cliente) | **P2** | `server.js:146-160` | — |
| BUG-01 | `cwd: process.env.HOME || '/home/servidor'` (hardcoded) | **P2** | `server.js:143` | — |
| BUG-02 | Sem `SIGTERM`/shutdown gracioso dos processos filhos | **P2** | `server.js:196` | — |
| BUG-03 | `grep` do `/health` retorna `ok` mesmo sem auth configurada | **P2** | `server.js:44-46` | — |
| IMP-01 | Sem auditoria persistente dos comandos | **P1** | *(ausente)* | SEC-03 |
| IMP-02 | `GOOGLE_CLIENT_ID` exposto em `/api/config` (ok, mas doc) | **P3** | `server.js:52` | — |
| TEST-01 | Zero testes (auth e execução) | **P1** | *(ausente)* | SEC-01 |
| DEVOPS-01 | Sem CI | **P2** | *(ausente)* | — |
| DEVOPS-02 | `shell: true` sem allowlist de comandos (decisão consciente) | **P1** | `server.js:142` | — |
| DOC-01 | README não documenta o risco de `shell: true` | **P1** | `README.md` | SEC-05 |
| DOC-02 | Falta `SECURITY.md` | **P3** | *(ausente)* | — |

**Placar: 0 P0 · 6 P1 · 6 P2 · 3 P3 = 15 itens.**

> **Nenhum P0** — porque a porta de entrada (Google OAuth + email exato + fail-closed) está
> **correta**. Isso é o que separa este projeto dos demais: sem P0, sem "correção de emergência".

---

## 3. Segurança

### SEC-01 · CORS `*` no Socket.io e `cors()` no HTTP · [P1]

- **Arquivo:** `server.js:58-62` e `app.use(cors())` (linha ~47)
- **Evidência:**
  ```javascript
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    ...
  });
  ```
  e `app.use(cors());` sem opções.
- **Impacto:** (a) **não é explotabilidade direta** — o `io.use` (linha 72) verifica o token do Google
  **antes** de deixar entrar, então qualquer origem precisa de um token válido do `EMAIL_ADMIN`. Mas:
  (b) `origin: '*'` permite que qualquer página **visite pelo usuário** inicie o handshake — se o
  token for roubado de outra forma, o atacante usa a sessão de **qualquer origem**; (c) falta
  `credentials`/`reflected origin`, que é o padrão do cookie quando existir; (d) habilita ataques
  contra o **HTTP** (`app.use(cors())`) que hoje só serve estático (`/health`, `/api/config`).
- **Mudança:** (1) `origin: [url do front]` no Socket.io (uma origem explícita, por env
  `FRONTEND_ORIGIN`); (2) idem no `cors()` HTTP; (3) se o front for servido pelo próprio Express
  (`express.static`, linha 49), **nem precisa** de CORS — remova ambos.
- **Aceite:** handshake de origem diferente é recusado antes de chegar ao `verifyIdToken`.
- **Verificação:**
  ```bash
  curl -sI http://localhost:3000/ -H 'Origin: https://evil.example' \
    | grep -i 'access-control-allow-origin'   # ausente (ou so a origem do front)
  ```

### SEC-02 · Filho herda `process.env` inteiro · [P1]

- **Arquivo:** `server.js:144` (`env: { ...process.env, TERM: 'xterm-256color' }`)
- **Evidência:** o `spawn` passa **todo** o `process.env` do servidor para o processo filho.
- **Impacto:** um comando (por mais bem intencionado) pode **ler os segredos do servidor**:
  `echo $GOOGLE_CLIENT_ID` ou qualquer outro `.env` que o processo tenha. Se o `EMAIL_ADMIN` da
  conta for trocado, ou se a validação do token for contornada, o atacante extrai tudo. Além disso,
  **tudo o que for enviado em stdout volta ao cliente** (linha 146-160) — um `env` com segredo vaza
  pela própria ferramenta.
- **Mudança:** (1) criar um env **mínimo** para o filho: `PATH`, `HOME`, `TERM`, `LANG`, `USER` —
  e **nada** do `.env`; (2) se um comando precisa de env específico, adicionar por **nome explicito**;
  (3) nunca incluir `GOOGLE_CLIENT_ID`/`JWT_SECRET`/chaves.
- **Aceite:** rodar `env` (ou `echo $GOOGLE_CLIENT_ID`) **não** mostra segredos do servidor.
- **Verificação:**
  ```bash
  # apos a correcao, enviar via socket:
  #   executar_comando: echo "CLIENTID=[$GOOGLE_CLIENTID]"
  # (deve ser vazio) — e a comparacao antes (mostra o valor) prova o problema
  ```

### SEC-03 · Sem rate limit / teto de processos simultâneos · [P1]

- **Arquivo:** `server.js:141-160`
- **Evidência:** cada `executar_comando` chama `spawn` **sem** limite de concorrência, sem limite
  por janela e sem verificação se já há um processo ativo.
- **Impacto:** o usuário autenticado pode emitir comandos em laço (`ping -f`, `while true; do ...`) e
  **esgotar CPU/memória/disco** do servidor. E como cada comando **envia stdout de volta**, um
  comando que gere muita saída satura a conexão. Não é DoS externo (é o próprio admin), mas é DoS
  **acidental** muito fácil.
- **Mudança:** (1) **teto de processos simultâneos** (ex.: 3) com fila ou recusa;
  (2) **rate limit** por conexão (ex.: 20/min); (3) **matar o processo anterior** (ou pedir confirmação)
  antes de iniciar outro se o teto estiver atingido; (4) limite de **duração** (matar após 5 min).
- **Aceite:** o 4º comando simultâneo é recusado; comando que roda > 5 min é morto.
- **Verificação:**
  ```bash
  # disparar 5 comandos 'sleep 60' seguidos via socket -> o 4o deve ser recusado
  # disparar 'sleep 600' -> morto apos ~5min com aviso
  ```

### DEVOPS-02 · `shell: true` sem allowlist de comandos · [P1]

- **Arquivo:** `server.js:141-145`
- **Evidência:**
  ```javascript
  const processo = spawn(comando, [], { shell: true, cwd: ..., env: ... });
  ```
  O comando vem do cliente e vai **direto** ao shell. Não há allowlist, denylist, nem validação de
  sintaxe (só `typeof === 'string'`, linha 125).
- **Mudança:** 
  1. **Documentar** que a finalidade é terminal remoto e que a segurança depende do token Google e do `EMAIL_ADMIN` (`DOC-01`).
  2. Adicionar a **trilha de auditoria** (`IMP-01`): logar em arquivo com hash do comando, data, IP, socket id.
  3. **Teto de duração** com `timeout` no `spawn` (ex.: 5 min).
  4. Opcional: **allowlist/denylist de comandos** como defesa em profundidade — nunca substituindo a autenticação.
  5. **Não** rodar como root (ver `DEVOPS-03`).

- **Impacto:** é **RCE por design** — mas **protegido** pelo `io.use` (email exato, fail-closed).
  O risco aqui é a **soma**: se a validação de email falhar (revogação do token do Google, contorno
  de `EMAIL_ADMIN` por engano, nova rota sem auth), o atacante executa `rm -rf`, `curl | sh`, etc.
  E **não há trilha de auditoria persistente** (ver `IMP-01`) nem limite de duração — um comando
  que fique rodando em background não é visto.
- **Mudança (decisão consciente, não é "apertar" o sistema):** (1) **documentar** que a finalidade é
  terminal remoto e que a segurança depende da validade do token (`DOC-01`); (2) adicionar a
  **trilha de auditoria** (`IMP-01`): logar em arquivo, com hash do comando, data, IP e socket id;
  (3) **teto de duração** com `timeout` no `spawn`; (4) opcional e recomendado: **allowlist de
  comandos** (ou denylist de extremos como `rm -rf /`, `mkfs`, `dd`) como defesa em profundidade —
  nunca substituindo a autenticação;
  (5) **não** rodar como root (ver `BUG-01`/`DOC-01`).
- **Aceite:** cada comando gera registro auditável; duração limitada; sem root.
- **Verificação:**
  ```bash
  grep -n 'shell: true' server.js   # persiste (proposital) + com timeout/auditoria
  ```

---

## 4. Bugs e defeitos funcionais

### BUG-01 · `cwd: process.env.HOME || '/home/servidor'` · [P2]

- **Arquivo:** `server.js:143`
- **Evidência:** fallback **hardcoded** para `/home/servidor` — o home de um usuário específico.
- **Impacto:** (a) se rodar com outro usuário (container, CI), o `cwd` vira `/home/servidor` —
  `spawn` falha se não existir, ou cai numa pasta **de outro usuário**; (b) expõe o nome de usuário
  do servidor no código; (c) se a pasta for acessível, o comando pode ler arquivos de terceiro.
- **Mudança:** `process.env.CWD || process.env.HOME` (sem fallback no nome de usuário), ou melhor,
  um diretório **dedicado** (`WORKDIR`) configurado por env, com `0700`.
- **Aceite:** nenhum nome de usuário hardcoded; `cwd` é configurável e restrito.
- **Verificação:**
  ```bash
  grep -n '/home/servidor' server.js && echo 'FALHA: hardcoded' || echo OK
  ```

### BUG-02 · Sem `SIGTERM`/shutdown gracioso dos processos filhos · [P2]

- **Arquivo:** `server.js:196` (o `app.listen`/`server.listen`)
- **Evidência:** não há handler de `SIGTERM`/`SIGINT` que **mate os processos filhos** abertos.
- **Impacto:** ao desligar o container, os comandos em execução (que podem escrever em disco/BD)
  são **cortados** abruptamente pelo `docker stop` → estado inconsistente. E os processos filhos
  podem sobreviver ao pai (container parado com processo órfão em execução).
- **Mudança:** (1) trackear os `processo` ativos num `Set`; (2) `SIGTERM` → `kill()` em todos →
  `server.close()` → exit; (3) `unhandledRejection` → log.
- **Aceite:** SIGTERM mata os filhos e fecha o servidor sem deixar órfão.
- **Verificação:**
  ```bash
  docker stop <container>; docker exec <container> pgrep -f 'sleep 60'   # deve ser vazio
  ```

### BUG-03 · `/health` retorna `ok` mesmo sem configuração · [P2]

- **Arquivo:** `server.js:44-46`
- **Evidência:** `res.json({ status: 'ok', ... })` — **sempre** ok, não verifica estado real (auth
  configurada, conexão com Google).
- **Impacto:** o healthcheck está **mentindo**: se `GOOGLE_CLIENT_ID` estiver setado mas inválido, o
  boot passa (`server.js:30` só checa presença) e o `/health` diz `ok` — mas **nenhuma conexão de
  socket autentica**. O orquestrador considera saudável um serviço que não autentica ninguém.
- **Mudança:** `/health` deve verificar o **estado**: (a) `GOOGLE_CLIENT_ID` presente e formato
  válido; (b) (opcional) uma probe real contra o endpoint do Google (sem custo alto); (c) contar
  conexões ativas; (d) devolver `503` se a condição falhar.
- **Aceite:** com `GOOGLE_CLIENT_ID` inválido, `/health` devolve `503` (não `200 ok`).
- **Verificação:**
  ```bash
  GOOGLE_CLIENT_ID=invalido node server.js &
  curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health   # 503
  ```

---

## 5. Qualidade: observabilidade e testes

### IMP-01 · Sem auditoria persistente dos comandos · [P1]

- **Arquivo:** *(ausente)* — o log vai só para `console.log` (`server.js:134`)
- **Evidência:** `console.log(\`[CMD] ${user.name} executando: ${comando}\`)` — para stdout, sem
  estrutura, sem arquivo, sem retenção, sem hash.
- **Impacto:** para um sistema que executa **shell arbitrário**, a trilha de auditoria é **essencial**.
  Hoje: (a) o log some no restart (sem arquivo); (b) não tem hash do comando (pode ser editado);
  (c) não tem IP/socket id (rastreio); (d) não tem separação entre tentativa e resultado (exit code).
  Uma vez que o `EMAIL_ADMIN` for comprometido (ou o token vazar), **não há como reconstruir** o que
  foi feito.
- **Mudança:** (1) arquivo de auditoria com `fs.appendFile` (ou logger com arquivo, `pino`);
  (2) por evento: timestamp, `user.email`, socket id, hash do comando (`sha256`), exit code,
  duração, bytes de saída; (3) permissão `0600` e retenção (ex.: 90 dias); (4) alerta para comandos
  de risco (se houver denylist).
- **Aceite:** após executar um comando, há registro persistente com hash, data, usuário e exit code.
- **Verificação:**
  ```bash
  # executar um comando via socket e conferir:
  tail -1 /var/log/voice-to-terminal/audit.log | jq .   # estruturado, com hash e exit_code
  ```

### SEC-05 · Sem limite de buffer do stdout · [P2]

- **Arquivo:** `server.js:146-160` (`processo.stdout.on('data', ...)`)
- **Evidência:** cada pedaço de `data` é **encaminhado** ao cliente sem contar bytes.
- **Impacto:** comando com saída enorme (ex.: `yes`, `find /`) gera **milhões** de eventos emitidos
  pela rede — satura a conexão Socket.io e a memória do cliente. Junto ao `SEC-03`, é DoS.
- **Mudança:** (1) teto de **bytes** por comando (ex.: 1 MB), truncando com aviso; (2) após o teto,
  matar o processo (a saída gigante é erro, não valor); (3) opção de não transmitir saída longa
  (só retorno do exit code).
- **Aceite:** comando com saída de GB não satura; cliente recebe truncamento explícito.
- **Verificação:**
  ```bash
  # executar 'yes' via socket -> cliente deve receber truncamento apos o teto, e o processo ser morto
  ```


### (cobertura de testes)

### TEST-01 · Zero testes (auth e execução) · [P1]

- **Arquivo:** *(ausente)*
- **Evidência:** nenhum arquivo de teste; sem script `test`.
- **Impacto:** a **única porta de entrada** (email exato, fail-closed) não está coberta. Um refactor
  pode remover a checagem `email !== EMAIL_ADMIN` **sem nenhum teste quebrar** — e o sistema vira
  RCE aberto. É o caso em que teste de segurança é crítico.
- **Mudança:** (1) testar o middleware `io.use` **separadamente** (injetando o `oauthClient` fake):
  - token ausente → recusa; token inválido → recusa; email diferente de `EMAIL_ADMIN` → recusa;
    email igual → `next()` sem erro; (2) testar que `spawn` recebe o **env mínimo** (pós `SEC-02`);
  (3) testar `/health` com config inválida → `503` (pós `BUG-03`).
- **Aceite:** `npm test` roda; falhar se a checagem de email for removida.
- **Verificação:**
  ```bash
  npm test   # inclui o caso 'email diferente -> recusa'
  ```

---

## 6. DevOps / Infra

### DEVOPS-01 · Sem CI · [P2]

- **Arquivo:** *(ausente)* `.github/workflows/`
- **Evidência:** sem workflow (o Dockerfile existe).
- **Impacto:** nada trava a checagem de email de voltar (o `TEST-01` precisa rodar para isso).
- **Mudança:** `ci.yml`: `npm ci`, `npm test`, `npm audit`, e uma barreira que **falhe se** o
  pattern `email !== EMAIL_ADMIN` desaparecer de `server.js`.
- **Aceite:** PR que remove a checagem de email é bloqueado.
- **Verificação:**
  ```bash
  grep -n 'EMAIL_ADMIN' server.js | head -3   # presente
  ```

### DEVOPS-03 · Rodar como usuário não-root · [P2]

- **Arquivo:** `Dockerfile` (verificar `USER`)
- **Evidência:** preciso confirmar — se não há `USER`, o container roda como **root**, e um comando
  executado (`shell: true`) teria **privilegio máximo**.
- **Impacto:** a combinação `root` + `shell arbitrário` transforma o contorno do `EMAIL_ADMIN` em
  **root no host** (dentro do container).
- **Mudança:** (1) `USER nonroot` no Dockerfile; (2) `cap_drop: [ALL]` no compose; (3) `read_only`
  no filesystem (com volume só para o diretório de trabalho).
- **Aceite:** o processo não é root (`id -u` ≠ 0); comandos têm privilégio mínimo.
- **Verificação:**
  ```bash
  docker run --rm --entrypoint id <imagem>    # uid != 0
  ```

---

## 7. Documentação

### DOC-01 · README não documenta o risco de `shell: true` · [P1]

- **Arquivo:** `README.md`
- **Evidência:** o `server.js:10` tem um comentário (`shell: true (cuidado!)`), mas o README **não**
  avisa que a ferramenta executa **qualquer comando** no servidor.
- **Impacto:** quem implanta **não sabe** que está expondo um terminal remoto. Se o `EMAIL_ADMIN`
  trocar (ou o token for roubado), a consequência é destruição total do host — isso precisa estar
  escrito, não implícito num comentário.
- **Mudança:** seção "Riscos" no README: (1) a ferramenta é um **terminal remoto**; (2) a segurança
  depende do token Google **e** do `EMAIL_ADMIN`; (3) rodar como **usuário não-root**, em container
  restrito; (4) a trilha de auditoria (`IMP-01`) e como verificar.
- **Aceite:** README declara explicitamente o que a ferramenta faz e os pré-requisitos de segurança.
- **Verificação:** `grep -ni 'shell\|terminal\|risc' README.md`.

### IMP-02 · `GOOGLE_CLIENT_ID` exposto em `/api/config` · [P3]

- **Arquivo:** `server.js:52-54`
- **Evidência:** `res.json({ googleClientId: GOOGLE_CLIENT_ID })` — e o comentário diz "envia o
  Google Client ID para o frontend".
- **Impacto:** **isso é o comportamento correto** — o Client ID do Google OAuth é **público** por
  design (é o identificador do app, não segredo; o `client_secret` é que é privado e não está
  aqui). Registro só para confirmar que **não é vazamento** e não abrir item desnecessário.
- **Mudança:** nenhum. Documentar no `SECURITY.md` que o Client ID é público por design.
- **Aceite:** confirmado que o `client_secret` (não o `client_id`) é o que não pode aparecer.
- **Verificação:**
  ```bash
  grep -rn 'client_secret\|CLIENT_SECRET' . --include='*.js' --exclude-dir=node_modules   # 0
  ```

---

## 8. Ordem de execução (waves)

### Wave 1 — Superfície e credencial (P1)
1. **`SEC-01`** — CORS explícito (ou remover, se o front é servido pelo próprio Express).
2. **`SEC-02`** — env mínimo para o processo filho.
3. **`IMP-01`** — trilha de auditoria persistente.
4. **`SEC-03`** — teto de processos, rate limit e duração.
5. **`TEST-01`** — testes do middleware (o que protege o todo).

### Wave 2 — Robustez (P1/P2)
6. **`SEC-05`** — limite de stdout (junto com `SEC-03`).
7. **`DEVOPS-02`** — timeout/duration + denylist (com `DOC-01`).
8. **`BUG-03`** — `/health` com estado real.
9. **`DEVOPS-03`** — usuário não-root (antes de qualquer decisão sobre `shell`).
10. **`BUG-01`**, **`BUG-02`** — `cwd` por env, shutdown dos filhos.

### Wave 3 — Qualidade (P2/P3)
11. **`SEC-04`**, **`DEVOPS-01`**, **`DOC-01`**.
12. **`DEVOPS-04`** (se confirmado no Dockerfile), **`IMP-02`** (doc), **`DOC-02`**.

**Dependências que não podem ser invertidas:**
`SEC-02` antes de `SEC-03` (o teto protege um env já mínimo) · `IMP-01` antes de `DEVOPS-02`
(a auditoria precisa existir antes de documentar a allowlist) · `TEST-01` depois de `SEC-01`/`SEC-02`
(testa o comportamento corrigido) · `DEVOPS-03` **antes** de qualquer decisão sobre `shell: true`
(privilegio primeiro).

---

## 9. Fora de escopo / riscos

| Item | Decisão | Motivo |
|---|---|---|
| **Remover** o `shell: true` / colocar allowlist obrigatória | **Não agora** | A finalidade é terminal remoto. O risco é gerenciado por auth + auditoria (`SEC-01`..`IMP-01`) + usuário não-root (`DEVOPS-03`). |
| Trocar Google OAuth por outro provedor | **Não** | O `verifyIdToken` + `EMAIL_ADMIN` é a **melhor porta de entrada** do acervo. |
| Tornar web-based (terceiro usa) | **Não** | É ferramenta de uso pessoal; a porta é por design restrita. |
| Sandbox de comandos (Docker-in-Docker) | **Não, ainda** | seria mais uma camada, mas muda a UX (o comando não vê o host). Avaliar depois das waves. |

**Riscos desta execução:**

- **`SEC-02` (env mínimo) pode quebrar comando** que dependa de env específica (ex.: `API_URL` em
  script). Solução: adicionar por nome explícito (nunca espalhar).
- **`SEC-01` (CORS restrito) pode quebrar front** se rodar em outra origem. Confirme a URL do front
  **antes**.
- **`DEVOPS-03` (não-root) pode impedir comando que exija privilégio** (ex.: parar serviço). Se
  precisar, conceda **uma** capability específica, nunca root.
- **`SEC-03` (teto) pode recusar uso legítimo** (ex.: backup longo). Logue a recusa e documente como
  esperar.

---

## 10. Definição de pronto (DoD)

**Segurança**
- [ ] `SEC-01` — Socket.io só com origem do front (ou sem CORS se same-origin)
- [ ] `SEC-02` — filho recebe **só** `PATH`/`HOME`/`TERM`/`LANG`/`USER`; nenhum segredo
- [ ] `SEC-03` — teto de processos + rate limit + duração máxima
- [ ] `SEC-04` — CSP habilitada (se faça sentido) ou documentado
- [ ] `SEC-05` — saída gigante truncada; processo morto
- [ ] `DEVOPS-02` — timeout + denylist documentada (não substitui auth)
- [ ] `DEVOPS-03` — usuário **não-root** no container

**Funcional**
- [ ] `BUG-01` — `cwd` por env, sem `/home/servidor` hardcoded
- [ ] `BUG-02` — SIGTERM mata os filhos
- [ ] `BUG-03` — `/health` com estado real (503 se config inválida)

**Observabilidade**
- [ ] `IMP-01` — auditoria persistente (timestamp, email, socket, hash, exit code)
- [ ] `IMP-02` — confirmado que o `client_id` é público por design

**Testes e infra**
- [ ] `TEST-01` — middleware coberto (email diferente → recusa)
- [ ] `DEVOPS-01` — CI com barreira anti-remoção da checagem de email
- [ ] `DOC-01` — README declara que é terminal remoto e os pré-requisitos
- [ ] `DOC-02` — `SECURITY.md` com a invariante "email exato é a única porta"

**Validação final:**
```bash
npm test 2>&1 | tail -3
grep -n 'EMAIL_ADMIN' server.js | head -2
grep -rn 'client_secret' . --include='*.js' --exclude-dir=node_modules | head -1   # 0
```

---

*Fim do plano. Gerado por leitura direta do código em 2026-10-02. **Nenhum P0**: a porta de entrada
(Google OAuth + email exato + fail-closed) está correta — este plano é de endurecimento, não de
emergência.*

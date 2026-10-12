# Voice-to-Terminal

Painel web privado que envia comandos por voz ou texto a um terminal dentro do servidor.
O acesso exige um token Google válido cuja conta seja exatamente a conta configurada em
`EMAIL_ADMIN`.

> **Risco:** este aplicativo executa comandos shell arbitrários. Use somente para a sua
> própria conta administrativa, mantenha a origem e o acesso à rede restritos e prefira o
> container endurecido abaixo. Uma conta Google autorizada controla os arquivos e os
> processos disponíveis no ambiente de comando.

## Pré-requisitos

- Docker Engine com Docker Compose (recomendado), ou Node.js 22/24 para execução local.
- Um OAuth Client ID do tipo **Web application** criado no Google Cloud Console.
- A origem da aplicação cadastrada em **Authorized JavaScript origins** no OAuth Client.

## Executar com Docker Compose

```bash
cp .env.example .env
```

Edite `.env` e configure `GOOGLE_CLIENT_ID`, `EMAIL_ADMIN` e `FRONTEND_ORIGIN`. O Client ID
é um identificador público do aplicativo; não coloque um OAuth Client Secret aqui.

```bash
docker compose up --build -d
```

Abra `http://localhost:3000`. O serviço publica a porta apenas no loopback do host, executa
como usuário `node` sem privilégios, descarta capabilities, usa um filesystem somente leitura
e limita CPU, memória, processos e saída dos comandos. Os comandos rodam dentro do container;
`/workspace` é um volume persistente e a auditoria fica em outro volume.

Para abrir um shell no volume de trabalho:

```bash
docker compose exec voice-to-terminal sh
```

O endpoint `/health` indica se o serviço e a gravação da auditoria estão prontos:

```bash
curl http://localhost:3000/health
```

## Executar localmente

Use uma conta de sistema sem privilégios e entenda que comandos locais herdam as permissões
dessa conta. A execução local não recebe o isolamento de filesystem e recursos do Compose.

```bash
cp .env.example .env
npm ci
npm start
```

O padrão local é `http://localhost:3000`, `WORKDIR=.` e auditoria em `./data/audit.jsonl`.
Se mudar a porta, atualize `PORT` e `FRONTEND_ORIGIN` juntos.

## Origem remota

O Compose vincula a porta ao loopback. Para acessar remotamente, mantenha essa configuração e
use um proxy reverso com HTTPS. Defina `FRONTEND_ORIGIN` para a origem pública exata, por
exemplo `https://terminal.example.com`, e cadastre a mesma origem no OAuth Client do Google.
O serviço recusa configuração HTTP para qualquer host fora de loopback; HTTP fica disponível
para `localhost` durante desenvolvimento local.
Não exponha o processo diretamente à Internet sem TLS e controles de rede.

## Limites e auditoria

- Máximo de 3 comandos ativos no serviço, 1 por conexão e 20 tentativas por minuto por conta.
- Cada comando dura no máximo 5 minutos e transmite no máximo 1 MiB de saída por padrão.
- O ambiente dos processos de comando contém apenas `PATH`, `HOME`, `TERM`, `LANG` e `USER`.
- `data/audit.jsonl` registra usuário, origem, hash SHA-256 do comando, resultado, duração e
  bytes enviados. O arquivo gira ao atingir 10 MiB e arquivos antigos são removidos após
  90 dias. Não registra o texto do comando.
- O reconhecimento de voz depende do navegador e pode enviar áudio a um serviço externo de
  reconhecimento; o botão do microfone só inicia a captura depois do clique do usuário.
- O registro é local e não é imutável: como o terminal é deliberadamente poderoso, comandos
  autorizados podem alterar arquivos acessíveis ao usuário do container, inclusive a cópia
  local da auditoria. Use logging externo para trilha resistente a adulteração.

Os limites podem ser ajustados no `.env`; reinicie o serviço após mudanças.

## Verificações estáticas

```bash
npm ci
npm run check
npm audit --omit=dev --audit-level=high
```

O projeto ainda não tem uma suíte de testes automatizados.

## Licença

MIT — consulte [LICENSE](LICENSE).

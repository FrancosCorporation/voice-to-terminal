# Segurança — Voice-to-Terminal

## Modelo de acesso

O serviço executa comandos shell arbitrários por decisão de produto. Cada Socket.IO
connection precisa apresentar um Google ID token que passa por `verifyIdToken`; a conta deve
estar verificada e corresponder a `EMAIL_ADMIN`. A aplicação não usa OAuth Client Secret e
não guarda tokens no disco. O Client ID devolvido ao navegador é público por definição.

A interface e a API são servidas pela mesma origem. HTTP não habilita CORS genérico; o
handshake Socket.IO aceita a origem configurada em `FRONTEND_ORIGIN`. O controle de origem é
uma camada de navegador, não substitui a autenticação.

O navegador só inicia o microfone após o clique do usuário. O reconhecimento depende do
provedor implementado pelo navegador e pode enviar o áudio para um serviço externo.

## Execução de comandos

- O comando mantém `shell: true`, necessário para interpretar entrada de terminal. Portanto,
  uma conta autorizada pode executar qualquer comando disponível no ambiente.
- O processo filho recebe somente `PATH`, `HOME`, `TERM`, `LANG` e `USER`, além do diretório
  de trabalho configurado; as variáveis OAuth não são copiadas para esse ambiente.
- O serviço limita comandos simultâneos, frequência, duração e saída; desconexão, timeout,
  limite de saída e encerramento do servidor terminam o grupo do processo.
- A imagem Compose roda como usuário `node`, com filesystem somente leitura, capabilities
  removidas, `no-new-privileges`, volume de trabalho separado e limites de CPU/memória/PIDs.
- A execução nativa local não oferece esse isolamento e roda com as permissões da conta que
  iniciou `npm start`.

## Auditoria

O arquivo JSONL tem modo `0600`, grava em diretório criado com modo `0700`, é limitado em
tamanho e gira arquivos antigos. Registra email, IP, socket, hash SHA-256, resultado, duração
e bytes de saída, sem gravar o comando em texto claro.

A auditoria local não é imutável: comandos shell executam como o mesmo usuário do servidor e
podem alterar arquivos que esse usuário consegue gravar. Para requisitos de investigação ou
retenção regulatória, encaminhe os logs para um destino externo com controle independente.

## Implantação

- Configure uma conta administrativa Google dedicada e proteja sua sessão e credenciais.
- Não versione `.env`; use `.env.example` somente como modelo.
- Mantenha a porta do Compose no loopback. Para acesso remoto, use HTTPS em proxy reverso e
  defina `FRONTEND_ORIGIN` para a origem HTTPS exata. A aplicação rejeita origens HTTP remotas;
  HTTP só é aceito em loopback para desenvolvimento local.
- Não execute a versão local como root.
- Os comandos podem acessar a rede e os arquivos montados em `/workspace`; não monte o socket
  Docker, diretórios de credenciais do host ou arquivos de segredo no container.

## Reportar vulnerabilidades

Não inclua tokens Google, valores de `.env` ou conteúdo sensível em issues. Descreva o impacto,
os passos mínimos para reproduzir e a versão afetada.

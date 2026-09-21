# Voice to Terminal

## 🐳 Instalação e Execução (Docker) — recomendado

### Pré-requisitos
- [Docker](https://docs.docker.com/get-docker/) + Docker Compose

### Rodar com Docker
```bash
docker compose up --build
```


### Sem Docker (local)
```bash
npm install
npm start
```


Execute comandos no terminal do servidor **por voz**, protegido por
autenticação **Google**. Backend em Node.js (Express + Socket.io) e front-end
que usa reconhecimento de fala do navegador.

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=flat-square&logo=socketdotio&logoColor=white)
![Google Auth](https://img.shields.io/badge/Google%20Auth-OAuth%202.0-4285F4?style=flat-square&logo=google&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Status](https://img.shields.io/badge/status-projeto%20pessoal-blue?style=flat-square)

## Sobre

Pequeno painel web que permite ditar comandos de terminal e vê-los sendo
executados em tempo real no servidor, recebendo a saída de volta pelo
Socket.io. O acesso é restrito: a conexão só é aceita com um **token Google
válido** cujo e-mail seja exatamente o `EMAIL_ADMIN` configurado.

> Aviso de segurança: este projeto executa comandos com `shell: true`. Rode
> apenas em rede confiável, com o e-mail de admin bem configurado.

## Funcionalidades

Comprovadas pelo código em `server.js`:

- Servidor Express com `helmet`, `cors` e health check (`GET /health`).
- **Socket.io autenticado**: valida o ID token do Google (`google-auth-library`)
  e compara o e-mail com `EMAIL_ADMIN` antes de aceitar a conexão.
- Execução de comandos via `child_process.spawn` com streaming de saída para
  o cliente.
- Front-end estático em `public/` com o reconhecimento de voz do navegador.

## Como rodar

1. Crie um OAuth Client ID (Web) no Google Cloud Console.
2. Configure o ambiente:

```bash
cp .env.example .env
# preencha:
# PORT=3000
# GOOGLE_CLIENT_ID=seu_client_id.apps.googleusercontent.com
# EMAIL_ADMIN=seu-email@gmail.com
```

3. Instale e rode:

```bash
npm install
npm start        # http://localhost:3000
```

## Estrutura do projeto

```
server.js        # Express + Socket.io + Google Auth + execução de comandos
public/          # front-end (index.html)
.env.example     # modelo de configuração
```

## Licença

MIT — veja [LICENSE](LICENSE).

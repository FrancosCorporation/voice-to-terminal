/**
 * Voice-to-Terminal — Server
 *
 * Backend Node.js com Express + Socket.io + Google Auth.
 * Executa comandos do terminal via voz, com autenticação Google.
 *
 * SEGURANÇA:
 * - Socket.io SÓ aceita conexão com token Google válido
 * - Email do token DEVE ser idêntico a EMAIL_ADMIN
 * - Comandos são executados com shell: true (cuidado!)
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');
const helmet = require('helmet');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const EMAIL_ADMIN = process.env.EMAIL_ADMIN;

if (!GOOGLE_CLIENT_ID || !EMAIL_ADMIN) {
  console.error('ERRO: Defina GOOGLE_CLIENT_ID e EMAIL_ADMIN no .env');
  process.exit(1);
}

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ─── Express ───────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: false, // Permite scripts inline (necessário para o frontend)
}));
app.use(cors());
app.use(express.json());

// Serve arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, 'public')));

// Rota de health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rota de config — envia o Google Client ID para o frontend
app.get('/api/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// ─── Socket.io + Google Auth Middleware ─────────────────────────────
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Timeout de conexão: 10 segundos
  connectTimeout: 10000,
});

/**
 * Middleware de autenticação Google no Socket.io.
 * Valida o token JWT enviado pelo front-end via auth.
 * SÓ permite conexão se o email for idêntico a EMAIL_ADMIN.
 */
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error('Token de autenticação não fornecido'));
    }

    // Valida o token JWT do Google
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload?.email;
    const name = payload?.name || 'Desconhecido';

    // VERIFICAÇÃO CRÍTICA: email deve ser exatamente o EMAIL_ADMIN
    if (email !== EMAIL_ADMIN) {
      console.warn(`[SECURITY] Conexão rejeitada: email "${email}" não é o admin`);
      return next(new Error('Acesso não autorizado'));
    }

    // Armazena dados do usuário no socket
    socket.data.user = { email, name, picture: payload?.picture };
    console.log(`[AUTH] Conexão autorizada: ${name} (${email})`);

    next();
  } catch (err) {
    console.error(`[AUTH] Erro na validação do token: ${err.message}`);
    next(new Error('Token inválido ou expirado'));
  }
});

// ─── Eventos Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`[CONNECT] ${user.name} conectado (socket: ${socket.id})`);

  // Envia confirmação de conexão
  socket.emit('conexao_confirmada', {
    message: `Conectado como ${user.name}`,
    email: user.email,
  });

  /**
   * Evento: executar_comando
   * Recebe um comando em texto e executa no terminal do servidor.
   * Retorna stdout/stderr em tempo real via evento 'terminal_log'.
   */
  socket.on('executar_comando', (comando) => {
    if (!comando || typeof comando !== 'string') {
      socket.emit('terminal_log', {
        type: 'error',
        data: 'Comando inválido ou vazio',
      });
      return;
    }

    // Log do comando recebido
    console.log(`[CMD] ${user.name} executando: ${comando}`);
    socket.emit('terminal_log', {
      type: 'info',
      data: `> Executando: ${comando}`,
    });

    // Executa o comando com shell: true
    const processo = spawn(comando, [], {
      shell: true,
      cwd: process.env.HOME || '/home/servidor',
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    // stdout em tempo real
    processo.stdout.on('data', (data) => {
      const texto = data.toString();
      socket.emit('terminal_log', { type: 'stdout', data: texto });
    });

    // stderr em tempo real
    processo.stderr.on('data', (data) => {
      const texto = data.toString();
      socket.emit('terminal_log', { type: 'stderr', data: texto });
    });

    // Processo encerrado
    processo.on('close', (code) => {
      const msg = `Processo encerrado com código: ${code}`;
      console.log(`[CMD] ${msg}`);
      socket.emit('terminal_log', {
        type: 'exit',
        data: msg,
        code,
      });
    });

    // Erro ao spawnar processo
    processo.on('error', (err) => {
      socket.emit('terminal_log', {
        type: 'error',
        data: `Erro ao executar comando: ${err.message}`,
      });
    });
  });

  // Desconexão
  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECT] ${user.name} desconectou: ${reason}`);
  });
});

// ─── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Voice-to-Terminal Server               ║');
  console.log(`║   Rodando em http://localhost:${PORT}        ║`);
  console.log('║   Protegido por Google Auth              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`[CONFIG] Admin: ${EMAIL_ADMIN}`);
  console.log(`[CONFIG] Google Client ID: ${GOOGLE_CLIENT_ID.substring(0, 20)}...`);
});

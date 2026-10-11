"use strict";

/**
 * Voice-to-Terminal — Express + Socket.IO + Google Identity.
 *
 * This application intentionally runs shell commands. Access is limited to a
 * verified Google ID token for EMAIL_ADMIN, and Docker runs the shell as the
 * unprivileged `node` user inside a restricted container.
 */

require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const helmet = require("helmet");
const { Server } = require("socket.io");

function readInteger(name, fallback, minimum, maximum) {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === "" ? fallback : Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} deve ser um número inteiro entre ${minimum} e ${maximum}.`);
  }
  return value;
}

function readFrontendOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FRONTEND_ORIGIN deve ser uma origem HTTP ou HTTPS válida.");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("FRONTEND_ORIGIN deve conter somente esquema, host e porta.");
  }
  return parsed.origin;
}

const PORT = readInteger("PORT", 3000, 1, 65535);
const HOST = process.env.HOST || "127.0.0.1";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const EMAIL_ADMIN = (process.env.EMAIL_ADMIN || "").trim().toLowerCase();
const FRONTEND_ORIGIN = readFrontendOrigin(
  process.env.FRONTEND_ORIGIN || `http://localhost:${PORT}`,
);
const WORKDIR = path.resolve(
  process.env.WORKDIR || process.env.HOME || os.homedir(),
);
const COMMAND_HOME = path.resolve(
  process.env.COMMAND_HOME || process.env.HOME || os.homedir(),
);
const AUDIT_LOG_PATH = path.resolve(
  process.env.AUDIT_LOG_PATH || path.join(__dirname, "data", "audit.jsonl"),
);
const MAX_ACTIVE_COMMANDS = readInteger("MAX_ACTIVE_COMMANDS", 3, 1, 8);
const MAX_COMMANDS_PER_MINUTE = readInteger("MAX_COMMANDS_PER_MINUTE", 20, 1, 120);
const MAX_COMMAND_DURATION_MS = readInteger(
  "MAX_COMMAND_DURATION_MS",
  5 * 60 * 1000,
  1000,
  30 * 60 * 1000,
);
const MAX_COMMAND_OUTPUT_BYTES = readInteger(
  "MAX_COMMAND_OUTPUT_BYTES",
  1024 * 1024,
  1024,
  50 * 1024 * 1024,
);
const MAX_AUDIT_BYTES = readInteger(
  "MAX_AUDIT_BYTES",
  10 * 1024 * 1024,
  1024,
  100 * 1024 * 1024,
);
const AUDIT_RETENTION_DAYS = readInteger("AUDIT_RETENTION_DAYS", 90, 1, 3650);

if (!/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID)) {
  throw new Error("Defina um GOOGLE_CLIENT_ID Web válido no arquivo .env.");
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL_ADMIN)) {
  throw new Error("Defina um EMAIL_ADMIN válido no arquivo .env.");
}
if (!fs.existsSync(WORKDIR) || !fs.statSync(WORKDIR).isDirectory()) {
  throw new Error(`WORKDIR precisa existir e ser uma pasta: ${WORKDIR}`);
}

const CHILD_ENV = {
  PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: COMMAND_HOME,
  TERM: "xterm-256color",
  LANG: process.env.LANG || "C.UTF-8",
  USER: process.env.USER || "node",
};

const app = express();
const server = http.createServer(app);
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST"],
  },
  allowRequest(request, callback) {
    const origin = request.headers.origin;
    callback(null, !origin || origin === FRONTEND_ORIGIN);
  },
  connectTimeout: 10000,
  maxHttpBufferSize: 8 * 1024,
});

const activeProcesses = new Set();
const processesBySocket = new Map();
const pendingCommandsBySocket = new Map();
const commandTimestampsByUser = new Map();
const processMetadata = new Map();
const forcedKillTimers = new Map();
let auditQueue = Promise.resolve();
let auditBytes = 0;
let auditHealthy = false;
let shuttingDown = false;
let shutdownStarted = false;
let pendingCommandCount = 0;

const auditDirectory = path.dirname(AUDIT_LOG_PATH);
const auditFileName = path.basename(AUDIT_LOG_PATH);
const auditArchivePrefix = `${auditFileName}.`;

const googleContentSecurityPolicy = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://accounts.google.com/gsi/client"],
  styleSrc: ["'self'", "https://accounts.google.com/gsi/style"],
  connectSrc: [
    "'self'",
    "https://accounts.google.com/gsi/",
    "https://www.google.com",
    "wss://www.google.com",
  ],
  frameSrc: ["https://accounts.google.com/gsi/"],
  imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
};

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: { directives: googleContentSecurityPolicy },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);
app.use(express.static(path.join(__dirname, "public"), { maxAge: "5m" }));

app.get("/health", (_request, response) => {
  const ready = !shuttingDown && auditHealthy;
  response.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "unavailable",
    activeCommands: activeProcesses.size,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/config", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ googleClientId: GOOGLE_CLIENT_ID });
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || !token) {
      return next(new Error("Token de autenticação não fornecido."));
    }

    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();

    if (email !== EMAIL_ADMIN || payload?.email_verified !== true) {
      console.warn("[AUTH] Conexão recusada: identidade não autorizada.");
      return next(new Error("Acesso não autorizado."));
    }

    socket.data.user = {
      email,
      name: payload.name || "Administrador",
    };
    next();
  } catch (error) {
    console.warn(`[AUTH] Falha ao validar token: ${error.message}`);
    next(new Error("Token inválido ou expirado."));
  }
});

function hashCommand(command) {
  return crypto.createHash("sha256").update(command).digest("hex");
}

function auditEntry(event, socket, commandHash, details = {}) {
  return {
    timestamp: new Date().toISOString(),
    event,
    email: socket.data.user.email,
    socket_id: socket.id,
    remote_address: socket.handshake.address,
    command_sha256: commandHash,
    ...details,
  };
}

async function pruneAuditArchives() {
  const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(auditDirectory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .filter((entry) => entry.name.startsWith(auditArchivePrefix))
      .map(async (entry) => {
        const archivePath = path.join(auditDirectory, entry.name);
        const stats = await fs.promises.stat(archivePath);
        if (stats.mtimeMs < cutoff) await fs.promises.unlink(archivePath);
      }),
  );
}

async function prepareAuditLog() {
  await fs.promises.mkdir(auditDirectory, { recursive: true, mode: 0o700 });
  try {
    const stats = await fs.promises.stat(AUDIT_LOG_PATH);
    if (!stats.isFile()) throw new Error("AUDIT_LOG_PATH precisa ser um arquivo.");
    auditBytes = stats.size;
    await fs.promises.chmod(AUDIT_LOG_PATH, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.promises.writeFile(AUDIT_LOG_PATH, "", { mode: 0o600, flag: "a" });
    auditBytes = 0;
  }
  await pruneAuditArchives();
  auditHealthy = true;
}

async function rotateAuditLogIfNeeded(lineBytes) {
  if (auditBytes + lineBytes <= MAX_AUDIT_BYTES || auditBytes === 0) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(
    auditDirectory,
    `${auditFileName}.${timestamp}.old`,
  );
  await fs.promises.rename(AUDIT_LOG_PATH, archivePath);
  await fs.promises.writeFile(AUDIT_LOG_PATH, "", { mode: 0o600, flag: "a" });
  auditBytes = 0;
  await pruneAuditArchives();
}

function appendAudit(record) {
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line);
  const operation = auditQueue.catch(() => {}).then(async () => {
    try {
      await rotateAuditLogIfNeeded(lineBytes);
      await fs.promises.appendFile(AUDIT_LOG_PATH, line, {
        encoding: "utf8",
        mode: 0o600,
      });
      auditBytes += lineBytes;
      auditHealthy = true;
    } catch (error) {
      auditHealthy = false;
      console.error(`[AUDIT] Não foi possível gravar a auditoria: ${error.message}`);
      throw error;
    }
  });
  auditQueue = operation;
  return operation;
}

function sendTerminalLog(socket, type, data, extra = {}) {
  if (socket.connected) socket.emit("terminal_log", { type, data, ...extra });
}

function killProcess(child, force = false) {
  const metadata = processMetadata.get(child);
  if (!metadata || metadata.closed) return;

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") {
      console.error(`[PROCESS] Falha ao enviar ${signal}: ${error.message}`);
      try {
        child.kill(signal);
      } catch (fallbackError) {
        if (fallbackError.code !== "ESRCH") {
          console.error(`[PROCESS] Falha ao encerrar processo: ${fallbackError.message}`);
        }
      }
    }
  }

  if (!force && !forcedKillTimers.has(child)) {
    const timer = setTimeout(() => killProcess(child, true), 2000);
    timer.unref();
    forcedKillTimers.set(child, timer);
  }
}

function removeActiveProcess(child, socketId) {
  activeProcesses.delete(child);
  processMetadata.delete(child);
  const timer = forcedKillTimers.get(child);
  if (timer) clearTimeout(timer);
  forcedKillTimers.delete(child);

  const processes = processesBySocket.get(socketId);
  processes?.delete(child);
  if (processes?.size === 0) processesBySocket.delete(socketId);
}

function refuseCommand(socket, command, reason) {
  sendTerminalLog(socket, "error", reason);
  const commandHash = typeof command === "string" ? hashCommand(command) : null;
  appendAudit(auditEntry("rejected", socket, commandHash, { reason })).catch(() => {});
}

function reserveCommand(socketId) {
  pendingCommandCount += 1;
  pendingCommandsBySocket.set(
    socketId,
    (pendingCommandsBySocket.get(socketId) || 0) + 1,
  );
}

function releaseCommandReservation(socketId) {
  pendingCommandCount = Math.max(pendingCommandCount - 1, 0);
  const pending = (pendingCommandsBySocket.get(socketId) || 1) - 1;
  if (pending > 0) pendingCommandsBySocket.set(socketId, pending);
  else pendingCommandsBySocket.delete(socketId);
}

io.on("connection", (socket) => {
  const user = socket.data.user;
  console.log(`[CONNECT] Administrador conectado (socket ${socket.id}).`);
  socket.emit("conexao_confirmada", {
    message: `Conectado como ${user.name}.`,
    email: user.email,
  });

  socket.on("executar_comando", async (incomingCommand) => {
    if (shuttingDown) {
      refuseCommand(socket, incomingCommand, "O servidor está encerrando.");
      return;
    }
    if (
      typeof incomingCommand !== "string" ||
      !incomingCommand.trim() ||
      incomingCommand.length > 4096 ||
      incomingCommand.includes("\0")
    ) {
      refuseCommand(socket, incomingCommand, "Comando inválido ou acima do limite.");
      return;
    }

    const command = incomingCommand.trim();
    const commandHash = hashCommand(command);
    const now = Date.now();
    const recentCommands = (commandTimestampsByUser.get(user.email) || []).filter(
      (timestamp) => now - timestamp < 60_000,
    );
    if (recentCommands.length >= MAX_COMMANDS_PER_MINUTE) {
      refuseCommand(socket, command, "Limite de comandos por minuto atingido.");
      return;
    }
    recentCommands.push(now);
    commandTimestampsByUser.set(user.email, recentCommands);

    const activeForSocket = processesBySocket.get(socket.id)?.size || 0;
    const pendingForSocket = pendingCommandsBySocket.get(socket.id) || 0;
    if (activeForSocket + pendingForSocket >= 1) {
      refuseCommand(socket, command, "Aguarde o comando atual terminar.");
      return;
    }
    if (activeProcesses.size + pendingCommandCount >= MAX_ACTIVE_COMMANDS) {
      refuseCommand(socket, command, "Limite de comandos simultâneos atingido.");
      return;
    }

    reserveCommand(socket.id);
    try {
      await appendAudit(auditEntry("started", socket, commandHash));
    } catch {
      sendTerminalLog(
        socket,
        "error",
        "A auditoria está indisponível. O comando não foi iniciado.",
      );
      return;
    } finally {
      releaseCommandReservation(socket.id);
    }

    if (shuttingDown || !socket.connected) {
      await appendAudit(
        auditEntry("cancelled_before_start", socket, commandHash, {
          reason: shuttingDown ? "server_shutdown" : "client_disconnected",
        }),
      ).catch(() => {});
      return;
    }

    sendTerminalLog(socket, "info", "> Comando recebido e registrado.");
    console.log(`[CMD] Iniciando comando sha256=${commandHash.slice(0, 12)}.`);

    let child;
    const startedAt = Date.now();
    try {
      child = spawn(command, [], {
        shell: true,
        cwd: WORKDIR,
        env: CHILD_ENV,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      sendTerminalLog(socket, "error", `Erro ao iniciar o comando: ${error.message}`);
      await appendAudit(
        auditEntry("spawn_error", socket, commandHash, { error: error.message }),
      ).catch(() => {});
      return;
    }

    const metadata = {
      socket,
      socketId: socket.id,
      commandHash,
      startedAt,
      outputBytes: 0,
      timedOut: false,
      outputLimited: false,
      terminationCause: null,
      closed: false,
    };
    activeProcesses.add(child);
    processMetadata.set(child, metadata);
    if (!processesBySocket.has(socket.id)) processesBySocket.set(socket.id, new Set());
    processesBySocket.get(socket.id).add(child);

    const timeoutTimer = setTimeout(() => {
      metadata.timedOut = true;
      metadata.terminationCause = "timeout";
      sendTerminalLog(socket, "error", "Comando interrompido após exceder o tempo máximo.");
      killProcess(child);
    }, MAX_COMMAND_DURATION_MS);
    timeoutTimer.unref();

    const forwardOutput = (type, chunk) => {
      if (metadata.closed || metadata.outputLimited) return;
      const remainingBytes = MAX_COMMAND_OUTPUT_BYTES - metadata.outputBytes;
      const acceptedBytes = Math.max(0, Math.min(chunk.length, remainingBytes));
      if (acceptedBytes > 0) {
        sendTerminalLog(socket, type, chunk.subarray(0, acceptedBytes).toString("utf8"));
        metadata.outputBytes += acceptedBytes;
      }
      if (chunk.length > acceptedBytes || metadata.outputBytes >= MAX_COMMAND_OUTPUT_BYTES) {
        metadata.outputLimited = true;
        metadata.terminationCause = "output_limit";
        sendTerminalLog(
          socket,
          "error",
          "Saída atingiu o limite configurado; comando interrompido.",
        );
        killProcess(child);
      }
    };

    child.stdout.on("data", (chunk) => forwardOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => forwardOutput("stderr", chunk));
    child.on("error", (error) => {
      sendTerminalLog(socket, "error", `Erro ao executar comando: ${error.message}`);
    });
    child.on("close", async (code, signal) => {
      metadata.closed = true;
      clearTimeout(timeoutTimer);
      removeActiveProcess(child, socket.id);

      const durationMs = Date.now() - startedAt;
      const outcome =
        metadata.terminationCause || (code === 0 ? "completed" : "failed");
      const message = metadata.timedOut
        ? "Processo encerrado pelo limite de duração."
        : metadata.outputLimited
          ? "Processo encerrado pelo limite de saída."
          : `Processo encerrado com código ${code}${signal ? ` (${signal})` : ""}.`;
      sendTerminalLog(socket, "exit", message, { code, signal });

      await appendAudit(
        auditEntry("finished", socket, commandHash, {
          outcome,
          exit_code: code,
          signal,
          duration_ms: durationMs,
          output_bytes: metadata.outputBytes,
        }),
      ).catch(() => {});
      console.log(
        `[CMD] Finalizado outcome=${outcome} exit=${code} duration_ms=${durationMs} output_bytes=${metadata.outputBytes}.`,
      );
    });
  });

  socket.on("disconnect", (reason) => {
    for (const child of processesBySocket.get(socket.id) || []) {
      const metadata = processMetadata.get(child);
      if (metadata && !metadata.terminationCause) {
        metadata.terminationCause = "client_disconnected";
      }
      killProcess(child);
    }
    console.log(`[DISCONNECT] Socket ${socket.id}: ${reason}.`);
  });
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForProcessClose(child) {
  if (!activeProcesses.has(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  console.log(`[SERVER] Recebido ${signal}; encerrando conexões e comandos ativos.`);

  for (const child of activeProcesses) {
    const metadata = processMetadata.get(child);
    if (metadata && !metadata.terminationCause) {
      metadata.terminationCause = "server_shutdown";
    }
    killProcess(child);
  }

  const processesClosed = Promise.all(
    [...activeProcesses].map((child) => waitForProcessClose(child)),
  );
  const socketsClosed = new Promise((resolve) => io.close(resolve));
  await Promise.race([Promise.all([processesClosed, socketsClosed]), delay(8000)]);

  for (const child of activeProcesses) killProcess(child, true);
  await Promise.race([
    Promise.all([...activeProcesses].map((child) => waitForProcessClose(child))),
    delay(2000),
  ]);
  await auditQueue.catch(() => {});
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.on("error", (error) => {
  console.error(`[SERVER] Não foi possível iniciar: ${error.message}`);
  process.exitCode = 1;
});

prepareAuditLog()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[SERVER] Voice-to-Terminal disponível em ${HOST}:${PORT}.`);
      console.log(`[SERVER] Origem autorizada: ${FRONTEND_ORIGIN}.`);
      console.log(`[SERVER] Diretório de trabalho: ${WORKDIR}.`);
      console.log(`[SERVER] Auditoria ativa em ${AUDIT_LOG_PATH}.`);
    });
  })
  .catch((error) => {
    console.error(`[AUDIT] Não foi possível preparar a auditoria: ${error.message}`);
    process.exitCode = 1;
  });

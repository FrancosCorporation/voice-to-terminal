"use strict";

const MAX_TERMINAL_LINES = 1500;
const MAX_COMMAND_LENGTH = 4096;
const TERMINAL_LINE_TYPES = new Set([
  "stdout",
  "stderr",
  "info",
  "exit",
  "error",
  "cmd",
]);

let socket = null;
let recognition = null;
let isListening = false;

const elements = {
  app: document.getElementById("app"),
  commandInput: document.getElementById("cmd-input"),
  loginError: document.getElementById("login-error"),
  loginStatus: document.getElementById("login-status"),
  loginScreen: document.getElementById("login-screen"),
  microphoneButton: document.getElementById("mic-btn"),
  microphoneStatus: document.getElementById("mic-status"),
  sendButton: document.getElementById("send-btn"),
  terminal: document.getElementById("terminal"),
  userInfo: document.getElementById("user-info"),
};

function showLoginError(message) {
  elements.loginError.textContent = message;
  elements.loginError.hidden = false;
  elements.loginStatus.hidden = true;
}

function clearLoginError() {
  elements.loginError.textContent = "";
  elements.loginError.hidden = true;
}

function handleCredentialResponse(response) {
  if (typeof response?.credential !== "string" || !response.credential) {
    showLoginError("O Google não retornou um token de login válido.");
    return;
  }
  connectSocket(response.credential);
}

function connectSocket(token) {
  socket?.disconnect();
  socket = window.io({
    auth: { token },
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    clearLoginError();
    elements.sendButton.disabled = false;
    appendLine("info", "Conectado ao servidor.");
    showApp();
  });

  socket.on("conexao_confirmada", (data) => {
    appendLine("info", data?.message || "Autenticação concluída.");
    elements.userInfo.textContent = data?.email || "Administrador";
  });

  socket.on("terminal_log", (data) => {
    if (!data || typeof data.data !== "string") return;
    appendLine(data.type, data.data);
  });

  socket.on("connect_error", (error) => {
    const message = error?.message || "Erro de conexão.";
    appendLine("error", `Falha de autenticação: ${message}`);
    showLoginError(message);
    showLogin();
  });

  socket.on("disconnect", (reason) => {
    elements.sendButton.disabled = true;
    appendLine("info", `Desconectado: ${reason}`);
    if (reason === "io server disconnect") showLogin();
  });
}

function appendLine(type, text) {
  const line = document.createElement("div");
  const lineType = TERMINAL_LINE_TYPES.has(type) ? type : "info";
  line.className = `line ${lineType}`;
  line.textContent = text;
  elements.terminal.appendChild(line);

  while (elements.terminal.childElementCount > MAX_TERMINAL_LINES) {
    elements.terminal.firstElementChild.remove();
  }
  elements.terminal.scrollTop = elements.terminal.scrollHeight;
}

function sendCommand() {
  const command = elements.commandInput.value.trim();
  if (!command || !socket?.connected) return;

  if (command.length > MAX_COMMAND_LENGTH) {
    appendLine("error", `O comando ultrapassa ${MAX_COMMAND_LENGTH} caracteres.`);
    return;
  }

  appendLine("cmd", `$ ${command}`);
  socket.emit("executar_comando", command);
  elements.commandInput.value = "";
  elements.commandInput.focus();
}

function initSpeechRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    elements.microphoneStatus.textContent =
      "Reconhecimento de voz não é compatível com este navegador.";
    elements.microphoneButton.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "pt-BR";
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (transcript && socket?.connected) {
      appendLine("cmd", `$ ${transcript} (voz)`);
      socket.emit("executar_comando", transcript);
    } else if (transcript) {
      appendLine("error", "Conecte-se antes de enviar um comando por voz.");
    }
    stopListening();
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed") {
      elements.microphoneStatus.textContent = "Permissão do microfone negada.";
    } else if (event.error === "no-speech") {
      elements.microphoneStatus.textContent = "Nenhuma fala detectada. Tente novamente.";
    } else {
      elements.microphoneStatus.textContent = `Erro no microfone: ${event.error}`;
    }
    stopListening();
  };

  recognition.onend = stopListening;
}

function toggleMicrophone() {
  if (isListening) {
    stopListening();
    return;
  }

  if (!recognition) initSpeechRecognition();
  if (!recognition) return;

  try {
    recognition.start();
    isListening = true;
    elements.microphoneButton.classList.add("listening");
    elements.microphoneStatus.textContent = "Ouvindo... fale agora.";
    elements.microphoneStatus.classList.add("active");
  } catch {
    elements.microphoneStatus.textContent =
      "Não foi possível iniciar o microfone. Tente novamente.";
  }
}

function stopListening() {
  isListening = false;
  elements.microphoneButton.classList.remove("listening");
  elements.microphoneStatus.textContent = "Clique no microfone para falar.";
  elements.microphoneStatus.classList.remove("active");
  try {
    recognition?.stop();
  } catch {
    // O reconhecimento pode já ter parado pelo navegador.
  }
}

function showApp() {
  elements.loginScreen.hidden = true;
  elements.app.hidden = false;
}

function showLogin() {
  elements.app.hidden = true;
  elements.loginScreen.hidden = false;
  elements.userInfo.textContent = "";
}

function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("O login do Google não carregou."));
    document.head.appendChild(script);
  });
}

async function initializeApp() {
  initSpeechRecognition();
  elements.sendButton.disabled = true;
  elements.sendButton.addEventListener("click", sendCommand);
  elements.commandInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendCommand();
  });
  elements.microphoneButton.addEventListener("click", toggleMicrophone);

  try {
    const [response] = await Promise.all([
      fetch("/api/config", { headers: { Accept: "application/json" } }),
      loadGoogleIdentity(),
    ]);
    if (!response.ok) throw new Error("Não foi possível carregar a configuração.");

    const config = await response.json();
    if (!config.googleClientId) throw new Error("Google OAuth não está configurado.");

    window.google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: handleCredentialResponse,
      auto_select: false,
      ux_mode: "popup",
    });
    window.google.accounts.id.renderButton(
      document.getElementById("google-login-btn"),
      { theme: "filled_black", size: "large", shape: "rectangular", width: 260 },
    );
    elements.loginStatus.hidden = true;
  } catch (error) {
    showLoginError(error.message || "Não foi possível preparar o login.");
  }
}

initializeApp();

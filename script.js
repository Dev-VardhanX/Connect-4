// ================= WEBSOCKET & STATE CONFIGURATION =================
const socket = io();

// STATE MANAGEMENT
let myColor = null; // 'red', 'yellow', or null
let roomCode = "";
let boardState = Array(6).fill(null).map(() => Array(7).fill(""));
let currentPlayerColor = "red";
let isGameOver = false;
let clickLock = false; // Locks inputs during chip dropping animations
let isMuted = false;

// DOM ELEMENT REFERENCES
const lobbyScreen = document.getElementById("lobby-screen");
const gameScreen = document.getElementById("game-screen");
const connectionStatus = document.getElementById("connectionStatus");

// Lobby Controls
const roomInput = document.getElementById("roomInput");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");

// Game Screen Controls
const exitLobbyBtn = document.getElementById("exitLobbyBtn");
const roomCodeDisplay = document.getElementById("roomCodeDisplay");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const muteBtn = document.getElementById("muteBtn");
const muteIcon = document.getElementById("muteIcon");
const toast = document.getElementById("toast");

// Scoreboard & Turn Cards
const playerRedCard = document.getElementById("playerRedCard");
const playerYellowCard = document.getElementById("playerYellowCard");
const playerRedName = document.getElementById("playerRedName");
const playerYellowName = document.getElementById("playerYellowName");
const gameStatusAlert = document.getElementById("gameStatusAlert");

// Board & Columns
const board = document.getElementById("board");
const colIndicators = document.getElementById("colIndicators");

// Modals
const gameOverModal = document.getElementById("gameOverModal");
const modalTitle = document.getElementById("modalTitle");
const modalDescription = document.getElementById("modalDescription");
const redRematchBadge = document.getElementById("redRematchBadge");
const yellowRematchBadge = document.getElementById("yellowRematchBadge");
const rematchBtn = document.getElementById("rematchBtn");
const modalExitBtn = document.getElementById("modalExitBtn");

// ================= AUDIO SYNTHESIZER (WEB AUDIO API) =================
let audioCtx = null;

/**
 * Initializes the AudioContext lazily on user interaction
 */
function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    console.warn("Web Audio API is not supported in this browser", e);
  }
}

/**
 * Ensures AudioContext is resumed (browsers auto-suspend audio)
 */
function resumeAudioContext() {
  initAudio();
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

/**
 * Play standard ui click tone
 */
function playClickTone() {
  if (isMuted) return;
  resumeAudioContext();
  if (!audioCtx) return;

  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(900, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.05);

  gainNode.gain.setValueAtTime(0.12, audioCtx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);

  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.05);
}

/**
 * Play game start / opponent join tone
 */
function playStartTone() {
  if (isMuted) return;
  resumeAudioContext();
  if (!audioCtx) return;

  const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.07);

    gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime + idx * 0.07);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + idx * 0.07 + 0.2);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + idx * 0.07);
    osc.stop(audioCtx.currentTime + idx * 0.07 + 0.20);
  });
}

/**
 * Plays sliding chip drop pitch sweep
 */
function playDropTone() {
  if (isMuted) return;
  resumeAudioContext();
  if (!audioCtx) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(450, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(140, audioCtx.currentTime + 0.4);

  gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.4);
}

/**
 * Plays thud on landing bounce
 */
function playBounceTone() {
  if (isMuted) return;
  resumeAudioContext();
  if (!audioCtx) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "triangle";
  osc.frequency.setValueAtTime(90, audioCtx.currentTime);
  osc.frequency.linearRampToValueAtTime(50, audioCtx.currentTime + 0.12);

  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.12);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.12);
}

/**
 * Plays victory arpeggio sound
 */
function playWinArpeggio() {
  if (isMuted) return;
  resumeAudioContext();
  if (!audioCtx) return;

  const notes = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50]; // C4 to C6 major
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.1);

    gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime + idx * 0.1);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + idx * 0.1 + 0.35);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + idx * 0.1);
    osc.stop(audioCtx.currentTime + idx * 0.1 + 0.35);
  });
}

/**
 * Plays defeat sound sequence
 */
function playLoseSequence() {
  if (isMuted) return;
  resumeAudioContext();
  if (!audioCtx) return;

  const notes = [220.00, 196.00, 155.56, 130.81]; // A3, G3, Eb3, C3
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.18);

    gainNode.gain.setValueAtTime(0.12, audioCtx.currentTime + idx * 0.18);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + idx * 0.18 + 0.35);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + idx * 0.18);
    osc.stop(audioCtx.currentTime + idx * 0.18 + 0.35);
  });
}

/**
 * Plays draw chime sound
 */
function playDrawChime() {
  if (isMuted) return;
  resumeAudioContext();
  if (!audioCtx) return;

  const notes = [349.23, 349.23]; // F4, F4 flat
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.2);

    gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime + idx * 0.2);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + idx * 0.2 + 0.3);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + idx * 0.2);
    osc.stop(audioCtx.currentTime + idx * 0.2 + 0.3);
  });
}

// ================= BOARD CREATION =================
/**
 * Generates the board cell divs in DOM
 */
function initBoardDOM() {
  board.innerHTML = "";
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = document.createElement("div");
      cell.classList.add("cell");
      cell.dataset.row = r;
      cell.dataset.col = c;

      // Click Action
      cell.addEventListener("click", () => {
        handleColumnSelection(c);
      });

      // Hover Previews
      cell.addEventListener("mouseenter", () => {
        showPreview(c);
      });

      cell.addEventListener("mouseleave", () => {
        clearPreview();
      });

      board.appendChild(cell);
    }
  }
}

// ================= SYSTEM UI INTERACTIONS =================

/**
 * Show temporary toast message
 */
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2000);
}

/**
 * Toggle between Lobby Screen and Gameplay Screen
 */
function showScreen(screen) {
  lobbyScreen.classList.remove("active");
  gameScreen.classList.remove("active");

  if (screen === "lobby") {
    lobbyScreen.classList.add("active");
  } else if (screen === "game") {
    gameScreen.classList.add("active");
  }
}

/**
 * Updates indicators & dashboard states reflecting turns
 */
function updateDashboardUI() {
  if (isGameOver) return;

  // Set scoreboard highlight
  playerRedCard.classList.remove("active-turn");
  playerYellowCard.classList.remove("active-turn");

  if (currentPlayerColor === "red") {
    playerRedCard.classList.add("active-turn");
  } else {
    playerYellowCard.classList.add("active-turn");
  }

  // Set status alert bar
  gameStatusAlert.classList.remove("pulse-red", "pulse-yellow", "pulse-blue");

  if (!myColor) {
    gameStatusAlert.textContent = "Spectating Match";
    gameStatusAlert.classList.add("pulse-blue");
  } else if (currentPlayerColor === myColor) {
    gameStatusAlert.textContent = "Your Turn!";
    gameStatusAlert.classList.add(`pulse-${myColor}`);
  } else {
    gameStatusAlert.textContent = `Opponent's Turn (${currentPlayerColor})`;
    gameStatusAlert.classList.add(`pulse-${currentPlayerColor}`);
  }
}

/**
 * Shows interactive column hover preview and arrows
 */
function showPreview(col) {
  if (isGameOver || clickLock || !myColor || currentPlayerColor !== myColor) return;

  // Highlight column selector arrow above
  const arrow = colIndicators.querySelector(`[data-col="${col}"]`);
  if (arrow) {
    arrow.classList.add(`active-${myColor}`);
  }

  // Find lowest vacant cell in column
  let vacantRow = -1;
  for (let r = 5; r >= 0; r--) {
    if (boardState[r][col] === "") {
      vacantRow = r;
      break;
    }
  }

  if (vacantRow !== -1) {
    const targetCell = board.querySelector(`[data-row="${vacantRow}"][data-col="${col}"]`);
    if (targetCell) {
      targetCell.classList.add(`preview-${myColor}`);
    }
  }
}

/**
 * Clears any hover preview outlines and arrows
 */
function clearPreview() {
  // Clear indicator arrows
  colIndicators.querySelectorAll(".indicator-arrow").forEach(arrow => {
    arrow.classList.remove("active-red", "active-yellow");
  });

  // Clear cell outlines
  board.querySelectorAll(".cell").forEach(cell => {
    cell.classList.remove("preview-red", "preview-yellow");
  });
}

// ================= GAMEPLAY ACTIONS =================

/**
 * Triggered on cell click - Emits move to server
 */
function handleColumnSelection(col) {
  if (isGameOver || clickLock) return;

  if (!myColor) {
    showToast("You are spectating!");
    return;
  }

  if (currentPlayerColor !== myColor) {
    showToast("It is not your turn!");
    return;
  }

  playClickTone();
  
  // Anti-spam lock
  clickLock = true;

  socket.emit("makeMove", {
    roomCode: roomCode,
    col: col
  });
}

// ================= WEBSOCKET HANDLERS =================

// Socket Connect status events
socket.on("connect", () => {
  connectionStatus.className = "connection-badge status-connected";
  connectionStatus.querySelector(".status-label").textContent = "Connected to Server";
});

socket.on("disconnect", () => {
  connectionStatus.className = "connection-badge status-disconnected";
  connectionStatus.querySelector(".status-label").textContent = "Server Offline. Reconnecting...";
  showToast("Connection to server lost.");
  showScreen("lobby");
});

socket.on("status", (message) => {
  if (gameScreen.classList.contains("active")) {
    gameStatusAlert.textContent = message;
  } else {
    connectionStatus.querySelector(".status-label").textContent = message;
  }
});

// CLIENT ASSIGNED IDENTITY
socket.on("playerAssigned", (data) => {
  myColor = data.color;
  roomCode = data.roomCode;
  roomCodeDisplay.textContent = roomCode;

  // Adjust display text based on roles
  if (myColor === "red") {
    playerRedName.textContent = "You (Host)";
    playerYellowName.textContent = "Waiting for guest...";
    playerYellowCard.classList.add("offline");
  } else {
    playerRedName.textContent = "Opponent (Host)";
    playerYellowName.textContent = "You (Guest)";
    playerYellowCard.classList.remove("offline");
    playerRedCard.classList.remove("offline");
  }

  // Clear old chips
  initBoardDOM();
  boardState = Array(6).fill(null).map(() => Array(7).fill(""));
  isGameOver = false;
  clickLock = false;

  showScreen("game");
});

// GAME START
socket.on("gameStart", (gameState) => {
  boardState = gameState.board;
  currentPlayerColor = gameState.currentPlayerColor;
  isGameOver = false;
  clickLock = false;

  // Make sure cards are marked online
  playerRedCard.classList.remove("offline");
  playerYellowCard.classList.remove("offline");
  
  const guest = gameState.players.find(p => p.color === "yellow");
  if (guest) {
    if (myColor === "red") {
      playerYellowName.textContent = "Player 2";
    } else {
      playerRedName.textContent = "Player 1";
    }
  }

  playStartTone();
  updateDashboardUI();
});

// AUTHORITATIVE MOVE COMPLETED
socket.on("boardUpdated", (data) => {
  const { row, col, color, board: serverBoard, currentPlayerColor: nextTurn, status, winner, winningCells } = data;

  boardState = serverBoard;
  currentPlayerColor = nextTurn;

  // Find target cell DOM element
  const cell = board.querySelector(`[data-row="${row}"][data-col="${col}"]`);
  if (cell) {
    // Generate chip element
    const chip = document.createElement("div");
    chip.className = `chip ${color} drop-r${row}`;
    cell.appendChild(chip);

    // Apply input block during landing
    clickLock = true;

    // Drop Sound effects
    playDropTone();

    // Synchronize Bounce Sound effect with landing keyframes (~75% duration)
    const animDurations = [350, 400, 450, 500, 550, 600];
    const duration = animDurations[row];

    setTimeout(() => {
      playBounceTone();
    }, duration * 0.75);

    // Unlock board inputs after dropping concludes
    setTimeout(() => {
      if (status === "playing") {
        clickLock = false;
        clearPreview(); // clear old hover layouts
      }
    }, duration);
  }

  // Handle Game Ended status
  if (status === "ended") {
    isGameOver = true;
    clickLock = true;
    clearPreview();

    // Small delay to allow dropping chip to bounce and settle
    setTimeout(() => {
      // Highlight winning combination lines
      if (winningCells && winningCells.length > 0) {
        winningCells.forEach(coord => {
          const winCell = board.querySelector(`[data-row="${coord.r}"][data-col="${coord.c}"]`);
          if (winCell) {
            winCell.classList.add("winning-cell");
            winCell.style.color = color === "red" ? "var(--neon-red)" : "var(--neon-yellow)";
          }
        });
      }

      // Format modal layouts
      modalTitle.className = "modal-title";
      if (winner === "draw") {
        modalTitle.textContent = "DRAW GAME";
        modalTitle.classList.add("draw");
        modalDescription.textContent = "No empty slots left! The board is completely full.";
        playDrawChime();
      } else if (winner === myColor) {
        modalTitle.textContent = "VICTORY!";
        modalTitle.classList.add("win");
        modalDescription.textContent = "Congratulations! You aligned four in a row and won the arena.";
        playWinArpeggio();
      } else {
        modalTitle.textContent = "DEFEAT...";
        modalTitle.classList.add("lose");
        modalDescription.textContent = "The opponent aligned four in a row. Better luck next game!";
        playLoseSequence();
      }

      // Reset modal checkboxes
      redRematchBadge.classList.remove("active");
      redRematchBadge.querySelector(".status-check").textContent = "✖";
      yellowRematchBadge.classList.remove("active");
      yellowRematchBadge.querySelector(".status-check").textContent = "✖";

      rematchBtn.removeAttribute("disabled");
      rematchBtn.textContent = "Request Rematch";

      // Render Modal Overlay active
      gameOverModal.classList.add("active");
    }, 700);
  }

  updateDashboardUI();
});

// REMATCH SYSTEM SYNC STATE
socket.on("rematchState", (data) => {
  const { requestedColors } = data;

  if (requestedColors.includes("red")) {
    redRematchBadge.classList.add("active");
    redRematchBadge.querySelector(".status-check").textContent = "✓";
  }
  if (requestedColors.includes("yellow")) {
    yellowRematchBadge.classList.add("active");
    yellowRematchBadge.querySelector(".status-check").textContent = "✓";
  }

  // Disable button if user has already requested
  if (myColor && requestedColors.includes(myColor)) {
    rematchBtn.setAttribute("disabled", "true");
    rematchBtn.textContent = "Waiting for Opponent...";
  }
});

// GAME RESTARTED BY AGREEMENT
socket.on("gameRestarted", (gameState) => {
  boardState = gameState.board;
  currentPlayerColor = gameState.currentPlayerColor;
  isGameOver = false;
  clickLock = false;

  // Clear modal and close
  gameOverModal.classList.remove("active");

  // Re-generate fresh Board divs
  initBoardDOM();
  
  playStartTone();
  updateDashboardUI();
});

// OPPONENT LEFT GAME
socket.on("opponentLeft", (data) => {
  showToast("Opponent left the match.");
  
  // Revert back to host waiting if promoted
  if (myColor === "red") {
    playerRedName.textContent = "You (Host)";
    playerYellowName.textContent = "Waiting for Guest...";
    playerYellowCard.classList.add("offline");
  }

  isGameOver = false;
  clickLock = false;
  boardState = Array(6).fill(null).map(() => Array(7).fill(""));

  // Reset board visuals
  initBoardDOM();
  
  // Close modal if open
  gameOverModal.classList.remove("active");

  gameStatusAlert.textContent = data.message;
  gameStatusAlert.className = "status-badge pulse-red";
  playLoseSequence();
});

// ================= USER INTERACTION TRIGGERS =================

// Host Room btn click
createRoomBtn.addEventListener("click", () => {
  playClickTone();
  // Generate random 5-character string room code
  const code = Math.random().toString(36).substring(2, 7).toUpperCase();
  socket.emit("createRoom", code);
});

// Join Room btn click
joinRoomBtn.addEventListener("click", () => {
  playClickTone();
  const code = roomInput.value.trim().toUpperCase();
  if (code.length === 0) {
    showToast("Please enter a room code!");
    return;
  }
  socket.emit("joinRoom", code);
});

// Copy code click
copyCodeBtn.addEventListener("click", () => {
  playClickTone();
  const code = roomCodeDisplay.textContent;
  if (code && code !== "-----") {
    navigator.clipboard.writeText(code)
      .then(() => {
        showToast("Room code copied to clipboard!");
      })
      .catch(err => {
        console.error("Copy failed", err);
      });
  }
});

// Exit room/lobby btn
exitLobbyBtn.addEventListener("click", () => {
  playClickTone();
  if (confirm("Are you sure you want to leave this game?")) {
    socket.emit("disconnect"); // Trigger server side teardown
    window.location.reload(); // Refresh client session
  }
});

// Mute toggle btn
muteBtn.addEventListener("click", () => {
  isMuted = !isMuted;
  muteIcon.textContent = isMuted ? "🔇" : "🔊";
  playClickTone();
});

// Request Rematch button in Modal
rematchBtn.addEventListener("click", () => {
  playClickTone();
  if (roomCode) {
    socket.emit("requestRematch", roomCode);
  }
});

// Modal exit btn
modalExitBtn.addEventListener("click", () => {
  playClickTone();
  socket.emit("disconnect");
  window.location.reload();
});

// Enable audio context initialization on first click anywhere
document.body.addEventListener("click", () => {
  initAudio();
}, { once: true });
// ================= WEBSOCKET & STATE CONFIGURATION =================
const socket = io();

// STATE MANAGEMENT
let myColor = null; // 'red', 'yellow', or null (spectator/not joined)
let roomCode = "";
let boardState = Array(6).fill(null).map(() => Array(7).fill(""));
let currentPlayerColor = "red";
let isGameOver = false;
let clickLock = false; // Locks board inputs during chip dropping animations
let isMuted = false;
let clickLockTimeout = null; // Safety recovery timeout to prevent permanent UI lockouts

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

// Pre-cache column indicator elements to completely avoid DOM querying during mouse hover loops
const indicatorArrows = Array.from(colIndicators.querySelectorAll(".indicator-arrow"));

// Modals
const gameOverModal = document.getElementById("gameOverModal");
const modalTitle = document.getElementById("modalTitle");
const modalDescription = document.getElementById("modalDescription");
const redRematchBadge = document.getElementById("redRematchBadge");
const yellowRematchBadge = document.getElementById("yellowRematchBadge");
const rematchBtn = document.getElementById("rematchBtn");
const modalExitBtn = document.getElementById("modalExitBtn");

// O(1) Board Cells Element Cache
let cellElements = Array(6).fill(null).map(() => Array(7).fill(null));

// ================= CENTRAL SOUND MANAGER (WEB AUDIO API + MP3 CACHING) =================
const SoundManager = {
  ctx: null,
  activeOscillators: new Set(),
  audioCache: {}, // Caches HTML5 Audio objects to prevent duplicate creations and memory leaks
  activeAudios: new Set(), // Tracks currently playing custom MP3 objects

  /**
   * Initializes the AudioContext lazily on user interaction
   */
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn("Web Audio API is not supported in this browser", e);
    }
  },

  /**
   * Resumes AudioContext if suspended (browser autoplay safety)
   */
  resume() {
    this.init();
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  },

  /**
   * Helper to retrieve or create cached HTML5 Audio elements
   */
  getAudio(type) {
    const paths = {
      start: "sounds/Game_Start.mp3",
      win: "sounds/Game_Win.mp3",
      lose: "sounds/Game_loser.mp3",
      draw: "sounds/Game_Draw.mp3",
      invalid: "sounds/Game_invalid.mp3"
    };

    if (!paths[type]) return null;

    if (!this.audioCache[type]) {
      const audio = new Audio(paths[type]);
      audio.preload = "auto";
      
      // Auto-manage active playback records to avoid stacking and overlapping leaks
      audio.addEventListener("play", () => {
        this.activeAudios.add(audio);
      });
      audio.addEventListener("ended", () => {
        this.activeAudios.delete(audio);
      });
      audio.addEventListener("pause", () => {
        this.activeAudios.delete(audio);
      });

      this.audioCache[type] = audio;
    }

    return this.audioCache[type];
  },

  /**
   * Plays a preloaded MP3 or falls back to Web Audio synthesized sound
   * @param {string} type - The sound identifier
   */
  play(type) {
    if (isMuted) return;
    this.resume();

    // Prevent multiplayer state-change sounds stacking up by stopping preceding ones
    if (["start", "win", "lose", "draw", "invalid"].includes(type)) {
      this.stopAllMP3s();
    }

    // Attempt to load and play cached custom MP3 sound effect
    const audio = this.getAudio(type);
    if (audio) {
      audio.currentTime = 0; // Rewind to start
      this.safePlay(audio);
      return;
    }

    // Synthesize UI sound effect if no MP3 asset matches (Web Audio API)
    if (!this.ctx) return;

    // Throttle high-speed synthesizer node allocations
    if (this.activeOscillators.size > 8) {
      const oldestNode = this.activeOscillators.values().next().value;
      try {
        oldestNode.osc.stop();
      } catch (e) {}
      this.activeOscillators.delete(oldestNode);
    }

    if (type === "click") {
      this.playTone(900, 300, 0.05, 0.12, "sine");
    } else if (type === "drop") {
      this.playTone(450, 140, 0.4, 0.2, "sine"); // Frequency sweep
    } else if (type === "bounce") {
      this.playTone(90, 50, 0.12, 0.35, "triangle"); // Landing thud
    }
  },

  /**
   * Safe Audio.play() wrapper with promise catch to gracefully bypass autoplay blocks
   */
  safePlay(audio) {
    if (!audio) return;
    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(error => {
        console.warn("Audio playback was blocked or interrupted by the browser:", error);
      });
    }
  },

  /**
   * Helper to construct oscillator paths and gain envelopes
   */
  playTone(startFreq, endFreq, duration, volume, waveType, delay = 0) {
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc.type = waveType;
    const startTime = this.ctx.currentTime + delay;

    osc.frequency.setValueAtTime(startFreq, startTime);
    if (startFreq !== endFreq) {
      osc.frequency.exponentialRampToValueAtTime(endFreq, startTime + duration);
    }

    gainNode.gain.setValueAtTime(volume, startTime);
    gainNode.gain.linearRampToValueAtTime(0.01, startTime + duration);

    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);

    const nodeRecord = { osc, gainNode };
    this.activeOscillators.add(nodeRecord);

    osc.start(startTime);
    osc.stop(startTime + duration);

    // Clean reference once sound concludes
    setTimeout(() => {
      this.activeOscillators.delete(nodeRecord);
    }, (delay + duration) * 1000 + 100);
  },

  /**
   * Stop all active long-running MP3 audio playbacks
   */
  stopAllMP3s() {
    this.activeAudios.forEach(audio => {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (e) {}
    });
    this.activeAudios.clear();
  },

  /**
   * Terminates all audio contexts, cached audios, and active oscillator nodes (e.g. on leaveRoom)
   */
  stopAll() {
    this.stopAllMP3s();
    this.activeOscillators.forEach(nodeRecord => {
      try {
        nodeRecord.osc.stop();
      } catch (e) {}
    });
    this.activeOscillators.clear();
  }
};

// ================= BOARD CREATION (DOM ONLY) =================
/**
 * Generates the board cell divs in DOM and pre-caches cell element references
 */
function initBoardDOM() {
  board.innerHTML = "";
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = document.createElement("div");
      cell.classList.add("cell");
      cell.dataset.row = r;
      cell.dataset.col = c;
      board.appendChild(cell);
      cellElements[r][c] = cell; // Cache reference for O(1) rendering
    }
  }
}

/**
 * Draws already-placed chips on the board using cached element lookups
 * Essential for reconnects, spectators, and synchronizing initial late joins.
 */
function renderBoardFromState() {
  initBoardDOM();
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const color = boardState[r][c];
      if (color) {
        const cell = cellElements[r][c];
        if (cell) {
          const chip = document.createElement("div");
          chip.className = `chip ${color}`;
          cell.appendChild(chip);
        }
      }
    }
  }
}

// ================= EVENT DELEGATION BINDINGS =================
/**
 * Sets up board parent level listeners once at startup
 */
function bindBoardEvents() {
  // Click Handler
  board.addEventListener("click", (e) => {
    if (isGameOver || clickLock) return;
    const cell = e.target.closest(".cell");
    if (!cell) return;
    const col = parseInt(cell.dataset.col);
    handleColumnSelection(col);
  });

  // Mouse Over preview update
  board.addEventListener("mouseover", (e) => {
    if (isGameOver || clickLock || !myColor || currentPlayerColor !== myColor) return;
    const cell = e.target.closest(".cell");
    if (!cell) return;
    const col = parseInt(cell.dataset.col);
    showPreview(col);
  });

  // Mouse Leave board boundary
  board.addEventListener("mouseleave", () => {
    clearPreview();
  });
}

// ================= SYSTEM UI STATE TRANSITIONS =================

/**
 * Show temporary toast message
 */
function showToast(message) {
  toast.textContent = message;
  toast.className = "toast show";
  setTimeout(() => {
    toast.className = "toast";
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
  gameStatusAlert.className = "status-badge";

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
 * Shows interactive column hover preview and arrows using O(1) cached arrays
 */
function showPreview(col) {
  if (isGameOver || clickLock || !myColor || currentPlayerColor !== myColor) return;

  // Clear previous previews first to avoid multiple previews
  clearPreview();

  // Highlight column selector arrow above using pre-cached array element
  const arrow = indicatorArrows[col];
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
    const targetCell = cellElements[vacantRow][col];
    if (targetCell) {
      targetCell.classList.add(`preview-${myColor}`);
    }
  }
}

/**
 * Clears any hover preview outlines and arrows using O(1) cached arrays
 */
function clearPreview() {
  // Clear indicator arrows using O(1) pre-cached array
  indicatorArrows.forEach(arrow => {
    arrow.className = "indicator-arrow";
  });

  // Clear cell outlines using O(1) pre-cached array
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = cellElements[r][c];
      if (cell) {
        cell.classList.remove("preview-red", "preview-yellow");
      }
    }
  }
}

// ================= GAMEPLAY ACTIONS =================

/**
 * Triggered on cell click - Emits move to server with safety release timeout
 */
function handleColumnSelection(col) {
  if (isGameOver || clickLock || !myColor || currentPlayerColor !== myColor) return;

  SoundManager.play("click");
  
  // Set anti-spam lock (freed on move rejection, board update, or safety timeout)
  clickLock = true;

  // Establish production-grade safety click release timeout (1.5 seconds)
  // This guarantees input recovery even under extreme network latency or packet loss.
  if (clickLockTimeout) clearTimeout(clickLockTimeout);
  clickLockTimeout = setTimeout(() => {
    if (clickLock && !isGameOver) {
      console.warn("Safety clickLock release triggered.");
      clickLock = false;
    }
  }, 1500);

  socket.emit("makeMove", {
    roomCode: roomCode,
    col: col
  });
}

/**
 * Resets local states completely and returns user back to lobby (SPA style)
 */
function leaveRoom() {
  if (roomCode) {
    socket.emit("leaveRoom", roomCode);
  }

  // Reset local state variables
  myColor = null;
  roomCode = "";
  boardState = Array(6).fill(null).map(() => Array(7).fill(""));
  currentPlayerColor = "red";
  isGameOver = false;
  clickLock = false;
  
  if (clickLockTimeout) {
    clearTimeout(clickLockTimeout);
    clickLockTimeout = null;
  }

  // Terminate any active or queued audio/synthetic playbacks
  SoundManager.stopAll();

  // Reset layout labels and fields
  roomCodeDisplay.textContent = "-----";
  roomInput.value = "";

  playerRedName.textContent = "Connecting...";
  playerYellowName.textContent = "Waiting...";
  playerRedCard.className = "player-card card-red";
  playerYellowCard.className = "player-card card-yellow";

  gameStatusAlert.textContent = "Waiting for players to connect...";
  gameStatusAlert.className = "status-badge pulse-red";

  // Reset rematch badges in modal
  redRematchBadge.classList.remove("active");
  redRematchBadge.querySelector(".status-check").textContent = "✖";
  yellowRematchBadge.classList.remove("active");
  yellowRematchBadge.querySelector(".status-check").textContent = "✖";
  
  rematchBtn.removeAttribute("disabled");
  rematchBtn.textContent = "Request Rematch";

  // Rebuild clear board
  initBoardDOM();
  clearPreview();

  // Close modals
  gameOverModal.classList.remove("active");

  // Show lobby screen
  showScreen("lobby");
  showToast("Left room and returned to Lobby");
}

// ================= WEBSOCKET EVENT HANDLERS =================

// Socket Connect status events
// Socket Connect status events
socket.on("connect", () => {
  connectionStatus.className = "connection-badge status-connected";
  connectionStatus.querySelector(".status-label").textContent = "Connected to Server";
  const banner = document.getElementById("reconnectBanner");
  if (banner) {
    banner.classList.remove("show");
  }
});

socket.on("disconnect", () => {
  connectionStatus.className = "connection-badge status-disconnected";
  connectionStatus.querySelector(".status-label").textContent = "Server Offline. Reconnecting...";
  const banner = document.getElementById("reconnectBanner");
  if (banner) {
    banner.classList.add("show");
  }
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

  // Adjust display text based on roles (Host, Guest, or Spectator)
  if (myColor === "red") {
    playerRedName.textContent = "You (Host)";
    playerYellowName.textContent = "Waiting for guest...";
    playerYellowCard.classList.add("offline");
    playerRedCard.classList.remove("offline");
  } else if (myColor === "yellow") {
    playerRedName.textContent = "Opponent (Host)";
    playerYellowName.textContent = "You (Guest)";
    playerYellowCard.classList.remove("offline");
    playerRedCard.classList.remove("offline");
  } else {
    // Spectator Mode
    playerRedName.textContent = "Player 1 (Host)";
    playerYellowName.textContent = "Player 2 (Guest)";
    playerRedCard.classList.remove("offline");
    playerYellowCard.classList.remove("offline");
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
    } else if (myColor === "yellow") {
      playerRedName.textContent = "Player 1";
    } else {
      playerRedName.textContent = "Player 1 (Host)";
      playerYellowName.textContent = "Player 2 (Guest)";
    }
  }

  // Synchronize board rendering with server state (critical for spectators/late reconnects!)
  renderBoardFromState();

  SoundManager.play("start");
  updateDashboardUI();
});

// AUTHORITATIVE MOVE COMPLETED
socket.on("boardUpdated", (data) => {
  const { row, col, color, board: serverBoard, currentPlayerColor: nextTurn, status, winner, winningCells } = data;

  boardState = serverBoard;
  currentPlayerColor = nextTurn;

  if (clickLockTimeout) {
    clearTimeout(clickLockTimeout);
    clickLockTimeout = null;
  }

  // Find target cell DOM element using high speed cached cell lookups
  const cell = cellElements[row][col];
  if (cell) {
    // Generate chip element
    const chip = document.createElement("div");
    chip.className = `chip ${color} drop-r${row}`;
    cell.appendChild(chip);

    // Apply input block during landing
    clickLock = true;

    // Drop Sound effects
    SoundManager.play("drop");

    // Synchronize Bounce Sound effect with landing keyframes (~75% duration)
    const animDurations = [350, 400, 450, 500, 550, 600];
    const duration = animDurations[row];

    setTimeout(() => {
      SoundManager.play("bounce");
    }, duration * 0.75);

    // Unlock board inputs after dropping concludes
    setTimeout(() => {
      // Remove falling animation class to optimize rendering and GPU composition layers
      chip.classList.remove(`drop-r${row}`);

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
      // Highlight winning combination lines using pre-cached elements
      if (winningCells && winningCells.length > 0) {
        winningCells.forEach(coord => {
          const winCell = cellElements[coord.r][coord.c];
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
        SoundManager.play("draw");
      } else if (winner === myColor) {
        modalTitle.textContent = "VICTORY!";
        modalTitle.classList.add("win");
        modalDescription.textContent = "Congratulations! You aligned four in a row and won the arena.";
        SoundManager.play("win");
      } else if (!myColor) {
        // Spectator view of the game concluding
        modalTitle.textContent = "MATCH CONCLUDED";
        modalTitle.classList.add("draw");
        modalDescription.textContent = `Player ${winner.toUpperCase()} aligned four in a row and secured the win.`;
        SoundManager.play("draw");
      } else {
        modalTitle.textContent = "DEFEAT...";
        modalTitle.classList.add("lose");
        modalDescription.textContent = "The opponent aligned four in a row. Better luck next game!";
        SoundManager.play("lose");
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

// MOVE REJECTED BY SERVER
socket.on("moveRejected", () => {
  if (clickLockTimeout) {
    clearTimeout(clickLockTimeout);
    clickLockTimeout = null;
  }
  clickLock = false;
  SoundManager.play("invalid"); // Play the custom invalid/column-full sound effect!
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

  if (clickLockTimeout) {
    clearTimeout(clickLockTimeout);
    clickLockTimeout = null;
  }

  // Clear modal and close
  gameOverModal.classList.remove("active");

  // Re-generate fresh Board divs and clear O(1) caches
  initBoardDOM();
  
  SoundManager.play("start");
  updateDashboardUI();
});

// OPPONENT LEFT GAME
socket.on("opponentLeft", (data) => {
  showToast("A player left the match.");
  
  isGameOver = false;
  clickLock = false;
  if (clickLockTimeout) {
    clearTimeout(clickLockTimeout);
    clickLockTimeout = null;
  }
  boardState = Array(6).fill(null).map(() => Array(7).fill(""));

  // Reset board visuals
  initBoardDOM();
  clearPreview();
  
  // Close modal if open
  gameOverModal.classList.remove("active");

  gameStatusAlert.textContent = data.message;
  gameStatusAlert.className = "status-badge pulse-red";
  SoundManager.play("lose");

  // Dynamically update scoreboards and names for spectators and active players alike
  if (myColor === "red") {
    playerRedName.textContent = "You (Host)";
    playerYellowName.textContent = "Waiting for Guest...";
    playerYellowCard.classList.add("offline");
    playerRedCard.classList.remove("offline");
  } else if (myColor === "yellow") {
    playerRedName.textContent = "Opponent (Host)";
    playerYellowName.textContent = "You (Guest)";
  } else {
    // Spectating clients
    playerRedName.textContent = "Player 1 (Host)";
    playerYellowName.textContent = "Waiting for Guest...";
    playerYellowCard.classList.add("offline");
    playerRedCard.classList.remove("offline");
  }
});

// ================= USER INTERACTION TRIGGERS =================

// Host Room btn click
createRoomBtn.addEventListener("click", () => {
  SoundManager.play("click");
  const code = Math.random().toString(36).substring(2, 7).toUpperCase();
  socket.emit("createRoom", code);
});

// Join Room btn click
joinRoomBtn.addEventListener("click", () => {
  SoundManager.play("click");
  const code = roomInput.value.trim().toUpperCase();
  if (code.length === 0) {
    showToast("Please enter a room code!");
    return;
  }
  socket.emit("joinRoom", code);
});

// Copy code click (with standard textarea fallback for secure contexts)
copyCodeBtn.addEventListener("click", () => {
  SoundManager.play("click");
  const code = roomCodeDisplay.textContent;
  if (code && code !== "-----") {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(code)
        .then(() => {
          showToast("Room code copied to clipboard!");
        })
        .catch(err => {
          console.error("Clipboard copy failed: ", err);
          fallbackCopyText(code);
        });
    } else {
      fallbackCopyText(code);
    }
  }
});

function fallbackCopyText(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  
  // Prevent screen scroll/jump on focus
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.opacity = "0";
  
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  
  try {
    const successful = document.execCommand("copy");
    if (successful) {
      showToast("Room code copied to clipboard!");
    } else {
      showToast("Failed to copy code.");
    }
  } catch (err) {
    console.error("Fallback copy failed: ", err);
    showToast("Copy not supported on this browser.");
  }
  
  document.body.removeChild(textArea);
}

// Exit room/lobby btn
exitLobbyBtn.addEventListener("click", () => {
  SoundManager.play("click");
  if (confirm("Are you sure you want to leave this game?")) {
    leaveRoom();
  }
});

// Mute toggle btn
muteBtn.addEventListener("click", () => {
  isMuted = !isMuted;
  muteIcon.textContent = isMuted ? "🔇" : "🔊";
  if (isMuted) {
    SoundManager.stopAll();
  } else {
    SoundManager.play("click");
  }
});

// Request Rematch button in Modal
rematchBtn.addEventListener("click", () => {
  SoundManager.play("click");
  if (roomCode) {
    socket.emit("requestRematch", roomCode);
  }
});

// Modal exit btn
modalExitBtn.addEventListener("click", () => {
  SoundManager.play("click");
  leaveRoom();
});

// ================= STARTUP INITIALIZATION =================

// Initialize Board DOM divs
initBoardDOM();

// Bind Events using parent delegation
bindBoardEvents();

// Enable audio context initialization on first click gesture anywhere on screen
document.body.addEventListener("click", () => {
  SoundManager.resume();
}, { once: true });
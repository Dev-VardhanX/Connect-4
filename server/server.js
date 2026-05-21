const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static frontend files from the parent directory
app.use(express.static(path.join(__dirname, "..")));

// Authoritative Server State for Game Rooms
const rooms = {};

/**
 * Calculates win state on the authoritative board
 * @param {Array<Array<string>>} board 
 * @returns {Object} Object indicating won status, winner, and winning coordinates
 */
function checkWin(board) {
  const rows = 6;
  const cols = 7;

  // 1. Horizontal win check
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 3; c++) {
      const val = board[r][c];
      if (val && val === board[r][c + 1] && val === board[r][c + 2] && val === board[r][c + 3]) {
        return { won: true, winner: val, cells: [{ r, c }, { r, c: c + 1 }, { r, c: c + 2 }, { r, c: c + 3 }] };
      }
    }
  }

  // 2. Vertical win check
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows - 3; r++) {
      const val = board[r][c];
      if (val && val === board[r + 1][c] && val === board[r + 2][c] && val === board[r + 3][c]) {
        return { won: true, winner: val, cells: [{ r, c }, { r: r + 1, c }, { r: r + 2, c }, { r: r + 3, c }] };
      }
    }
  }

  // 3. Diagonal Down-Right win check
  for (let r = 0; r < rows - 3; r++) {
    for (let c = 0; c < cols - 3; c++) {
      const val = board[r][c];
      if (val && val === board[r + 1][c + 1] && val === board[r + 2][c + 2] && val === board[r + 3][c + 3]) {
        return { won: true, winner: val, cells: [{ r, c }, { r: r + 1, c: c + 1 }, { r: r + 2, c: c + 2 }, { r: r + 3, c: c + 3 }] };
      }
    }
  }

  // 4. Diagonal Up-Right win check
  for (let r = 3; r < rows; r++) {
    for (let c = 0; c < cols - 3; c++) {
      const val = board[r][c];
      if (val && val === board[r - 1][c + 1] && val === board[r - 2][c + 2] && val === board[r - 3][c + 3]) {
        return { won: true, winner: val, cells: [{ r, c }, { r: r - 1, c: c + 1 }, { r: r - 2, c: c + 2 }, { r: r - 3, c: c + 3 }] };
      }
    }
  }

  return { won: false, winner: null, cells: [] };
}

/**
 * Checks if the board has no empty slots left (draw condition)
 */
function isBoardFull(board) {
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      if (board[r][c] === "") return false;
    }
  }
  return true;
}

/**
 * Scans all active rooms and removes this socket connection.
 * This prevents duplicate active player sessions and spectator ghost leaks.
 * @param {Object} socket - The socket instance
 */
function removeSocketFromAllRooms(socket) {
  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    const playerExists = room.players.some(p => p.id === socket.id);
    if (playerExists) {
      handlePlayerLeave(socket, roomCode);
    } else {
      // If spectator, check if they are in the Socket.IO room channel
      const roomsSet = socket.rooms;
      if (roomsSet && roomsSet.has(roomCode)) {
        handlePlayerLeave(socket, roomCode);
      }
    }
  }
}

/**
 * Shared logic for cleaning up a room when a player leaves or disconnects
 * @param {Object} socket - The socket leaving
 * @param {string} roomCode - The room code
 */
function handlePlayerLeave(socket, roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // Ensure socket cleanly exits the Socket.IO channel first (active player or spectator)
  socket.leave(roomCode);

  const playerIndex = room.players.findIndex(p => p.id === socket.id);
  if (playerIndex === -1) {
    // If they were a spectator, log and return (no active player cleanup needed)
    console.log(`Spectator ${socket.id} left room ${roomCode}`);
    return;
  }

  const leavingPlayer = room.players[playerIndex];
  
  // Remove player from active list
  room.players.splice(playerIndex, 1);
  room.rematchRequests = []; // Cancel any pending rematch requests
  
  console.log(`Player ${socket.id} (${leavingPlayer.color}) left room ${roomCode}`);

  if (room.players.length === 0) {
    // If no players are left in the room, delete it
    delete rooms[roomCode];
    console.log(`Room ${roomCode} deleted (empty)`);
  } else {
    // One player remains, reset board state and revert to waiting mode
    room.status = "waiting";
    room.board = Array(6).fill(null).map(() => Array(7).fill(""));
    room.currentPlayerColor = "red";
    room.winner = null;
    room.winningCells = [];

    // Promote the remaining player to Host (Red)
    const remainingPlayer = room.players[0];
    remainingPlayer.color = "red";

    // Inform the remaining client of their identity update
    io.to(remainingPlayer.id).emit("playerAssigned", { color: "red", roomCode });
    
    // Broadcast the departure and waiting status to all remaining sockets in the room
    io.to(roomCode).emit("opponentLeft", {
      message: `Opponent left the match. You are now Host (Red). Waiting for Player 2...`,
      players: room.players
    });
  }
}

io.on("connection", (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // CREATE ROOM
  socket.on("createRoom", (roomCode) => {
    // Clean up any old active rooms first to prevent duplicate connections
    removeSocketFromAllRooms(socket);

    // If room already exists and has active players, reject recreation
    if (rooms[roomCode] && rooms[roomCode].players.length > 0) {
      socket.emit("status", "Room already exists! Try a different code.");
      return;
    }

    // Initialize room
    rooms[roomCode] = {
      roomCode: roomCode,
      players: [{ id: socket.id, color: "red" }],
      board: Array(6).fill(null).map(() => Array(7).fill("")),
      currentPlayerColor: "red",
      status: "waiting",
      winner: null,
      winningCells: [],
      rematchRequests: []
    };

    socket.join(roomCode);
    console.log(`Room created: ${roomCode} by ${socket.id}`);

    socket.emit("playerAssigned", { color: "red", roomCode });
    socket.emit("status", "Waiting for Opponent...");
  });

  // JOIN ROOM
  socket.on("joinRoom", (roomCode) => {
    // Clean up any old active rooms first
    removeSocketFromAllRooms(socket);

    const room = rooms[roomCode];

    if (!room) {
      socket.emit("status", "Room not found!");
      return;
    }

    // Spectator Joining Mode (Room is full, join as spectator)
    if (room.players.length >= 2) {
      socket.join(roomCode);
      console.log(`Player ${socket.id} joined room ${roomCode} as Spectator`);
      
      socket.emit("playerAssigned", { color: null, roomCode });
      socket.emit("gameStart", {
        board: room.board,
        currentPlayerColor: room.currentPlayerColor,
        status: room.status,
        players: room.players
      });
      socket.emit("status", "Spectating Match");
      return;
    }

    // Standard player joining (Player 2 - Yellow)
    socket.join(roomCode);
    room.players.push({ id: socket.id, color: "yellow" });
    room.status = "playing";
    
    console.log(`Player ${socket.id} joined room ${roomCode} as yellow`);

    // Assign player identity
    socket.emit("playerAssigned", { color: "yellow", roomCode });

    // Broadcast gameplay start to all clients in the room
    io.to(roomCode).emit("gameStart", {
      board: room.board,
      currentPlayerColor: room.currentPlayerColor,
      status: room.status,
      players: room.players
    });
    
    io.to(roomCode).emit("status", "Game Started!");
  });

  // AUTHORITATIVE MOVE EVENT
  socket.on("makeMove", (data) => {
    const { roomCode, col } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== "playing") {
      socket.emit("moveRejected");
      return;
    }

    // Identify which player sent the move
    const player = room.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit("moveRejected");
      return;
    }

    // Enforce turn verification
    if (player.color !== room.currentPlayerColor) {
      socket.emit("status", "Not your turn!");
      socket.emit("moveRejected");
      return;
    }

    // Verify column range
    if (col < 0 || col > 6) {
      socket.emit("moveRejected");
      return;
    }

    // Authoritative gravity calculation (find landing row)
    let landingRow = -1;
    for (let r = 5; r >= 0; r--) {
      if (room.board[r][col] === "") {
        landingRow = r;
        break;
      }
    }

    // Column is full, reject move
    if (landingRow === -1) {
      socket.emit("status", "Column is full!");
      socket.emit("moveRejected");
      return;
    }

    // Update server state
    room.board[landingRow][col] = player.color;

    // Check for Win
    const winResult = checkWin(room.board);
    if (winResult.won) {
      room.status = "ended";
      room.winner = player.color;
      room.winningCells = winResult.cells;
    } else if (isBoardFull(room.board)) {
      room.status = "ended";
      room.winner = "draw";
    } else {
      // Toggle turn
      room.currentPlayerColor = room.currentPlayerColor === "red" ? "yellow" : "red";
    }

    // Broadcast move event with state updates
    io.to(roomCode).emit("boardUpdated", {
      row: landingRow,
      col: col,
      color: player.color,
      board: room.board,
      currentPlayerColor: room.currentPlayerColor,
      status: room.status,
      winner: room.winner,
      winningCells: room.winningCells
    });
  });

  // REQUEST REMATCH
  socket.on("requestRematch", (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.status !== "ended") return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (!room.rematchRequests.includes(player.color)) {
      room.rematchRequests.push(player.color);
    }

    // Inform both players of current rematch requests
    io.to(roomCode).emit("rematchState", {
      requestedColors: room.rematchRequests
    });

    // Check consensus (both players request rematch)
    if (room.rematchRequests.length === 2) {
      // Reset room state
      room.board = Array(6).fill(null).map(() => Array(7).fill(""));
      room.currentPlayerColor = "red"; // Red starts fresh game
      room.status = "playing";
      room.winner = null;
      room.winningCells = [];
      room.rematchRequests = [];

      // Broadcast fresh start
      io.to(roomCode).emit("gameRestarted", {
        board: room.board,
        currentPlayerColor: room.currentPlayerColor,
        status: room.status
      });

      io.to(roomCode).emit("status", "Rematch started! Red's turn.");
    }
  });

  // EXPLICIT LEAVE ROOM EVENT
  socket.on("leaveRoom", (roomCode) => {
    if (roomCode) {
      handlePlayerLeave(socket, roomCode);
    }
  });

  // DISCONNECT HANDLING
  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);

    // Scan all rooms for this socket connection
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const playerExists = room.players.some(p => p.id === socket.id);

      if (playerExists) {
        handlePlayerLeave(socket, roomCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
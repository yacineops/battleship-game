const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const BOARD_SIZE = 10;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("معركة السفن - WebSocket Server يعمل");
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();
const connections = new Set();

let nextPlayerId = 1;
let nextRoomId = 1;

function send(ws, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify(data));
}

function createPlayer(ws, name = "لاعب") {
    return {
        id: String(nextPlayerId++),
        name: String(name || "لاعب").slice(0, 30),
        ws,
        roomId: null,
        ready: false,
        battleReady: false,
        grid: createEmptyGrid(),
        shipCells: new Set(),
        attackedCells: new Set()
    };
}

function createEmptyGrid() {
    return Array.from(
        { length: BOARD_SIZE },
        () => Array(BOARD_SIZE).fill("")
    );
}

function createRoomCode() {
    let code;

    do {
        code = String(nextRoomId++).padStart(4, "0");
    } while (rooms.has(code));

    return code;
}

function createRoom(roomName, owner) {
    const room = {
        id: createRoomCode(),
        name: String(roomName || "غرفة").slice(0, 40),
        players: [owner],
        started: false,
        currentPlayerId: null,
        winnerId: null
    };

    rooms.set(room.id, room);
    owner.roomId = room.id;

    return room;
}

function getRoom(player) {
    if (!player || !player.roomId) return null;
    return rooms.get(player.roomId) || null;
}

function getOpponent(room, player) {
    if (!room) return null;

    return room.players.find(
        other => other.id !== player.id
    ) || null;
}

function broadcastRoom(room, data) {
    if (!room) return;

    for (const player of room.players) {
        send(player.ws, data);
    }
}

function sendRoomInfo(room) {
    if (!room) return;

    for (const player of room.players) {
        send(player.ws, {
            type: "roomInfo",
            roomId: room.id,
            roomName: room.name,
            players: room.players.map(other => ({
                id: other.id,
                name: other.name,
                ready: other.ready,
                battleReady: other.battleReady
            }))
        });
    }
}

function normalizeGrid(grid) {
    const result = createEmptyGrid();

    if (!Array.isArray(grid)) {
        return result;
    }

    for (let row = 0; row < BOARD_SIZE; row++) {
        if (!Array.isArray(grid[row])) continue;

        for (let col = 0; col < BOARD_SIZE; col++) {
            const value = grid[row][col];

            if (
                value === "ship" ||
                value === "hit" ||
                value === "miss"
            ) {
                result[row][col] = value;
            } else {
                result[row][col] = "";
            }
        }
    }

    return result;
}

function getShipCells(grid) {
    const cells = new Set();

    for (let row = 0; row < BOARD_SIZE; row++) {
        for (let col = 0; col < BOARD_SIZE; col++) {
            if (grid[row][col] === "ship") {
                cells.add(row * BOARD_SIZE + col);
            }
        }
    }

    return cells;
}

function resetPlayerBattleData(player) {
    player.ready = false;
    player.battleReady = false;
    player.grid = createEmptyGrid();
    player.shipCells = new Set();
    player.attackedCells = new Set();
}

function startBattle(room) {
    if (!room || room.players.length !== 2) return;
    if (room.started) return;

    const firstPlayer = room.players[0];

    room.started = true;
    room.currentPlayerId = firstPlayer.id;
    room.winnerId = null;

    for (const player of room.players) {
        send(player.ws, {
            type: "startGame",
            roomId: room.id,
            grid: player.grid,
            firstPlayer: firstPlayer.id,
            playerId: player.id,
            opponentId: getOpponent(room, player)?.id || null
        });
    }
}

function handleConnect(player, message) {
    if (message.playerName || message.name) {
        player.name = String(
            message.playerName || message.name
        ).slice(0, 30);
    }

    send(player.ws, {
        type: "connected",
        playerId: player.id,
        playerName: player.name
    });
}

function handleCreateRoom(player, message) {
    if (player.roomId) {
        send(player.ws, {
            type: "error",
            message: "أنت داخل غرفة بالفعل"
        });
        return;
    }

    if (message.playerName || message.name) {
        player.name = String(
            message.playerName || message.name
        ).slice(0, 30);
    }

    const room = createRoom(
        message.roomName || "غرفة جديدة",
        player
    );

    send(player.ws, {
        type: "roomCreated",
        roomId: room.id,
        roomName: room.name,
        playerId: player.id,
        waiting: true
    });

    sendRoomInfo(room);
}

function handleJoinRoom(player, message) {
    if (player.roomId) {
        send(player.ws, {
            type: "error",
            message: "أنت داخل غرفة بالفعل"
        });
        return;
    }

    const roomId = String(
        message.roomId ||
        message.roomCode ||
        ""
    ).trim();

    if (!roomId) {
        send(player.ws, {
            type: "error",
            message: "أدخل رمز الغرفة"
        });
        return;
    }

    const room = rooms.get(roomId);

    if (!room) {
        send(player.ws, {
            type: "error",
            message: "الغرفة غير موجودة"
        });
        return;
    }

    if (room.players.length >= 2) {
        send(player.ws, {
            type: "error",
            message: "الغرفة ممتلئة"
        });
        return;
    }

    if (message.playerName || message.name) {
        player.name = String(
            message.playerName || message.name
        ).slice(0, 30);
    }

    room.players.push(player);
    player.roomId = room.id;

    send(player.ws, {
        type: "roomJoined",
        roomId: room.id,
        roomName: room.name,
        playerId: player.id
    });

    const owner = room.players[0];

    send(owner.ws, {
        type: "playerJoined",
        playerId: player.id,
        playerName: player.name
    });

    sendRoomInfo(room);
}

function handleReady(player) {
    const room = getRoom(player);

    if (!room) {
        send(player.ws, {
            type: "error",
            message: "لست داخل غرفة"
        });
        return;
    }

    player.ready = true;

    broadcastRoom(room, {
        type: "playerReady",
        playerId: player.id,
        playerName: player.name
    });

    sendRoomInfo(room);
}

function handleBattleReady(player, message) {
    const room = getRoom(player);

    if (!room) {
        send(player.ws, {
            type: "error",
            message: "لست داخل غرفة"
        });
        return;
    }

    if (room.players.length !== 2) {
        send(player.ws, {
            type: "error",
            message: "انتظر دخول لاعب آخر"
        });
        return;
    }

    player.grid = normalizeGrid(message.grid);
    player.shipCells = getShipCells(player.grid);
    player.attackedCells = new Set();
    player.battleReady = true;

    broadcastRoom(room, {
        type: "playerBattleReady",
        playerId: player.id
    });

    sendRoomInfo(room);

    if (
        room.players.length === 2 &&
        room.players.every(other => other.battleReady)
    ) {
        startBattle(room);
    }
}

function handleAttack(player, message) {
    const room = getRoom(player);

    if (!room || !room.started) {
        send(player.ws, {
            type: "error",
            message: "المعركة لم تبدأ بعد"
        });
        return;
    }

    if (room.currentPlayerId !== player.id) {
        send(player.ws, {
            type: "error",
            message: "ليس دورك"
        });
        return;
    }

    const opponent = getOpponent(room, player);

    if (!opponent) {
        send(player.ws, {
            type: "error",
            message: "لا يوجد خصم"
        });
        return;
    }

    const row = Number(message.row);
    const col = Number(message.col);

    if (
        !Number.isInteger(row) ||
        !Number.isInteger(col) ||
        row < 0 ||
        row >= BOARD_SIZE ||
        col < 0 ||
        col >= BOARD_SIZE
    ) {
        send(player.ws, {
            type: "error",
            message: "موقع الهجوم غير صحيح"
        });
        return;
    }

    const cell = row * BOARD_SIZE + col;

    if (player.attackedCells.has(cell)) {
        send(player.ws, {
            type: "error",
            message: "لقد هاجمت هذه الخانة من قبل"
        });
        return;
    }

    player.attackedCells.add(cell);

    const hit = opponent.shipCells.has(cell);

    if (hit) {
        opponent.grid[row][col] = "hit";
    } else {
        opponent.grid[row][col] = "miss";
    }

    const attackResult = {
        type: "attackResult",
        attackerId: player.id,
        row,
        col,
        hit,
        nextPlayerId: hit ? player.id : opponent.id
    };

    send(player.ws, attackResult);
    send(opponent.ws, attackResult);

    const allShipsDestroyed = [...opponent.shipCells].every(
        shipCell => player.attackedCells.has(shipCell)
    );

    if (opponent.shipCells.size > 0 && allShipsDestroyed) {
        room.started = false;
        room.winnerId = player.id;

        broadcastRoom(room, {
            type: "gameOver",
            winner: player.id,
            winnerId: player.id,
            loserId: opponent.id
        });

        return;
    }

    if (!hit) {
        room.currentPlayerId = opponent.id;
    }

    broadcastRoom(room, {
        type: "turnChanged",
        currentPlayerId: room.currentPlayerId
    });
}

function handleLeaveRoom(player) {
    const room = getRoom(player);

    if (!room) {
        player.roomId = null;
        return;
    }

    room.players = room.players.filter(
        other => other.id !== player.id
    );

    player.roomId = null;
    resetPlayerBattleData(player);

    if (room.players.length === 0) {
        rooms.delete(room.id);
        return;
    }

    const remainingPlayer = room.players[0];

    remainingPlayer.roomId = room.id;
    room.started = false;
    room.currentPlayerId = null;
    room.winnerId = null;

    resetPlayerBattleData(remainingPlayer);

    send(remainingPlayer.ws, {
        type: "opponentLeft",
        message: "غادر اللاعب الآخر الغرفة"
    });

    sendRoomInfo(room);
}

function handleMessage(player, message) {
    if (!message || typeof message !== "object") {
        return;
    }

    switch (message.type) {
        case "connect":
            handleConnect(player, message);
            break;

        case "join":
            handleConnect(player, message);
            break;

        case "setName":
            handleConnect(player, message);
            break;

        case "createRoom":
            handleCreateRoom(player, message);
            break;

        case "joinRoom":
            handleJoinRoom(player, message);
            break;

        case "ready":
            handleReady(player);
            break;

        case "battleReady":
            handleBattleReady(player, message);
            break;

        case "attack":
            handleAttack(player, message);
            break;

        case "leaveRoom":
            handleLeaveRoom(player);
            break;

        case "roomList":
            send(player.ws, {
                type: "roomList",
                rooms: [...rooms.values()]
                    .filter(room => room.players.length < 2)
                    .map(room => ({
                        roomId: room.id,
                        roomName: room.name,
                        players: room.players.length
                    }))
            });
            break;

        case "ping":
            send(player.ws, {
                type: "pong"
            });
            break;

        default:
            send(player.ws, {
                type: "error",
                message: "أمر غير معروف"
            });
    }
}

wss.on("connection", ws => {
    const player = createPlayer(ws);

    ws.player = player;
    connections.add(ws);

    send(ws, {
        type: "connected",
        playerId: player.id,
        playerName: player.name
    });

    ws.on("message", rawMessage => {
        try {
            const message = JSON.parse(
                rawMessage.toString()
            );

            handleMessage(player, message);
        } catch (error) {
            send(ws, {
                type: "error",
                message: "البيانات المرسلة غير صحيحة"
            });
        }
    });

    ws.on("close", () => {
        handleLeaveRoom(player);
        connections.delete(ws);
    });

    ws.on("error", () => {
        handleLeaveRoom(player);
        connections.delete(ws);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});

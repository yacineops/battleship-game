const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Battleship Server is running!");
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();
const connections = new Set();

let nextPlayerId = 1;

const BOARD_SIZE = 10;

const SHIP_TYPES = {
    1: { length: 1, value: 1 },
    2: { length: 2, value: 2 },
    3: { length: 3, value: 3 },
    4: { length: 4, value: 4 }
};

const SHIP_COUNTS = {
    1: 5,
    2: 3,
    3: 3,
    4: 2
};

function createPlayer(id, ws) {
    return {
        id,
        ws,

        name: "Player",

        cells: Array(100).fill(0),
        ships: [],

        hits: [],
        misses: [],

        bombs: 2,
        missiles: 1,

        score: 0
    };
}

function createRoomCode() {
    let code;

    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(code));

    return code;
}

function createRoom(player) {

    const code = createRoomCode();

    const room = {
        code,

        players: [player],

        setupStartTime: null,
        battleStarted: false,

        currentPlayer: null,

        turnTimer: null,
        turnEndTime: null
    };

    player.roomCode = code;

    rooms.set(code, room);

    return room;
}

function getRoom(player) {

    if (!player.roomCode) {
        return null;
    }

    return rooms.get(player.roomCode) || null;
}

function getOpponent(room, player) {

    return room.players.find(
        p => p.id !== player.id
    ) || null;
}

function send(player, data) {

    if (
        player &&
        player.ws &&
        player.ws.readyState === WebSocket.OPEN
    ) {
        player.ws.send(JSON.stringify(data));
    }
}

function broadcastRoom(room, data) {

    for (const player of room.players) {
        send(player, data);
    }
}

function broadcastOnlineCount() {

    const count = connections.size;

    for (const ws of connections) {

        if (ws.readyState === WebSocket.OPEN) {

            ws.send(JSON.stringify({
                type: "onlineCount",
                count
            }));
        }
    }
}

function resetPlayer(player) {

    player.cells.fill(0);
    player.ships = [];

    player.hits = [];
    player.misses = [];

    player.bombs = 2;
    player.missiles = 1;

    player.score = 0;
}

function randomEmptyPlacement(player, type) {

    const length = SHIP_TYPES[type].length;

    for (let attempt = 0; attempt < 1000; attempt++) {

        const horizontal = Math.random() < 0.5;

        const row = Math.floor(Math.random() * 10);
        const col = Math.floor(Math.random() * 10);

        const cells = [];

        for (let i = 0; i < length; i++) {

            const r = horizontal ? row : row + i;
            const c = horizontal ? col + i : col;

            if (r >= 10 || c >= 10) {
                break;
            }

            cells.push(r * 10 + c);
        }

        if (cells.length !== length) {
            continue;
        }

        if (cells.some(index => player.cells[index] !== 0)) {
            continue;
        }

        const ship = {
            id: player.ships.length + 1,
            type,
            length,
            value: SHIP_TYPES[type].value,
            orientation: horizontal
                ? "horizontal"
                : "vertical",
            cells,
            hits: []
        };

        player.ships.push(ship);

        cells.forEach(index => {
            player.cells[index] = type;
        });

        return true;
    }

    return false;
}

function randomCompletePlayer(player) {

    player.cells.fill(0);
    player.ships = [];

    for (const type of [1, 2, 3, 4]) {

        for (let i = 0; i < SHIP_COUNTS[type]; i++) {
            randomEmptyPlacement(player, type);
        }
    }
}

function allShipsPlaced(player) {

    let count = 0;

    for (const type of [1, 2, 3, 4]) {

        count += player.ships.filter(
            ship => ship.type === type
        ).length;
    }

    return count === 13;
}

function getNextShipType(player) {

    for (const type of [1, 2, 3, 4]) {

        const count = player.ships.filter(
            ship => ship.type === type
        ).length;

        if (count < SHIP_COUNTS[type]) {
            return type;
        }
    }

    return null;
}

/* =========================
   Public battle state
========================= */

function publicState(player, opponent, room) {

    const visibleOpponentShips = [];

    if (opponent) {

        for (const ship of opponent.ships) {

            if (ship.hits.length === ship.cells.length) {

                visibleOpponentShips.push({
                    cells: ship.cells,
                    type: ship.type,
                    sunk: true
                });
            }
        }
    }

    let timer = 0;

    if (room.turnEndTime) {

        timer = Math.max(
            0,
            Math.ceil(
                (room.turnEndTime - Date.now()) / 1000
            )
        );
    }

    return {

        myTurn: room.currentPlayer === player.id,

        timer,

        me: {
            cells: player.cells,
            ships: player.ships,
            hits: player.hits,
            misses: player.misses,
            bombs: player.bombs,
            missiles: player.missiles
        },

        opponent: {
            hits: opponent ? opponent.hits.slice() : [],
            misses: opponent ? opponent.misses.slice() : [],
            sunkShips: visibleOpponentShips
        }
    };
}

function broadcastBattleState(room) {

    if (room.players.length !== 2) {
        return;
    }

    const a = room.players[0];
    const b = room.players[1];

    send(a, {
        type: "battleState",
        state: publicState(a, b, room)
    });

    send(b, {
        type: "battleState",
        state: publicState(b, a, room)
    });
}

/* =========================
   Setup
========================= */

function startSetup(room) {

    room.setupStartTime = Date.now();
    room.battleStarted = false;
    room.currentPlayer = null;

    for (const player of room.players) {
        resetPlayer(player);
    }

    for (const player of room.players) {
        sendSetupState(player);
    }
}

function sendSetupState(player) {

    const room = getRoom(player);

    if (!room || !room.setupStartTime) {
        return;
    }

    const remaining = Math.max(
        0,
        60 - Math.floor(
            (Date.now() - room.setupStartTime) / 1000
        )
    );

    send(player, {
        type: "setupState",

        setup: {
            remainingSeconds: remaining,

            nextShipType: getNextShipType(player),

            occupied: player.ships.flatMap(
                ship => ship.cells
            ),

            cells: player.cells
        }
    });
}

function checkSetupFinished(room) {

    if (!room || room.players.length !== 2) {
        return;
    }

    if (room.players.every(allShipsPlaced)) {
        beginBattle(room);
    }
}

function beginBattle(room) {

    if (room.battleStarted) {
        return;
    }

    for (const player of room.players) {

        if (!allShipsPlaced(player)) {
            randomCompletePlayer(player);
        }
    }

    room.battleStarted = true;

    room.currentPlayer =
        room.players[
            Math.floor(
                Math.random() * room.players.length
            )
        ].id;

    startTurnTimer(room);

    broadcastBattleState(room);
}

/* =========================
   Placement
========================= */

function placeShip(player, type, cells) {

    const room = getRoom(player);

    if (!room || room.battleStarted) {
        return;
    }

    if (!SHIP_TYPES[type]) {
        return;
    }

    if (cells.length !== SHIP_TYPES[type].length) {
        return;
    }

    if (cells.some(
        index =>
            index < 0 ||
            index >= 100 ||
            player.cells[index] !== 0
    )) {
        return;
    }

    const sorted = [...cells].sort(
        (a, b) => a - b
    );

    const rows = sorted.map(
        i => Math.floor(i / 10)
    );

    const cols = sorted.map(
        i => i % 10
    );

    const sameRow = rows.every(
        row => row === rows[0]
    );

    const sameCol = cols.every(
        col => col === cols[0]
    );

    let orientation = null;

    if (sameRow) {

        for (let i = 1; i < cols.length; i++) {

            if (
                cols[i] !==
                cols[i - 1] + 1
            ) {
                return;
            }
        }

        orientation = "horizontal";

    } else if (sameCol) {

        for (let i = 1; i < rows.length; i++) {

            if (
                rows[i] !==
                rows[i - 1] + 1
            ) {
                return;
            }
        }

        orientation = "vertical";

    } else {
        return;
    }

    const existingCount =
        player.ships.filter(
            ship => ship.type === type
        ).length;

    if (existingCount >= SHIP_COUNTS[type]) {
        return;
    }

    const ship = {
        id: player.ships.length + 1,
        type,
        length: SHIP_TYPES[type].length,
        value: SHIP_TYPES[type].value,
        orientation,
        cells: sorted,
        hits: []
    };

    player.ships.push(ship);

    sorted.forEach(index => {
        player.cells[index] = type;
    });

    sendSetupState(player);

    checkSetupFinished(room);
}

/* =========================
   Attack
========================= */

function getAttackCells(target, weapon, direction) {

    if (
        target < 0 ||
        target >= 100
    ) {
        return [];
    }

    if (weapon === "normal") {
        return [target];
    }

    const row = Math.floor(target / 10);
    const col = target % 10;

    if (weapon === "bomb") {

        const cells = [];

        for (
            let r = row - 1;
            r <= row + 1;
            r++
        ) {

            for (
                let c = col - 1;
                c <= col + 1;
                c++
            ) {

                if (
                    r >= 0 &&
                    r < 10 &&
                    c >= 0 &&
                    c < 10
                ) {
                    cells.push(r * 10 + c);
                }
            }
        }

        return cells;
    }

    if (weapon === "missile") {

        const cells = [];

        if (direction === "row") {

            for (let c = 0; c < 10; c++) {
                cells.push(row * 10 + c);
            }

        } else if (direction === "column") {

            for (let r = 0; r < 10; r++) {
                cells.push(r * 10 + col);
            }
        }

        return cells;
    }

    return [];
}

function attack(
    attacker,
    target,
    weapon,
    direction
) {

    const room = getRoom(attacker);

    if (!room || !room.battleStarted) {
        return;
    }

    if (room.currentPlayer !== attacker.id) {
        return;
    }

    const defender = getOpponent(
        room,
        attacker
    );

    if (!defender) {
        return;
    }

    if (
        target < 0 ||
        target >= 100
    ) {
        return;
    }

    if (
        weapon !== "normal" &&
        weapon !== "bomb" &&
        weapon !== "missile"
    ) {
        return;
    }

    if (weapon === "bomb") {

        if (attacker.bombs <= 0) {

            send(attacker, {
                type: "error",
                message: "No bombs available."
            });

            return;
        }

        attacker.bombs--;
    }

    if (weapon === "missile") {

        if (attacker.missiles <= 0) {

            send(attacker, {
                type: "error",
                message: "No missiles available."
            });

            return;
        }

        if (
            direction !== "row" &&
            direction !== "column"
        ) {
            attacker.missiles++;
            return;
        }

        attacker.missiles--;
    }

    const cells = getAttackCells(
        target,
        weapon,
        direction
    );

    if (cells.length === 0) {
        return;
    }

    let hit = false;
    let sunk = false;

    for (const index of cells) {

        if (defender.hits.includes(index)) {
            continue;
        }

        const ship = defender.ships.find(
            s => s.cells.includes(index)
        );

        if (!ship) {

            if (
                !defender.misses.includes(index)
            ) {
                defender.misses.push(index);
            }

            continue;
        }

        hit = true;

        if (!ship.hits.includes(index)) {
            ship.hits.push(index);
        }

        if (
            ship.hits.length ===
            ship.cells.length
        ) {

            sunk = true;

            attacker.score += ship.value;

            if (ship.type === 3) {
                attacker.bombs++;
            }

            if (ship.type === 4) {
                attacker.missiles++;
            }
        }

        if (!defender.hits.includes(index)) {
            defender.hits.push(index);
        }
    }

    clearTurnTimer(room);

    let result = "miss";

    if (sunk) {
        result = "sunk";
    } else if (hit) {
        result = "hit";
    }

    send(attacker, {
        type: "attackResult",

        result,

        state: publicState(
            attacker,
            defender,
            room
        )
    });

    send(defender, {
        type: "attackResult",

        result,

        state: publicState(
            defender,
            attacker,
            room
        )
    });

    const defenderLost =
        defender.ships.length > 0 &&
        defender.ships.every(
            ship =>
                ship.hits.length ===
                ship.cells.length
        );

    if (defenderLost) {

        send(attacker, {
            type: "gameOver",
            winner: attacker.id,
            myScore: attacker.score,
            opponentScore: defender.score
        });

        send(defender, {
            type: "gameOver",
            winner: attacker.id,
            myScore: defender.score,
            opponentScore: attacker.score
        });

        room.battleStarted = false;
        room.currentPlayer = null;

        return;
    }

    room.currentPlayer = defender.id;

    startTurnTimer(room);

    broadcastBattleState(room);
}

/* =========================
   Movement
========================= */

function moveShip(
    player,
    shipId,
    direction
) {

    const room = getRoom(player);

    if (!room || !room.battleStarted) {
        return;
    }

    if (room.currentPlayer !== player.id) {
        return;
    }

    const ship = player.ships.find(
        s => s.id === shipId
    );

    if (!ship) {
        return;
    }

    if (
        ship.hits.length ===
        ship.cells.length
    ) {
        return;
    }

    if (
        ship.orientation === "horizontal" &&
        direction !== "left" &&
        direction !== "right"
    ) {
        return;
    }

    if (
        ship.orientation === "vertical" &&
        direction !== "up" &&
        direction !== "down"
    ) {
        return;
    }

    let dr = 0;
    let dc = 0;

    if (direction === "left") dc = -1;
    if (direction === "right") dc = 1;
    if (direction === "up") dr = -1;
    if (direction === "down") dr = 1;

    const newCells = ship.cells.map(
        index => {

            const row = Math.floor(
                index / 10
            );

            const col = index % 10;

            return (
                (row + dr) * 10 +
                (col + dc)
            );
        }
    );

    if (newCells.some(index => {

        if (
            index < 0 ||
            index >= 100
        ) {
            return true;
        }

        const oldShipCell =
            ship.cells.includes(index);

        return (
            !oldShipCell &&
            player.cells[index] !== 0
        );

    })) {
        return;
    }

    ship.cells.forEach(index => {
        player.cells[index] = 0;
    });

    ship.cells = newCells;

    ship.cells.forEach(index => {
        player.cells[index] = ship.type;
    });

    clearTurnTimer(room);

    const opponent = getOpponent(
        room,
        player
    );

    if (opponent) {
        room.currentPlayer = opponent.id;
    }

    startTurnTimer(room);

    broadcastBattleState(room);
}

/* =========================
   Turn timer
========================= */

function clearTurnTimer(room) {

    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
    }

    room.turnEndTime = null;
}

function startTurnTimer(room) {

    clearTurnTimer(room);

    if (
        !room.battleStarted ||
        room.players.length !== 2
    ) {
        return;
    }

    room.turnEndTime =
        Date.now() + 15000;

    room.turnTimer = setTimeout(() => {

        if (!room.battleStarted) {
            return;
        }

        const current =
            room.players.find(
                p => p.id === room.currentPlayer
            );

        if (!current) {
            return;
        }

        const opponent =
            getOpponent(room, current);

        if (!opponent) {
            return;
        }

        room.currentPlayer =
            opponent.id;

        startTurnTimer(room);

        broadcastBattleState(room);

    }, 15000);
}

/* =========================
   Room leaving
========================= */

function leaveRoom(player) {

    const room = getRoom(player);

    if (!room) {
        return;
    }

    clearTurnTimer(room);

    room.players =
        room.players.filter(
            p => p.id !== player.id
        );

    player.roomCode = null;

    if (room.players.length > 0) {

        const remaining =
            room.players[0];

        send(remaining, {
            type: "roomClosed",
            message: "The other player left the room."
        });

        remaining.roomCode = null;
    }

    rooms.delete(room.code);
}

/* =========================
   WebSocket
========================= */

wss.on("connection", ws => {

    connections.add(ws);

    const player =
        createPlayer(
            nextPlayerId++,
            ws
        );

    ws.player = player;

    broadcastOnlineCount();

    ws.on("message", raw => {

        let message;

        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }

        /* =====================
           Online count
        ===================== */

        if (message.type === "getOnlineCount") {

            send(player, {
                type: "onlineCount",
                count: connections.size
            });

            return;
        }

        /* =====================
           Create room
        ===================== */

        if (message.type === "createRoom") {

            if (getRoom(player)) {

                send(player, {
                    type: "error",
                    message: "You are already in a room."
                });

                return;
            }

            if (message.name) {
                player.name =
                    String(message.name)
                        .slice(0, 20);
            }

            const room =
                createRoom(player);

            send(player, {
                type: "roomCreated",

                roomCode: room.code,

                playerId: player.id,

                waiting: true
            });

            return;
        }

        /* =====================
           Join room
        ===================== */

        if (message.type === "joinRoom") {

            if (getRoom(player)) {

                send(player, {
                    type: "error",
                    message: "You are already in a room."
                });

                return;
            }

            const code =
                String(
                    message.roomCode || ""
                ).trim();

            const room =
                rooms.get(code);

            if (!room) {

                send(player, {
                    type: "error",
                    message: "Room not found."
                });

                return;
            }

            if (room.players.length >= 2) {

                send(player, {
                    type: "error",
                    message: "Room is full."
                });

                return;
            }

            if (message.name) {
                player.name =
                    String(message.name)
                        .slice(0, 20);
            }

            room.players.push(player);

            player.roomCode = room.code;

            send(player, {
                type: "roomJoined",

                roomCode: room.code,

                playerId: player.id,

                waiting: false
            });

            const host =
                room.players[0];

            send(host, {
                type: "opponentJoined",
                opponentName: player.name
            });

            startSetup(room);

            return;
        }

        /* =====================
           Leave room
        ===================== */

        if (message.type === "leaveRoom") {

            leaveRoom(player);

            send(player, {
                type: "leftRoom"
            });

            return;
        }

        /* =====================
           Join online mode
        ===================== */

        if (message.type === "join") {

            send(player, {
                type: "joined",
                playerId: player.id
            });

            return;
        }

        /* =====================
           Set player name
        ===================== */

        if (message.type === "setName") {

            player.name =
                String(
                    message.name || "Player"
                ).slice(0, 20);

            send(player, {
                type: "nameChanged",
                name: player.name
            });

            return;
        }

        /* =====================
           Placement
        ===================== */

        if (message.type === "placeShip") {

            placeShip(
                player,
                Number(message.shipType),
                Array.isArray(message.cells)
                    ? message.cells.map(Number)
                    : []
            );

            return;
        }

        /* =====================
           Attack
        ===================== */

        if (message.type === "attack") {

            attack(
                player,
                Number(message.target),
                message.weapon,
                message.direction
            );

            return;
        }

        /* =====================
           Movement
        ===================== */

        if (message.type === "move") {

            moveShip(
                player,
                Number(message.shipId),
                message.direction
            );

            return;
        }
    });

    ws.on("close", () => {

        connections.delete(ws);

        leaveRoom(player);

        broadcastOnlineCount();
    });
});

/* =========================
   Setup timeout
========================= */

setInterval(() => {

    for (const room of rooms.values()) {

        if (
            room.battleStarted ||
            room.players.length !== 2 ||
            !room.setupStartTime
        ) {
            continue;
        }

        const elapsed =
            Math.floor(
                (Date.now() -
                    room.setupStartTime) /
                1000
            );

        for (const player of room.players) {
            sendSetupState(player);
        }

        if (elapsed >= 60) {

            for (const player of room.players) {

                if (!allShipsPlaced(player)) {
                    randomCompletePlayer(player);
                }
            }

            beginBattle(room);
        }
    }

}, 1000);

server.listen(PORT, () => {

    console.log(
        `Battleship server running on port ${PORT}`
    );
});

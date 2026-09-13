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

let nextPlayerId = 1;

const BOARD_SIZE = 10;
const SETUP_TIME = 60;

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

/* =========================
   Utility
========================= */

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
    for (const player of room.players.values()) {
        send(player, data);
    }
}

function createRoomCode() {
    let code;

    do {
        code = Math.random()
            .toString(36)
            .substring(2, 7)
            .toUpperCase();
    } while (rooms.has(code));

    return code;
}

function emptyPlayer(id, ws) {
    return {
        id,
        ws,

        cells: Array(100).fill(0),

        ships: [],

        hits: [],
        misses: [],

        bombs: 2,
        missiles: 1,

        score: 0,

        ready: false
    };
}

function getOpponent(room, player) {
    for (const p of room.players.values()) {
        if (p.id !== player.id) {
            return p;
        }
    }

    return null;
}

/* =========================
   Room state
========================= */

function createRoom() {
    const code = createRoomCode();

    const room = {
        code,

        players: new Map(),

        setupStartTime: null,

        battleStarted: false,

        currentPlayer: null,

        turnMode: null,

        turnTimer: null
    };

    rooms.set(code, room);

    return room;
}

function deleteRoom(room) {
    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
    }

    rooms.delete(room.code);
}

function roomState(room) {
    return {
        roomCode: room.code,
        players: room.players.size,
        maxPlayers: 2,
        battleStarted: room.battleStarted
    };
}

function sendRoomState(room) {
    for (const player of room.players.values()) {
        send(player, {
            type: "roomState",
            room: roomState(room)
        });
    }
}

/* =========================
   Hidden battle state
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

    return {
        myTurn: room.currentPlayer === player.id,

        turnMode: room.turnMode,

        timer: getTurnSeconds(room),

        me: {
            cells: player.cells,
            ships: player.ships,
            hits: player.hits,
            misses: player.misses,
            bombs: player.bombs,
            missiles: player.missiles,
            shipAt: player.cells
        },

        opponent: {
            hits: opponent ? opponent.hits.slice() : [],
            misses: opponent ? opponent.misses.slice() : [],
            sunkShips: visibleOpponentShips
        }
    };
}

function getTurnSeconds(room) {
    if (!room.turnEndTime) {
        return 0;
    }

    return Math.max(
        0,
        Math.ceil((room.turnEndTime - Date.now()) / 1000)
    );
}

function broadcastBattleState(room) {

    const list = [...room.players.values()];

    if (list.length !== 2) {
        return;
    }

    const a = list[0];
    const b = list[1];

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

function resetPlayer(player) {

    player.cells.fill(0);

    player.ships = [];

    player.hits = [];
    player.misses = [];

    player.bombs = 2;
    player.missiles = 1;

    player.score = 0;

    player.ready = false;
}

function startSetup(room) {

    room.setupStartTime = Date.now();

    room.battleStarted = false;

    room.currentPlayer = null;

    room.turnMode = null;

    for (const player of room.players.values()) {
        resetPlayer(player);
    }

    for (const player of room.players.values()) {
        sendSetupState(room, player);
    }
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

function allShipsPlaced(player) {

    let count = 0;

    for (const type of [1, 2, 3, 4]) {
        count += player.ships.filter(
            ship => ship.type === type
        ).length;
    }

    return count === 13;
}

function sendSetupState(room, player) {

    if (!room.setupStartTime) {
        return;
    }

    const remaining = Math.max(
        0,
        SETUP_TIME -
        Math.floor(
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

    if (room.players.size !== 2) {
        return;
    }

    const players = [...room.players.values()];

    if (players.every(allShipsPlaced)) {
        beginBattle(room);
    }
}

function beginBattle(room) {

    if (room.battleStarted) {
        return;
    }

    for (const player of room.players.values()) {

        if (!allShipsPlaced(player)) {
            randomCompletePlayer(player);
        }
    }

    room.battleStarted = true;

    const list = [...room.players.values()];

    const first =
        list[Math.floor(Math.random() * list.length)];

    room.currentPlayer = first.id;

    startTurn(room);

    broadcastBattleState(room);
}

/* =========================
   Random placement
========================= */

function randomEmptyPlacement(player, type) {

    const length = SHIP_TYPES[type].length;

    for (let attempt = 0; attempt < 1000; attempt++) {

        const horizontal = Math.random() < 0.5;

        const row = Math.floor(Math.random() * 10);
        const col = Math.floor(Math.random() * 10);

        const cells = [];

        for (let i = 0; i < length; i++) {

            const r = horizontal
                ? row
                : row + i;

            const c = horizontal
                ? col + i
                : col;

            if (r >= 10 || c >= 10) {
                break;
            }

            cells.push(r * 10 + c);
        }

        if (cells.length !== length) {
            continue;
        }

        if (
            cells.some(
                index => player.cells[index] !== 0
            )
        ) {
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

        for (
            let i = 0;
            i < SHIP_COUNTS[type];
            i++
        ) {
            randomEmptyPlacement(player, type);
        }
    }
}

/* =========================
   Placement
========================= */

function placeShip(room, player, type, cells) {

    if (room.battleStarted) {
        return;
    }

    if (!SHIP_TYPES[type]) {
        return;
    }

    if (
        cells.length !==
        SHIP_TYPES[type].length
    ) {
        return;
    }

    if (
        cells.some(
            index =>
                index < 0 ||
                index >= 100 ||
                player.cells[index] !== 0
        )
    ) {
        return;
    }

    const sorted =
        [...cells].sort((a, b) => a - b);

    const rows =
        sorted.map(
            i => Math.floor(i / 10)
        );

    const cols =
        sorted.map(
            i => i % 10
        );

    const sameRow =
        rows.every(
            row => row === rows[0]
        );

    const sameCol =
        cols.every(
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

    if (
        existingCount >=
        SHIP_COUNTS[type]
    ) {
        return;
    }

    const ship = {

        id: player.ships.length + 1,

        type,

        length:
            SHIP_TYPES[type].length,

        value:
            SHIP_TYPES[type].value,

        orientation,

        cells: sorted,

        hits: []
    };

    player.ships.push(ship);

    sorted.forEach(index => {
        player.cells[index] = type;
    });

    sendSetupState(room, player);

    checkSetupFinished(room);
}

/* =========================
   Turn system
========================= */

function startTurn(room) {

    if (!room.battleStarted) {
        return;
    }

    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
    }

    room.turnMode = null;

    room.turnEndTime = null;

    broadcastBattleState(room);
}

function chooseTurnMode(room, player, mode) {

    if (!room.battleStarted) {
        return;
    }

    if (room.currentPlayer !== player.id) {
        return;
    }

    if (
        mode !== "move" &&
        mode !== "attack"
    ) {
        return;
    }

    if (room.turnMode) {
        return;
    }

    room.turnMode = mode;

    const seconds =
        mode === "move" ? 10 : 15;

    room.turnEndTime =
        Date.now() + seconds * 1000;

    room.turnTimer = setTimeout(() => {

        if (!room.battleStarted) {
            return;
        }

        if (room.turnMode !== mode) {
            return;
        }

        endTurn(room);

    }, seconds * 1000);

    broadcastBattleState(room);
}

function endTurn(room) {

    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
    }

    const list = [...room.players.values()];

    if (list.length !== 2) {
        return;
    }

    const current =
        list.find(
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

    room.currentPlayer = opponent.id;

    room.turnMode = null;

    room.turnEndTime = null;

    broadcastBattleState(room);
}

/* =========================
   Attack
========================= */

function getAttackCells(
    target,
    weapon,
    direction
) {

    if (
        target < 0 ||
        target >= 100
    ) {
        return [];
    }

    if (weapon === "normal") {
        return [target];
    }

    const row =
        Math.floor(target / 10);

    const col =
        target % 10;

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
                    cells.push(
                        r * 10 + c
                    );
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
    room,
    attacker,
    target,
    weapon,
    direction
) {

    if (!room.battleStarted) {
        return;
    }

    if (room.currentPlayer !== attacker.id) {
        return;
    }

    if (room.turnMode !== "attack") {
        return;
    }

    const defender =
        getOpponent(room, attacker);

    if (!defender) {
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
            return;
        }

        attacker.missiles--;
    }

    const cells =
        getAttackCells(
            target,
            weapon,
            direction
        );

    if (!cells.length) {
        return;
    }

    let hit = false;
    let sunk = false;

    for (const index of cells) {

        if (
            defender.hits.includes(index)
        ) {
            continue;
        }

        const ship =
            defender.ships.find(
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

        if (
            !ship.hits.includes(index)
        ) {
            ship.hits.push(index);
        }

        if (
            ship.hits.length ===
            ship.cells.length
        ) {

            sunk = true;

            attacker.score +=
                ship.value;

            if (ship.type === 3) {
                attacker.bombs++;
            }

            if (ship.type === 4) {
                attacker.missiles++;
            }
        }

        if (
            !defender.hits.includes(index)
        ) {
            defender.hits.push(index);
        }
    }

    let result = "miss";

    if (sunk) {
        result = "sunk";
    } else if (hit) {
        result = "hit";
    }

    send(attacker, {
        type: "attackResult",

        result,

        state:
            publicState(
                attacker,
                defender,
                room
            )
    });

    send(defender, {
        type: "attackResult",

        result,

        state:
            publicState(
                defender,
                attacker,
                room
            )
    });

    const defenderLost =
        defender.ships.every(
            ship =>
                ship.hits.length ===
                ship.cells.length
        );

    if (defenderLost) {

        room.battleStarted = false;

        if (room.turnTimer) {
            clearTimeout(room.turnTimer);
            room.turnTimer = null;
        }

        send(attacker, {
            type: "gameOver",

            winner: attacker.id,

            myScore: attacker.score,

            opponentScore:
                defender.score
        });

        send(defender, {
            type: "gameOver",

            winner: attacker.id,

            myScore: defender.score,

            opponentScore:
                attacker.score
        });

        return;
    }

    endTurn(room);
}

/* =========================
   Movement
========================= */

function moveShip(
    room,
    player,
    shipId,
    direction
) {

    if (!room.battleStarted) {
        return;
    }

    if (
        room.currentPlayer !==
        player.id
    ) {
        return;
    }

    if (room.turnMode !== "move") {
        return;
    }

    const ship =
        player.ships.find(
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

    if (direction === "left") {
        dc = -1;
    }

    if (direction === "right") {
        dc = 1;
    }

    if (direction === "up") {
        dr = -1;
    }

    if (direction === "down") {
        dr = 1;
    }

    const newCells =
        ship.cells.map(index => {

            const row =
                Math.floor(index / 10);

            const col =
                index % 10;

            return (
                (row + dr) * 10 +
                (col + dc)
            );
        });

    if (
        newCells.some(index => {

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
        })
    ) {
        return;
    }

    ship.cells.forEach(index => {
        player.cells[index] = 0;
    });

    ship.cells = newCells;

    ship.cells.forEach(index => {
        player.cells[index] =
            ship.type;
    });

    endTurn(room);
}

/* =========================
   WebSocket
========================= */

wss.on("connection", ws => {

    let player = null;
    let room = null;

    ws.on("message", raw => {

        let message;

        try {
            message =
                JSON.parse(raw);
        } catch {
            return;
        }

        /* Create room */

        if (
            message.type === "createRoom"
        ) {

            if (player) {
                return;
            }

            room = createRoom();

            player =
                emptyPlayer(
                    nextPlayerId++,
                    ws
                );

            room.players.set(
                player.id,
                player
            );

            send(player, {
                type: "roomCreated",

                roomCode: room.code,

                playerId: player.id,

                players: 1,

                maxPlayers: 2
            });

            sendRoomState(room);

            return;
        }

        /* Join room */

        if (
            message.type === "joinRoom"
        ) {

            if (player) {
                return;
            }

            const code =
                String(
                    message.roomCode || ""
                )
                .trim()
                .toUpperCase();

            const foundRoom =
                rooms.get(code);

            if (!foundRoom) {

                send(ws, {
                    type: "error",
                    message:
                        "Room not found."
                });

                return;
            }

            if (
                foundRoom.players.size >= 2
            ) {

                send(ws, {
                    type: "error",
                    message:
                        "Room is full."
                });

                return;
            }

            room = foundRoom;

            player =
                emptyPlayer(
                    nextPlayerId++,
                    ws
                );

            room.players.set(
                player.id,
                player
            );

            send(player, {
                type: "roomJoined",

                roomCode: room.code,

                playerId: player.id,

                players:
                    room.players.size,

                maxPlayers: 2
            });

            sendRoomState(room);

            if (
                room.players.size === 2
            ) {
                startSetup(room);
            }

            return;
        }

        /* Old join command */

        if (
            message.type === "join"
        ) {

            send(ws, {
                type: "error",

                message:
                    "Use Create Room or Join Room."
            });

            return;
        }

        if (!player || !room) {
            return;
        }

        /* Placement */

        if (
            message.type === "placeShip"
        ) {

            placeShip(
                room,
                player,
                Number(
                    message.shipType
                ),
                Array.isArray(
                    message.cells
                )
                    ? message.cells.map(Number)
                    : []
            );

            return;
        }

        /* Choose move or attack */

        if (
            message.type ===
            "chooseTurnMode"
        ) {

            chooseTurnMode(
                room,
                player,
                message.mode
            );

            return;
        }

        /* Attack */

        if (
            message.type === "attack"
        ) {

            attack(
                room,
                player,
                Number(
                    message.target
                ),
                message.weapon,
                message.direction
            );

            return;
        }

        /* Move */

        if (
            message.type === "move"
        ) {

            moveShip(
                room,
                player,
                Number(
                    message.shipId
                ),
                message.direction
            );
        }
    });

    ws.on("close", () => {

        if (!player || !room) {
            return;
        }

        room.players.delete(
            player.id
        );

        const remaining =
            [...room.players.values()][0];

        if (remaining) {

            send(remaining, {
                type: "playerLeft",

                message:
                    "The other player left the room."
            });
        }

        deleteRoom(room);
    });
});

/* =========================
   Setup timer
========================= */

setInterval(() => {

    for (const room of rooms.values()) {

        if (
            !room.setupStartTime ||
            room.battleStarted ||
            room.players.size !== 2
        ) {
            continue;
        }

        const elapsed =
            Math.floor(
                (
                    Date.now() -
                    room.setupStartTime
                ) / 1000
            );

        for (
            const player of
            room.players.values()
        ) {
            sendSetupState(
                room,
                player
            );
        }

        if (elapsed >= SETUP_TIME) {

            for (
                const player of
                room.players.values()
            ) {

                if (
                    !allShipsPlaced(player)
                ) {
                    randomCompletePlayer(
                        player
                    );
                }
            }

            beginBattle(room);
        }
    }

}, 1000);

/* =========================
   Server
========================= */

server.listen(PORT, () => {

    console.log(
        `Battleship server running on port ${PORT}`
    );
});

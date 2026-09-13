const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const BOARD_SIZE = 10;

const server = http.createServer((req, res) => {

    if (
        req.url === "/" ||
        req.url === "/index.html"
    ) {

        const filePath =
            path.join(__dirname, "index.html");

        fs.readFile(
            filePath,
            (err, data) => {

                if (err) {

                    console.error(
                        "Error loading index.html:",
                        err
                    );

                    res.writeHead(
                        500,
                        {
                            "Content-Type":
                                "text/plain; charset=utf-8"
                        }
                    );

                    res.end(
                        "خطأ في تحميل اللعبة"
                    );

                    return;
                }

                res.writeHead(
                    200,
                    {
                        "Content-Type":
                            "text/html; charset=utf-8"
                    }
                );

                res.end(data);
            }
        );

        return;
    }

    res.writeHead(
        404,
        {
            "Content-Type":
                "text/plain; charset=utf-8"
        }
    );

    res.end("Not Found");
});


const wss =
    new WebSocket.Server({
        server
    });


const rooms = new Map();

const matchmakingQueue = [];

let nextPlayerId = 1;
let nextRoomId = 1;


/* =========================
   HELPERS
========================= */

function send(ws, data) {

    if (
        !ws ||
        ws.readyState !== WebSocket.OPEN
    ) {
        return;
    }

    ws.send(
        JSON.stringify(data)
    );
}


function createEmptyGrid() {

    return Array.from(
        {
            length: BOARD_SIZE
        },
        () =>
            Array(BOARD_SIZE).fill("")
    );
}


function createPlayer(
    ws,
    name = "لاعب"
) {

    return {

        id: String(nextPlayerId++),

        name:
            String(
                name || "لاعب"
            ).slice(0, 30),

        ws,

        roomId: null,

        ready: false,

        battleReady: false,

        grid:
            createEmptyGrid(),

        shipCells:
            new Set(),

        attackedCells:
            new Set()
    };
}


function createRoomCode() {

    let code;

    do {

        code =
            String(
                nextRoomId++
            ).padStart(4, "0");

    } while (
        rooms.has(code)
    );

    return code;
}


function createRoom(
    roomName,
    owner
) {

    const room = {

        id:
            createRoomCode(),

        name:
            String(
                roomName ||
                "غرفة"
            ).slice(0, 40),

        players:
            [owner],

        started: false,

        currentPlayerId: null,

        winnerId: null,

        onlineMatch: false
    };


    rooms.set(
        room.id,
        room
    );


    owner.roomId =
        room.id;


    return room;
}


function getRoom(player) {

    if (
        !player ||
        !player.roomId
    ) {
        return null;
    }

    return (
        rooms.get(
            player.roomId
        ) || null
    );
}


function getOpponent(
    room,
    player
) {

    if (!room) {
        return null;
    }

    return room.players.find(
        other =>
            other.id !== player.id
    ) || null;
}


function isPlayerConnected(
    player
) {

    return !!(
        player &&
        player.ws &&
        player.ws.readyState ===
            WebSocket.OPEN
    );
}


function broadcastRoom(
    room,
    data
) {

    if (!room) {
        return;
    }

    room.players.forEach(
        player => {
            send(
                player.ws,
                data
            );
        }
    );
}


function sendRoomInfo(room) {

    if (!room) {
        return;
    }

    room.players.forEach(
        player => {

            send(
                player.ws,
                {
                    type: "roomInfo",

                    roomId:
                        room.id,

                    roomName:
                        room.name,

                    players:
                        room.players.map(
                            other => ({
                                id:
                                    other.id,

                                name:
                                    other.name,

                                ready:
                                    other.ready,

                                battleReady:
                                    other.battleReady
                            })
                        )
                }
            );

        }
    );
}


/* =========================
   MATCHMAKING
========================= */

function removeFromMatchmaking(
    player
) {

    let index;

    while (
        (
            index =
                matchmakingQueue.indexOf(
                    player
                )
        ) !== -1
    ) {

        matchmakingQueue.splice(
            index,
            1
        );
    }
}


function findMatch(player) {

    removeFromMatchmaking(player);


    if (player.roomId) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "أنت داخل غرفة بالفعل"
            }
        );

        return;
    }


    matchmakingQueue.push(player);


    send(
        player.ws,
        {
            type: "searching",
            message:
                "جاري البحث عن لاعب..."
        }
    );


    tryMatchPlayers();
}


function tryMatchPlayers() {

    while (
        matchmakingQueue.length >= 2
    ) {

        const player1 =
            matchmakingQueue.shift();

        const player2 =
            matchmakingQueue.shift();


        if (
            !isPlayerConnected(player1) ||
            !isPlayerConnected(player2)
        ) {
            continue;
        }


        if (
            player1.roomId ||
            player2.roomId
        ) {
            continue;
        }


        const room =
            createRoom(
                "مباراة أونلاين",
                player1
            );


        room.players.push(player2);

        player2.roomId =
            room.id;

        room.onlineMatch =
            true;


        send(
            player1.ws,
            {
                type: "matchFound",

                roomId:
                    room.id,

                opponentId:
                    player2.id,

                opponentName:
                    player2.name
            }
        );


        send(
            player2.ws,
            {
                type: "matchFound",

                roomId:
                    room.id,

                opponentId:
                    player1.id,

                opponentName:
                    player1.name
            }
        );


        sendRoomInfo(room);
    }
}


/* =========================
   GRID
========================= */

function normalizeGrid(grid) {

    const result =
        createEmptyGrid();


    if (
        !Array.isArray(grid)
    ) {
        return result;
    }


    for (
        let row = 0;
        row < BOARD_SIZE;
        row++
    ) {

        if (
            !Array.isArray(
                grid[row]
            )
        ) {
            continue;
        }


        for (
            let col = 0;
            col < BOARD_SIZE;
            col++
        ) {

            const value =
                grid[row][col];


            if (
                value === "ship" ||
                value === "hit" ||
                value === "miss"
            ) {

                result[row][col] =
                    value;

            }

        }
    }


    return result;
}


function getShipCells(grid) {

    const cells =
        new Set();


    for (
        let row = 0;
        row < BOARD_SIZE;
        row++
    ) {

        for (
            let col = 0;
            col < BOARD_SIZE;
            col++
        ) {

            if (
                grid[row][col] ===
                "ship"
            ) {

                cells.add(
                    row *
                        BOARD_SIZE +
                        col
                );
            }
        }
    }


    return cells;
}


function resetPlayerBattleData(
    player
) {

    player.ready = false;

    player.battleReady = false;

    player.grid =
        createEmptyGrid();

    player.shipCells =
        new Set();

    player.attackedCells =
        new Set();
}


/* =========================
   CONNECT
========================= */

function handleConnect(
    player,
    message
) {

    if (
        message.playerName ||
        message.name
    ) {

        player.name =
            String(
                message.playerName ||
                message.name
            ).slice(0, 30);
    }


    send(
        player.ws,
        {
            type: "connected",

            playerId:
                player.id,

            playerName:
                player.name
        }
    );
}


/* =========================
   CREATE ROOM
========================= */

function handleCreateRoom(
    player,
    message
) {

    removeFromMatchmaking(player);


    if (player.roomId) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "أنت داخل غرفة بالفعل"
            }
        );

        return;
    }


    if (
        message.playerName ||
        message.name
    ) {

        player.name =
            String(
                message.playerName ||
                message.name
            ).slice(0, 30);
    }


    const room =
        createRoom(
            message.roomName ||
                "غرفة جديدة",
            player
        );


    send(
        player.ws,
        {
            type: "roomCreated",

            roomId:
                room.id,

            roomName:
                room.name,

            playerId:
                player.id
        }
    );


    sendRoomInfo(room);
}


/* =========================
   JOIN ROOM
========================= */

function handleJoinRoom(
    player,
    message
) {

    removeFromMatchmaking(player);


    if (player.roomId) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "أنت داخل غرفة بالفعل"
            }
        );

        return;
    }


    const roomId =
        String(
            message.roomId ||
            message.roomCode ||
            ""
        ).trim();


    if (!roomId) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "أدخل رمز الغرفة"
            }
        );

        return;
    }


    const room =
        rooms.get(roomId);


    if (!room) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "الغرفة غير موجودة"
            }
        );

        return;
    }


    if (
        room.players.length >= 2
    ) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "الغرفة ممتلئة"
            }
        );

        return;
    }


    if (
        message.playerName ||
        message.name
    ) {

        player.name =
            String(
                message.playerName ||
                message.name
            ).slice(0, 30);
    }


    room.players.push(player);

    player.roomId =
        room.id;


    send(
        player.ws,
        {
            type: "roomJoined",

            roomId:
                room.id,

            roomName:
                room.name,

            playerId:
                player.id
        }
    );


    const owner =
        room.players[0];


    send(
        owner.ws,
        {
            type: "playerJoined",

            playerId:
                player.id,

            playerName:
                player.name
        }
    );


    sendRoomInfo(room);
}


/* =========================
   READY
========================= */

function handleReady(player) {

    const room =
        getRoom(player);


    if (!room) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "لست داخل غرفة"
            }
        );

        return;
    }


    if (
        room.players.length !== 2
    ) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "انتظر دخول لاعب آخر"
            }
        );

        return;
    }


    player.ready = true;


    broadcastRoom(
        room,
        {
            type: "playerReady",

            playerId:
                player.id,

            playerName:
                player.name
        }
    );


    sendRoomInfo(room);


    /*
        عندما يصبح اللاعبان جاهزين:
        نرسلهما إلى شاشة وضع السفن.
    */

    if (
        room.players.every(
            p => p.ready
        )
    ) {

        startBattlePreparation(room);
    }
}


/* =========================
   START BATTLE PREPARATION
========================= */

function startBattlePreparation(room) {

    if (
        !room ||
        room.players.length !== 2
    ) {
        return;
    }


    room.started = false;

    room.currentPlayerId = null;

    room.winnerId = null;


    room.players.forEach(
        player => {

            player.battleReady = false;

            player.attackedCells =
                new Set();

            send(
                player.ws,
                {
                    type: "startGame",

                    roomId:
                        room.id,

                    grid:
                        player.grid,

                    firstPlayer: null,

                    playerId:
                        player.id,

                    opponentId:
                        getOpponent(
                            room,
                            player
                        )?.id || null
                }
            );

        }
    );
}


/* =========================
   BATTLE READY
========================= */

function handleBattleReady(
    player,
    message
) {

    const room =
        getRoom(player);


    if (!room) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "لست داخل غرفة"
            }
        );

        return;
    }


    if (
        room.players.length !== 2
    ) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "انتظر دخول لاعب آخر"
            }
        );

        return;
    }


    const grid =
        normalizeGrid(
            message.grid
        );


    const shipCells =
        getShipCells(grid);


    if (
        shipCells.size === 0
    ) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "يجب وضع السفن أولاً"
            }
        );

        return;
    }


    player.grid = grid;

    player.shipCells =
        shipCells;

    player.attackedCells =
        new Set();

    player.battleReady =
        true;


    broadcastRoom(
        room,
        {
            type:
                "playerBattleReady",

            playerId:
                player.id
        }
    );


    sendRoomInfo(room);


    if (
        room.players.every(
            p => p.battleReady
        )
    ) {

        startBattle(room);
    }
}


/* =========================
   START BATTLE
========================= */

function startBattle(room) {

    if (
        !room ||
        room.players.length !== 2
    ) {
        return;
    }


    if (room.started) {
        return;
    }


    const firstPlayer =
        room.players[0];


    room.started = true;

    room.currentPlayerId =
        firstPlayer.id;

    room.winnerId = null;


    room.players.forEach(
        player => {

            send(
                player.ws,
                {
                    type:
                        "startGame",

                    roomId:
                        room.id,

                    grid:
                        player.grid,

                    firstPlayer:
                        firstPlayer.id,

                    playerId:
                        player.id,

                    opponentId:
                        getOpponent(
                            room,
                            player
                        )?.id || null
                }
            );

        }
    );


    broadcastRoom(
        room,
        {
            type:
                "turnChanged",

            currentPlayerId:
                room.currentPlayerId
        }
    );
}


/* =========================
   ATTACK
========================= */

function handleAttack(
    player,
    message
) {

    const room =
        getRoom(player);


    if (
        !room ||
        !room.started
    ) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "المعركة لم تبدأ بعد"
            }
        );

        return;
    }


    if (
        room.currentPlayerId !==
        player.id
    ) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "ليس دورك"
            }
        );

        return;
    }


    const opponent =
        getOpponent(
            room,
            player
        );


    if (!opponent) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "لا يوجد خصم"
            }
        );

        return;
    }


    const row =
        Number(message.row);

    const col =
        Number(message.col);


    if (
        !Number.isInteger(row) ||
        !Number.isInteger(col) ||
        row < 0 ||
        row >= BOARD_SIZE ||
        col < 0 ||
        col >= BOARD_SIZE
    ) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "موقع الهجوم غير صحيح"
            }
        );

        return;
    }


    const cell =
        row *
            BOARD_SIZE +
        col;


    if (
        player.attackedCells.has(cell)
    ) {

        send(
            player.ws,
            {
                type: "error",
                message:
                    "لقد هاجمت هذه الخانة من قبل"
            }
        );

        return;
    }


    player.attackedCells.add(cell);


    const hit =
        opponent.shipCells.has(cell);


    if (hit) {

        opponent.grid[row][col] =
            "hit";

    } else {

        opponent.grid[row][col] =
            "miss";
    }


    const attackResult = {

        type:
            "attackResult",

        attackerId:
            player.id,

        row,

        col,

        hit,

        nextPlayerId:
            hit
                ? player.id
                : opponent.id
    };


    send(
        player.ws,
        attackResult
    );


    send(
        opponent.ws,
        attackResult
    );


    const allShipsDestroyed =
        opponent.shipCells.size > 0 &&
        [...opponent.shipCells].every(
            shipCell =>
                player.attackedCells.has(
                    shipCell
                )
        );


    if (allShipsDestroyed) {

        room.started = false;

        room.winnerId =
            player.id;


        broadcastRoom(
            room,
            {
                type: "gameOver",

                winner:
                    player.id,

                winnerId:
                    player.id,

                loserId:
                    opponent.id
            }
        );

        return;
    }


    if (!hit) {

        room.currentPlayerId =
            opponent.id;
    }


    broadcastRoom(
        room,
        {
            type:
                "turnChanged",

            currentPlayerId:
                room.currentPlayerId
        }
    );
}


/* =========================
   ROOM LIST
========================= */

function sendRoomList(player) {

    const availableRooms =
        [...rooms.values()]
            .filter(
                room =>
                    room.players.length < 2 &&
                    !room.started
            )
            .map(
                room => ({
                    roomId:
                        room.id,

                    roomName:
                        room.name,

                    players:
                        room.players.length
                })
            );


    send(
        player.ws,
        {
            type:
                "roomList",

            rooms:
                availableRooms
        }
    );
}


/* =========================
   LEAVE
========================= */

function handleLeaveRoom(player) {

    removeFromMatchmaking(player);


    const room =
        getRoom(player);


    if (!room) {

        player.roomId = null;

        return;
    }


    room.players =
        room.players.filter(
            other =>
                other.id !== player.id
        );


    player.roomId = null;

    resetPlayerBattleData(player);


    if (
        room.players.length === 0
    ) {

        rooms.delete(room.id);

        return;
    }


    const remainingPlayer =
        room.players[0];


    remainingPlayer.roomId =
        room.id;


    room.started = false;

    room.currentPlayerId = null;

    room.winnerId = null;


    resetPlayerBattleData(
        remainingPlayer
    );


    send(
        remainingPlayer.ws,
        {
            type:
                "opponentLeft",

            message:
                "غادر اللاعب الآخر الغرفة"
        }
    );


    sendRoomInfo(room);
}


/* =========================
   MESSAGE HANDLER
========================= */

function handleMessage(
    player,
    message
) {

    if (
        !message ||
        typeof message !==
            "object"
    ) {
        return;
    }


    switch (message.type) {

        case "connect":

            handleConnect(
                player,
                message
            );

            break;


        case "join":

            handleConnect(
                player,
                message
            );

            break;


        case "setName":

            handleConnect(
                player,
                message
            );

            break;


        case "findMatch":

            if (
                message.playerName ||
                message.name
            ) {

                player.name =
                    String(
                        message.playerName ||
                        message.name
                    ).slice(0, 30);
            }

            findMatch(player);

            break;


        case "cancelMatch":

            removeFromMatchmaking(player);

            send(
                player.ws,
                {
                    type:
                        "matchCancelled"
                }
            );

            break;


        case "createRoom":

            handleCreateRoom(
                player,
                message
            );

            break;


        case "joinRoom":

            handleJoinRoom(
                player,
                message
            );

            break;


        case "roomList":

            sendRoomList(player);

            break;


        case "ready":

            handleReady(player);

            break;


        case "battleReady":

            handleBattleReady(
                player,
                message
            );

            break;


        case "attack":

            handleAttack(
                player,
                message
            );

            break;


        case "leaveRoom":

            handleLeaveRoom(player);

            break;


        case "ping":

            send(
                player.ws,
                {
                    type: "pong"
                }
            );

            break;


        default:

            send(
                player.ws,
                {
                    type: "error",
                    message:
                        "أمر غير معروف"
                }
            );

            break;
    }
}


/* =========================
   WEBSOCKET CONNECTION
========================= */

wss.on(
    "connection",
    ws => {

        const player =
            createPlayer(ws);

        ws.player =
            player;


        send(
            ws,
            {
                type:
                    "connected",

                playerId:
                    player.id,

                playerName:
                    player.name
            }
        );


        ws.on(
            "message",
            rawMessage => {

                try {

                    const message =
                        JSON.parse(
                            rawMessage.toString()
                        );

                    handleMessage(
                        player,
                        message
                    );

                } catch (error) {

                    send(
                        ws,
                        {
                            type:
                                "error",

                            message:
                                "البيانات المرسلة غير صحيحة"
                        }
                    );
                }
            }
        );


        ws.on(
            "close",
            () => {

                handleLeaveRoom(player);
            }
        );


        ws.on(
            "error",
            () => {

                handleLeaveRoom(player);
            }
        );
    }
);


/* =========================
   START
========================= */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Server running on port ${PORT}`
        );
    }
);

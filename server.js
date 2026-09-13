const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const BOARD_SIZE = 10;
const PREPARATION_TIME = 20;

const FLEET = [4,3,3,2,2];

const server = http.createServer((req,res)=>{

    if(
        req.url === "/" ||
        req.url === "/index.html"
    ){

        const filePath =
            path.join(__dirname,"index.html");

        fs.readFile(
            filePath,
            (err,data)=>{

                if(err){

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
   BASIC
========================= */

function send(ws,data){

    if(
        ws &&
        ws.readyState === WebSocket.OPEN
    ){

        ws.send(
            JSON.stringify(data)
        );
    }
}

function createEmptyGrid(){

    return Array.from(
        {length:BOARD_SIZE},
        ()=>Array(
            BOARD_SIZE
        ).fill("")
    );
}

function getOnlineCount(){

    let count=0;

    wss.clients.forEach(ws=>{

        if(
            ws.readyState===
            WebSocket.OPEN
        ){

            count++;
        }
    });

    return count;
}

function broadcastOnlineCount(){

    const count=
        getOnlineCount();

    wss.clients.forEach(ws=>{

        if(
            ws.readyState===
            WebSocket.OPEN
        ){

            send(ws,{
                type:"onlineCount",
                count
            });
        }
    });
}

/* =========================
   PLAYER
========================= */

function createPlayer(
    ws,
    name="لاعب"
){

    return {

        id:String(
            nextPlayerId++
        ),

        name:String(
            name||"لاعب"
        ).slice(0,30),

        ws,

        roomId:null,

        ready:false,

        battleReady:false,

        grid:createEmptyGrid(),

        ships:[],

        shipCells:new Map(),

        attackedCells:new Set(),

        weapons:{
            normal:Infinity,
            bomb:2
        }
    };
}

/* =========================
   ROOM
========================= */

function createRoomCode(){

    let code;

    do{

        code=
            String(
                nextRoomId++
            ).padStart(4,"0");

    }while(
        rooms.has(code)
    );

    return code;
}

function createRoom(
    roomName,
    owner
){

    const room={

        id:createRoomCode(),

        name:String(
            roomName||"غرفة"
        ).slice(0,40),

        players:[owner],

        started:false,

        preparation:false,

        currentPlayerId:null,

        winnerId:null,

        onlineMatch:false,

        preparationTimer:null,

        preparationEndsAt:null
    };

    rooms.set(
        room.id,
        room
    );

    owner.roomId=
        room.id;

    return room;
}

function getRoom(player){

    return player?.roomId
        ? rooms.get(
            player.roomId
        )||null
        : null;
}

function getOpponent(
    room,
    player
){

    return room?.players.find(
        p=>p.id!==player.id
    )||null;
}

function isConnected(player){

    return !!(
        player &&
        player.ws &&
        player.ws.readyState===
            WebSocket.OPEN
    );
}

function broadcastRoom(
    room,
    data
){

    if(!room)return;

    room.players.forEach(
        player=>{
            send(
                player.ws,
                data
            );
        }
    );
}

function sendRoomInfo(room){

    if(!room)return;

    room.players.forEach(
        player=>{

            send(
                player.ws,
                {
                    type:"roomInfo",

                    roomId:room.id,

                    roomName:room.name,

                    players:
                        room.players.map(
                            p=>({
                                id:p.id,
                                name:p.name,
                                ready:p.ready,
                                battleReady:
                                    p.battleReady
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
){

    let index;

    while(
        (index=
            matchmakingQueue.indexOf(
                player
            )
        )!==-1
    ){

        matchmakingQueue.splice(
            index,
            1
        );
    }
}

function findMatch(player){

    removeFromMatchmaking(
        player
    );

    if(player.roomId){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "أنت داخل غرفة بالفعل"
            }
        );

        return;
    }

    matchmakingQueue.push(
        player
    );

    send(
        player.ws,
        {
            type:"searching",
            message:
                "جاري البحث عن لاعب..."
        }
    );

    tryMatchPlayers();
}

function tryMatchPlayers(){

    while(
        matchmakingQueue.length>=2
    ){

        const player1=
            matchmakingQueue.shift();

        const player2=
            matchmakingQueue.shift();

        if(
            !isConnected(player1)||
            !isConnected(player2)
        ){

            continue;
        }

        if(
            player1.roomId||
            player2.roomId
        ){

            continue;
        }

        const room=
            createRoom(
                "مباراة أونلاين",
                player1
            );

        room.players.push(
            player2
        );

        player2.roomId=
            room.id;

        room.onlineMatch=true;

        send(
            player1.ws,
            {
                type:"matchFound",
                roomId:room.id,
                opponentId:player2.id,
                opponentName:player2.name
            }
        );

        send(
            player2.ws,
            {
                type:"matchFound",
                roomId:room.id,
                opponentId:player1.id,
                opponentName:player1.name
            }
        );

        sendRoomInfo(room);
    }
}

/* =========================
   GRID
========================= */

function normalizeGrid(grid){

    const result=
        createEmptyGrid();

    if(!Array.isArray(grid)){
        return result;
    }

    for(
        let r=0;
        r<BOARD_SIZE;
        r++
    ){

        if(
            !Array.isArray(grid[r])
        ){
            continue;
        }

        for(
            let c=0;
            c<BOARD_SIZE;
            c++
        ){

            if(
                grid[r][c]==="ship"||
                grid[r][c]==="hit"||
                grid[r][c]==="miss"
            ){

                result[r][c]=
                    grid[r][c];
            }
        }
    }

    return result;
}

function key(r,c){

    return (
        r*BOARD_SIZE+c
    );
}

function validCell(r,c){

    return (
        Number.isInteger(r)&&
        Number.isInteger(c)&&
        r>=0&&
        r<BOARD_SIZE&&
        c>=0&&
        c<BOARD_SIZE
    );
}

/* =========================
   FLEET VALIDATION
========================= */

function validateFleet(
    grid,
    ships
){

    if(
        !Array.isArray(ships)||
        ships.length!==5
    ){

        return {
            valid:false,
            message:
                "يجب أن يحتوي الأسطول على 5 سفن"
        };
    }

    const expected=
        [4,3,3,2,2];

    const used=
        new Set();

    const normalizedShips=[];

    const alreadyUsed=
        new Set();

    for(
        const size of expected
    ){

        const index=
            ships.findIndex(
                (ship,i)=>
                    ship &&
                    Number(ship.size)===size &&
                    !alreadyUsed.has(i)
            );

        if(index===-1){

            return {
                valid:false,
                message:
                    "ترتيب السفن غير صحيح"
            };
        }

        alreadyUsed.add(index);

        normalizedShips.push(
            ships[index]
        );
    }

    for(
        const ship of normalizedShips
    ){

        if(
            !Array.isArray(ship.cells)||
            ship.cells.length!==Number(
                ship.size
            )
        ){

            return {
                valid:false,
                message:
                    "عدد خلايا إحدى السفن غير صحيح"
            };
        }

        const cells=
            ship.cells.map(
                c=>[
                    Number(c[0]),
                    Number(c[1])
                ]
            );

        const unique=
            new Set();

        for(
            const [r,c] of cells
        ){

            if(
                !validCell(r,c)
            ){

                return {
                    valid:false,
                    message:
                        "موقع سفينة غير صحيح"
                };
            }

            const k=
                key(r,c);

            if(
                unique.has(k)||
                used.has(k)
            ){

                return {
                    valid:false,
                    message:
                        "السفن متداخلة"
                };
            }

            unique.add(k);

            if(
                grid[r][c]!=="ship"
            ){

                return {
                    valid:false,
                    message:
                        "بيانات السفن لا تطابق الخريطة"
                };
            }
        }

        const rows=
            cells.map(
                x=>x[0]
            );

        const cols=
            cells.map(
                x=>x[1]
            );

        const sameRow=
            rows.every(
                x=>x===rows[0]
            );

        const sameCol=
            cols.every(
                x=>x===cols[0]
            );

        if(
            !sameRow&&!sameCol
        ){

            return {
                valid:false,
                message:
                    "السفن يجب أن تكون مستقيمة"
            };
        }

        if(sameRow){

            const sorted=
                cols
                    .slice()
                    .sort(
                        (a,b)=>a-b
                    );

            for(
                let i=1;
                i<sorted.length;
                i++
            ){

                if(
                    sorted[i]!==
                    sorted[i-1]+1
                ){

                    return {
                        valid:false,
                        message:
                            "خلايا السفينة يجب أن تكون متجاورة"
                    };
                }
            }

        }else{

            const sorted=
                rows
                    .slice()
                    .sort(
                        (a,b)=>a-b
                    );

            for(
                let i=1;
                i<sorted.length;
                i++
            ){

                if(
                    sorted[i]!==
                    sorted[i-1]+1
                ){

                    return {
                        valid:false,
                        message:
                            "خلايا السفينة يجب أن تكون متجاورة"
                    };
                }
            }
        }

        cells.forEach(
            ([r,c])=>{
                used.add(
                    key(r,c)
                );
            }
        );

        ship.cells=
            cells;
    }

    let shipCount=0;

    for(
        let r=0;
        r<BOARD_SIZE;
        r++
    ){

        for(
            let c=0;
            c<BOARD_SIZE;
            c++
        ){

            if(
                grid[r][c]==="ship"
            ){

                shipCount++;
            }
        }
    }

    if(shipCount!==14){

        return {
            valid:false,
            message:
                "يجب أن يحتوي الأسطول على 14 خانة"
        };
    }

    if(used.size!==14){

        return {
            valid:false,
            message:
                "بيانات السفن غير صحيحة"
        };
    }

    return {
        valid:true,
        ships:normalizedShips
    };
}

/* =========================
   RANDOM FLEET
========================= */

function generateRandomFleet(){

    for(
        let attempt=0;
        attempt<100;
        attempt++
    ){

        const grid=
            createEmptyGrid();

        const ships=[];

        let failed=false;

        for(
            const size of FLEET
        ){

            let placed=false;

            for(
                let tries=0;
                tries<2000&&!placed;
                tries++
            ){

                const horizontal=
                    Math.random()>.5;

                const row=
                    Math.floor(
                        Math.random()*10
                    );

                const col=
                    Math.floor(
                        Math.random()*10
                    );

                const cells=[];

                for(
                    let i=0;
                    i<size;
                    i++
                ){

                    const r=
                        horizontal
                            ? row
                            : row+i;

                    const c=
                        horizontal
                            ? col+i
                            : col;

                    if(
                        !validCell(r,c)||
                        grid[r][c]!==""
                    ){

                        cells.length=0;

                        break;
                    }

                    cells.push([
                        r,
                        c
                    ]);
                }

                if(
                    cells.length===size
                ){

                    cells.forEach(
                        ([r,c])=>{
                            grid[r][c]="ship";
                        }
                    );

                    ships.push({
                        size,
                        cells
                    });

                    placed=true;
                }
            }

            if(!placed){

                failed=true;

                break;
            }
        }

        if(!failed){

            return {
                grid,
                ships
            };
        }
    }

    throw new Error(
        "تعذر إنشاء أسطول"
    );
}

function setPlayerFleet(
    player,
    grid,
    ships
){

    player.grid=
        normalizeGrid(grid);

    player.ships=
        ships.map(
            (ship,index)=>({

                id:index,

                size:Number(
                    ship.size
                ),

                cells:
                    ship.cells.map(
                        c=>[
                            Number(c[0]),
                            Number(c[1])
                        ]
                    ),

                hits:new Set()
            })
        );

    player.shipCells=
        new Map();

    player.ships.forEach(
        ship=>{

            ship.cells.forEach(
                ([r,c])=>{

                    player.shipCells.set(
                        key(r,c),
                        ship.id
                    );
                }
            );
        }
    );
}

/* =========================
   PREPARATION
========================= */

function clearPreparationTimer(
    room
){

    if(
        room?.preparationTimer
    ){

        clearInterval(
            room.preparationTimer
        );

        room.preparationTimer=null;
    }

    if(room){

        room.preparationEndsAt=null;
    }
}

function startBattlePreparation(
    room
){

    if(
        !room||
        room.players.length!==2
    ){

        return;
    }

    clearPreparationTimer(
        room
    );

    room.started=false;

    room.preparation=true;

    room.currentPlayerId=null;

    room.winnerId=null;

    room.players.forEach(
        player=>{

            const fleet=
                generateRandomFleet();

            setPlayerFleet(
                player,
                fleet.grid,
                fleet.ships
            );

            player.battleReady=false;

            player.attackedCells=
                new Set();

            player.weapons={
                normal:Infinity,
                bomb:2
            };
        }
    );

    room.preparationEndsAt=
        Date.now()+
        PREPARATION_TIME*1000;

    room.players.forEach(
        player=>{

            send(
                player.ws,
                {
                    type:"startGame",

                    phase:"preparation",

                    roomId:room.id,

                    grid:player.grid,

                    ships:
                        player.ships.map(
                            ship=>({
                                size:ship.size,
                                cells:ship.cells
                            })
                        ),

                    seconds:
                        PREPARATION_TIME,

                    playerId:
                        player.id
                }
            );
        }
    );

    room.preparationTimer=
        setInterval(()=>{

            const remaining=
                Math.max(
                    0,
                    Math.ceil(
                        (
                            room.preparationEndsAt-
                            Date.now()
                        )/1000
                    )
                );

            broadcastRoom(
                room,
                {
                    type:"preparationTimer",
                    seconds:remaining
                }
            );

            if(
                remaining<=0
            ){

                clearPreparationTimer(
                    room
                );

                /*
                   أي لاعب لم يؤكد يتم
                   قبول آخر ترتيب موجود لديه.
                */
                room.players.forEach(
                    player=>{

                        if(
                            !player.battleReady
                        ){

                            player.battleReady=true;
                        }
                    }
                );

                startBattle(room);
            }

        },1000);
}

/* =========================
   UPDATE GRID
========================= */

function updateBattleGrid(
    player,
    message
){

    const room=
        getRoom(player);

    if(
        !room||
        !room.preparation||
        room.started
    ){

        return;
    }

    const grid=
        normalizeGrid(
            message.grid
        );

    const validation=
        validateFleet(
            grid,
            message.ships
        );

    if(!validation.valid){

        send(
            player.ws,
            {
                type:"error",
                message:
                    validation.message
            }
        );

        return;
    }

    setPlayerFleet(
        player,
        grid,
        validation.ships
    );
}

/* =========================
   BATTLE READY
========================= */

function handleBattleReady(
    player,
    message
){

    const room=
        getRoom(player);

    if(!room){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "لست داخل غرفة"
            }
        );

        return;
    }

    if(!room.preparation){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "مرحلة ترتيب السفن غير فعالة"
            }
        );

        return;
    }

    updateBattleGrid(
        player,
        message
    );

    if(
        player.ships.length!==5
    ){

        return;
    }

    player.battleReady=true;

    broadcastRoom(
        room,
        {
            type:"playerBattleReady",
            playerId:player.id
        }
    );

    if(
        room.players.every(
            p=>p.battleReady
        )
    ){

        clearPreparationTimer(
            room
        );

        startBattle(room);
    }
}

/* =========================
   START BATTLE
========================= */

function startBattle(room){

    if(
        !room||
        room.players.length!==2||
        room.started
    ){

        return;
    }

    clearPreparationTimer(
        room
    );

    room.preparation=false;

    room.started=true;

    room.winnerId=null;

    const firstPlayer=
        room.players[
            Math.floor(
                Math.random()*
                room.players.length
            )
        ];

    room.currentPlayerId=
        firstPlayer.id;

    room.players.forEach(
        player=>{

            player.attackedCells=
                new Set();

            player.weapons={
                normal:Infinity,
                bomb:2
            };

            send(
                player.ws,
                {
                    type:"battleStarted",

                    roomId:room.id,

                    currentPlayerId:
                        room.currentPlayerId
                }
            );
        }
    );

    broadcastRoom(
        room,
        {
            type:"turnChanged",

            currentPlayerId:
                room.currentPlayerId
        }
    );
}

/* =========================
   ATTACK CELLS
========================= */

function getAttackCells(
    row,
    col,
    weapon
){

    if(
        weapon==="normal"
    ){

        return [
            {
                row,
                col
            }
        ];
    }

    if(
        weapon==="bomb"
    ){

        const cells=[];

        for(
            let r=row-1;
            r<=row+1;
            r++
        ){

            for(
                let c=col-1;
                c<=col+1;
                c++
            ){

                if(
                    validCell(r,c)
                ){

                    cells.push({
                        row:r,
                        col:c
                    });
                }
            }
        }

        return cells;
    }

    return [];
}

/* =========================
   ATTACK
========================= */

function handleAttack(
    player,
    message
){

    const room=
        getRoom(player);

    if(
        !room||
        !room.started
    ){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "المعركة لم تبدأ بعد"
            }
        );

        return;
    }

    if(
        room.currentPlayerId!==
        player.id
    ){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "ليس دورك"
            }
        );

        return;
    }

    const opponent=
        getOpponent(
            room,
            player
        );

    if(!opponent){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "لا يوجد خصم"
            }
        );

        return;
    }

    const row=
        Number(message.row);

    const col=
        Number(message.col);

    const weapon=
        message.weapon==="bomb"
            ? "bomb"
            : "normal";

    if(
        !validCell(row,col)
    ){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "موقع الهجوم غير صحيح"
            }
        );

        return;
    }

    if(
        weapon==="bomb" &&
        player.weapons.bomb<=0
    ){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "لا توجد قنابل متبقية"
            }
        );

        return;
    }

    const cells=
        getAttackCells(
            row,
            col,
            weapon
        );

    /*
       لا يسمح باستعمال القنبلة
       إذا كانت أي خانة في المنطقة
       قد استهدفت سابقًا.
    */
    if(
        cells.some(
            cell=>
                player.attackedCells.has(
                    key(
                        cell.row,
                        cell.col
                    )
                )
        )
    ){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "منطقة الهجوم تحتوي على خانة تم استهدافها من قبل"
            }
        );

        return;
    }

    if(
        weapon==="bomb"
    ){

        player.weapons.bomb--;
    }

    const results=[];

    let anyHit=false;

    const sunkShips=
        new Set();

    for(
        const cell of cells
    ){

        const k=
            key(
                cell.row,
                cell.col
            );

        player.attackedCells.add(k);

        const shipId=
            opponent.shipCells.get(k);

        const hit=
            shipId!==undefined;

        if(hit){

            anyHit=true;

            const ship=
                opponent.ships[
                    shipId
                ];

            ship.hits.add(k);

            opponent.grid[
                cell.row
            ][
                cell.col
            ]="hit";

            if(
                ship.hits.size===
                ship.cells.length
            ){

                sunkShips.add(
                    shipId
                );
            }

        }else{

            opponent.grid[
                cell.row
            ][
                cell.col
            ]="miss";
        }

        results.push({
            row:cell.row,
            col:cell.col,
            hit
        });
    }

    /*
       نفس نتيجة الهجوم تصل للاعبين:
       المهاجم يعرف إصاباته،
       والمدافع يعرف الخانات التي أصيب بها.
    */
    const attackResult={

        type:"attackResult",

        attackerId:
            player.id,

        weapon,

        row,

        col,

        hit:anyHit,

        cells:results,

        nextPlayerId:
            anyHit
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

    /*
       مكافأة:
       سفينة 4 أو 3 = قنبلة إضافية.
       سفينة 2 = لا توجد مكافأة.
    */
    for(
        const shipId of sunkShips
    ){

        const ship=
            opponent.ships[
                shipId
            ];

        if(
            ship.size===4||
            ship.size===3
        ){

            player.weapons.bomb++;

            send(
                player.ws,
                {
                    type:"reward",

                    reward:"bomb",

                    shipSize:
                        ship.size,

                    message:
                        `🚢 تم إغراق سفينة ${ship.size} خانات! حصلت على قنبلة إضافية 💣`
                }
            );

        }else{

            send(
                player.ws,
                {
                    type:"reward",

                    reward:null,

                    shipSize:
                        ship.size,

                    message:
                        `🚢 تم إغراق سفينة ${ship.size} خانات!`
                }
            );
        }
    }

    const allDestroyed=
        opponent.ships.length===5 &&
        opponent.ships.every(
            ship=>
                ship.hits.size===
                ship.cells.length
        );

    if(allDestroyed){

        room.started=false;

        room.winnerId=
            player.id;

        broadcastRoom(
            room,
            {
                type:"gameOver",

                winnerId:
                    player.id,

                loserId:
                    opponent.id
            }
        );

        return;
    }

    /*
       الإصابة = يبقى الدور.
       الخطأ = ينتقل الدور.
    */
    if(!anyHit){

        room.currentPlayerId=
            opponent.id;
    }

    broadcastRoom(
        room,
        {
            type:"turnChanged",

            currentPlayerId:
                room.currentPlayerId
        }
    );
}

/* =========================
   ROOM LIST
========================= */

function sendRoomList(
    player
){

    const roomsList=
        [...rooms.values()]
            .filter(
                room=>
                    room.players.length<2 &&
                    !room.started &&
                    !room.preparation
            )
            .map(
                room=>({
                    roomId:room.id,
                    roomName:room.name,
                    players:
                        room.players.length
                })
            );

    send(
        player.ws,
        {
            type:"roomList",
            rooms:roomsList
        }
    );
}

/* =========================
   CREATE ROOM
========================= */

function handleCreateRoom(
    player,
    message
){

    removeFromMatchmaking(
        player
    );

    if(player.roomId){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "أنت داخل غرفة بالفعل"
            }
        );

        return;
    }

    if(
        message.playerName||
        message.name
    ){

        player.name=
            String(
                message.playerName||
                message.name
            ).slice(0,30);
    }

    const room=
        createRoom(
            message.roomName||
                "غرفة جديدة",
            player
        );

    send(
        player.ws,
        {
            type:"roomCreated",

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
){

    removeFromMatchmaking(
        player
    );

    if(player.roomId){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "أنت داخل غرفة بالفعل"
            }
        );

        return;
    }

    const roomId=
        String(
            message.roomId||
            message.roomCode||
            ""
        ).trim();

    if(!roomId){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "أدخل رمز الغرفة"
            }
        );

        return;
    }

    const room=
        rooms.get(roomId);

    if(!room){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "الغرفة غير موجودة"
            }
        );

        return;
    }

    if(
        room.players.length>=2
    ){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "الغرفة ممتلئة"
            }
        );

        return;
    }

    if(
        room.started||
        room.preparation
    ){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "المباراة بدأت بالفعل"
            }
        );

        return;
    }

    if(
        message.playerName||
        message.name
    ){

        player.name=
            String(
                message.playerName||
                message.name
            ).slice(0,30);
    }

    room.players.push(
        player
    );

    player.roomId=
        room.id;

    send(
        player.ws,
        {
            type:"roomJoined",

            roomId:
                room.id,

            roomName:
                room.name,

            playerId:
                player.id
        }
    );

    send(
        room.players[0].ws,
        {
            type:"playerJoined",

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

function handleReady(
    player
){

    const room=
        getRoom(player);

    if(!room){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "لست داخل غرفة"
            }
        );

        return;
    }

    if(
        room.players.length!==2
    ){

        send(
            player.ws,
            {
                type:"error",
                message:
                    "انتظر دخول لاعب آخر"
            }
        );

        return;
    }

    if(
        room.started||
        room.preparation
    ){

        return;
    }

    player.ready=true;

    broadcastRoom(
        room,
        {
            type:"playerReady",

            playerId:
                player.id,

            playerName:
                player.name
        }
    );

    sendRoomInfo(room);

    if(
        room.players.every(
            p=>p.ready
        )
    ){

        startBattlePreparation(
            room
        );
    }
}

/* =========================
   RESET
========================= */

function resetPlayer(
    player
){

    player.ready=false;

    player.battleReady=false;

    player.grid=
        createEmptyGrid();

    player.ships=[];

    player.shipCells=
        new Map();

    player.attackedCells=
        new Set();

    player.weapons={
        normal:Infinity,
        bomb:2
    };
}

/* =========================
   LEAVE
========================= */

function handleLeaveRoom(
    player
){

    removeFromMatchmaking(
        player
    );

    const room=
        getRoom(player);

    if(!room){

        player.roomId=null;

        return;
    }

    clearPreparationTimer(
        room
    );

    room.players=
        room.players.filter(
            p=>p.id!==player.id
        );

    player.roomId=null;

    resetPlayer(player);

    if(
        room.players.length===0
    ){

        rooms.delete(
            room.id
        );

        return;
    }

    const remaining=
        room.players[0];

    remaining.roomId=
        room.id;

    room.started=false;

    room.preparation=false;

    room.currentPlayerId=null;

    room.winnerId=null;

    resetPlayer(
        remaining
    );

    send(
        remaining.ws,
        {
            type:"opponentLeft",
            message:
                "غادر اللاعب الآخر الغرفة"
        }
    );

    sendRoomInfo(room);
}

/* =========================
   MESSAGES
========================= */

function handleMessage(
    player,
    message
){

    if(
        !message||
        typeof message!=="object"
    ){

        return;
    }

    switch(
        message.type
    ){

        case "connect":

        case "join":

        case "setName":

            if(
                message.playerName||
                message.name
            ){

                player.name=
                    String(
                        message.playerName||
                        message.name
                    ).slice(0,30);
            }

            send(
                player.ws,
                {
                    type:"connected",

                    playerId:
                        player.id,

                    playerName:
                        player.name,

                    onlineCount:
                        getOnlineCount()
                }
            );

            break;

        case "findMatch":

            if(
                message.playerName||
                message.name
            ){

                player.name=
                    String(
                        message.playerName||
                        message.name
                    ).slice(0,30);
            }

            findMatch(player);

            break;

        case "cancelMatch":

            removeFromMatchmaking(
                player
            );

            send(
                player.ws,
                {
                    type:"matchCancelled"
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

        case "battleGridUpdate":

            updateBattleGrid(
                player,
                message
            );

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

            handleLeaveRoom(
                player
            );

            break;

        case "ping":

            send(
                player.ws,
                {
                    type:"pong"
                }
            );

            break;

        default:

            send(
                player.ws,
                {
                    type:"error",
                    message:
                        "أمر غير معروف"
                }
            );
    }
}

/* =========================
   WEBSOCKET
========================= */

wss.on(
    "connection",
    ws=>{

        const player=
            createPlayer(ws);

        ws.player=
            player;

        send(
            ws,
            {
                type:"connected",

                playerId:
                    player.id,

                playerName:
                    player.name,

                onlineCount:
                    getOnlineCount()
            }
        );

        broadcastOnlineCount();

        ws.on(
            "message",
            raw=>{

                try{

                    const message=
                        JSON.parse(
                            raw.toString()
                        );

                    handleMessage(
                        player,
                        message
                    );

                }catch(error){

                    send(
                        ws,
                        {
                            type:"error",
                            message:
                                "البيانات المرسلة غير صحيحة"
                        }
                    );
                }
            }
        );

        ws.on(
            "close",
            ()=>{

                handleLeaveRoom(
                    player
                );

                broadcastOnlineCount();
            }
        );

        ws.on(
            "error",
            ()=>{

                handleLeaveRoom(
                    player
                );

                broadcastOnlineCount();
            }
        );
    }
);

server.listen(
    PORT,
    "0.0.0.0",
    ()=>{
        console.log(
            `Server running on port ${PORT}`
        );
    }
);

import json
import random
import string   
import time
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
ROLES = json.loads((BASE_DIR / "roles.json").read_text())["roles"]
ROLES_BY_ID = {r["id"]: r for r in ROLES}

TOWNSPERSON_ROLE = {
    "id": "__townsperson__",
    "name": "Townsperson",
    "team": "innocent",
    "description": "No special power. Use your voice and vote wisely during the day.",
}

HOST_PASSWORD = "zenscape"

# House rule defaults for how many post-death privileges a dead player gets.
# Ricky's role explicitly gets 2 dead votes instead of the usual 1.
DEFAULT_DEAD_CONVO_ALLOWANCE = 1
DEFAULT_DEAD_VOTE_ALLOWANCE = 1
ROLE_DEAD_VOTE_OVERRIDES = {"ricky": 2}

app = FastAPI(title="Bollywood Mafia")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


# ---------------------------------------------------------------------------
# In-memory game state (single-Pi, single-party use case -> no DB needed)
# ---------------------------------------------------------------------------

class Player:
    def __init__(self, name: str):
        self.name = name
        self.role: Optional[str] = None
        self.connected = False
        self.ws: Optional[WebSocket] = None
        self.alive = True
        self.dead_convo_left = 0
        self.dead_vote_left = 0

    def role_payload(self):
        if self.role is None:
            return None
        return ROLES_BY_ID.get(self.role, TOWNSPERSON_ROLE)


class Room:
    def __init__(self, code: str, host_token: str, max_players: int):
        self.code = code
        self.host_token = host_token
        self.max_players = max_players
        self.players: Dict[str, Player] = {}  # player_token -> Player
        self.selected_roles: List[str] = []
        self.assigned = False
        self.ended = False
        self.winner: Optional[str] = None  # "mafia" | "innocent" | None
        self.host_ws: Optional[WebSocket] = None
        self.created_at = time.time()

    def public_state(self):
        """Sent to players: no role info, but alive/dead status + own dead-privilege counts."""
        return {
            "code": self.code,
            "max_players": self.max_players,
            "players": [
                {"name": p.name, "connected": p.connected, "alive": p.alive}
                for p in self.players.values()
            ],
            "player_count": len(self.players),
            "assigned": self.assigned,
            "ended": self.ended,
            "winner": self.winner,
        }

    def host_state(self):
        """Sent to the host only: full visibility into everyone's role + dead-privilege counts."""
        players = []
        for token, p in self.players.items():
            role = p.role_payload()
            players.append({
                "token": token,
                "name": p.name,
                "connected": p.connected,
                "alive": p.alive,
                "role_id": p.role,
                "role_name": role["name"] if role else None,
                "role_team": role["team"] if role else None,
                "dead_convo_left": p.dead_convo_left,
                "dead_vote_left": p.dead_vote_left,
            })
        return {
            "code": self.code,
            "max_players": self.max_players,
            "players": players,
            "player_count": len(self.players),
            "assigned": self.assigned,
            "ended": self.ended,
            "winner": self.winner,
            "selected_roles": self.selected_roles,
        }


ROOMS: Dict[str, Room] = {}


def gen_code(n=4):
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=n))
        if code not in ROOMS:
            return code


def gen_token():
    return "".join(random.choices(string.ascii_letters + string.digits, k=24))


async def push_host_state(room: Room):
    if room.host_ws is not None:
        try:
            await room.host_ws.send_json({"type": "host_state", "data": room.host_state()})
        except Exception:
            pass


async def push_player_state(room: Room):
    payload = {"type": "room_state", "data": room.public_state()}
    for p in room.players.values():
        if p.ws is not None:
            try:
                await p.ws.send_json(payload)
            except Exception:
                pass


async def broadcast_room_state(room: Room):
    await push_host_state(room)
    await push_player_state(room)


def get_authorized_room(room_code: str, host_token: str) -> Room:
    room = ROOMS.get(room_code.upper())
    if not room or room.host_token != host_token:
        raise HTTPException(status_code=403, detail="Not authorized")
    return room


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

class CreateRoomBody(BaseModel):
    max_players: int
    password: str


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "home.html", {})


@app.get("/host", response_class=HTMLResponse)
def host_page(request: Request):
    return templates.TemplateResponse(request, "host.html", {"roles": ROLES})


@app.get("/join", response_class=HTMLResponse)
def join_page(request: Request):
    return templates.TemplateResponse(request, "join.html", {})


@app.get("/play/{room_code}/{player_token}", response_class=HTMLResponse)
def play_page(request: Request, room_code: str, player_token: str):
    room = ROOMS.get(room_code.upper())
    if not room or player_token not in room.players:
        raise HTTPException(status_code=404, detail="Room or player not found")
    return templates.TemplateResponse(
        request,
        "player.html",
        {"room_code": room_code.upper(), "player_token": player_token,
         "player_name": room.players[player_token].name},
    )


@app.post("/api/rooms")
def create_room(body: CreateRoomBody):
    if body.password != HOST_PASSWORD:
        raise HTTPException(status_code=403, detail="Incorrect host password")
    if not (2 <= body.max_players <= 30):
        raise HTTPException(status_code=400, detail="Participants must be between 2 and 30")
    code = gen_code()
    host_token = gen_token()
    room = Room(code=code, host_token=host_token, max_players=body.max_players)
    ROOMS[code] = room
    return {"room_code": code, "host_token": host_token}


@app.get("/api/rooms/{room_code}/host_state")
def get_host_state(room_code: str, host_token: str):
    room = get_authorized_room(room_code, host_token)
    return room.host_state()


@app.get("/api/roles")
def get_roles():
    return {"roles": ROLES}


class JoinBody(BaseModel):
    name: str


@app.post("/api/rooms/{room_code}/join")
def join_room(room_code: str, body: JoinBody):
    room = ROOMS.get(room_code.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.assigned:
        raise HTTPException(status_code=400, detail="Roles already assigned for this room")
    if len(room.players) >= room.max_players:
        raise HTTPException(status_code=400, detail="Room is full")
    name = body.name.strip()[:24]
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    token = gen_token()
    room.players[token] = Player(name=name)
    return {"room_code": room.code, "player_token": token}


class SelectRolesBody(BaseModel):
    host_token: str
    role_ids: List[str]


@app.post("/api/rooms/{room_code}/select_roles")
def select_roles(room_code: str, body: SelectRolesBody):
    room = get_authorized_room(room_code, body.host_token)
    for rid in body.role_ids:
        if rid not in ROLES_BY_ID:
            raise HTTPException(status_code=400, detail=f"Unknown role: {rid}")
    if len(body.role_ids) > room.max_players:
        raise HTTPException(status_code=400, detail="More roles selected than participants")
    room.selected_roles = body.role_ids
    return {"ok": True}


class AssignBody(BaseModel):
    host_token: str


@app.post("/api/rooms/{room_code}/assign")
async def assign_roles(room_code: str, body: AssignBody):
    room = get_authorized_room(room_code, body.host_token)
    if room.assigned:
        raise HTTPException(status_code=400, detail="Already assigned")
    if not room.selected_roles:
        raise HTTPException(status_code=400, detail="No roles selected")

    player_tokens = list(room.players.keys())
    n = len(player_tokens)
    if n == 0:
        raise HTTPException(status_code=400, detail="No players have joined yet")

    # Fill remaining slots (beyond defined special roles) with generic "Townsperson"
    role_pool = list(room.selected_roles)
    while len(role_pool) < n:
        role_pool.append("__townsperson__")
    role_pool = role_pool[:n]
    random.shuffle(role_pool)
    random.shuffle(player_tokens)

    for token, rid in zip(player_tokens, role_pool):
        room.players[token].role = rid

    room.assigned = True
    await broadcast_room_state(room)

    for token, player in room.players.items():
        if player.ws is not None:
            role_payload = player.role_payload() or TOWNSPERSON_ROLE
            try:
                await player.ws.send_json({"type": "role_reveal", "data": role_payload})
            except Exception:
                pass

    return {"ok": True}


class PlayerActionBody(BaseModel):
    host_token: str
    player_token: str


@app.post("/api/rooms/{room_code}/mark_dead")
async def mark_dead(room_code: str, body: PlayerActionBody):
    room = get_authorized_room(room_code, body.host_token)
    player = room.players.get(body.player_token)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    player.alive = False
    player.dead_convo_left = DEFAULT_DEAD_CONVO_ALLOWANCE
    player.dead_vote_left = ROLE_DEAD_VOTE_OVERRIDES.get(player.role, DEFAULT_DEAD_VOTE_ALLOWANCE)
    await broadcast_room_state(room)
    return {"ok": True}


@app.post("/api/rooms/{room_code}/mark_alive")
async def mark_alive(room_code: str, body: PlayerActionBody):
    room = get_authorized_room(room_code, body.host_token)
    player = room.players.get(body.player_token)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    player.alive = True
    player.dead_convo_left = 0
    player.dead_vote_left = 0
    await broadcast_room_state(room)
    return {"ok": True}


class UseDeadPrivilegeBody(BaseModel):
    host_token: str
    player_token: str
    kind: str  # "convo" or "vote"


@app.post("/api/rooms/{room_code}/use_dead_privilege")
async def use_dead_privilege(room_code: str, body: UseDeadPrivilegeBody):
    room = get_authorized_room(room_code, body.host_token)
    player = room.players.get(body.player_token)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    if body.kind == "convo":
        player.dead_convo_left = max(0, player.dead_convo_left - 1)
    elif body.kind == "vote":
        player.dead_vote_left = max(0, player.dead_vote_left - 1)
    else:
        raise HTTPException(status_code=400, detail="kind must be 'convo' or 'vote'")
    await push_host_state(room)
    return {"ok": True}


@app.post("/api/rooms/{room_code}/kick_player")
async def kick_player(room_code: str, body: PlayerActionBody):
    room = get_authorized_room(room_code, body.host_token)
    player = room.players.get(body.player_token)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    if player.ws is not None:
        try:
            await player.ws.send_json({"type": "kicked"})
            await player.ws.close(code=4001)
        except Exception:
            pass
    del room.players[body.player_token]
    await broadcast_room_state(room)
    return {"ok": True}


class SetWinnerBody(BaseModel):
    host_token: str
    winner: str  # "mafia" or "innocent"


@app.post("/api/rooms/{room_code}/set_winner")
async def set_winner(room_code: str, body: SetWinnerBody):
    room = get_authorized_room(room_code, body.host_token)
    if body.winner not in ("mafia", "innocent"):
        raise HTTPException(status_code=400, detail="winner must be 'mafia' or 'innocent'")
    room.ended = True
    room.winner = body.winner
    payload = {"type": "game_ended", "data": {"winner": room.winner}}
    if room.host_ws is not None:
        try:
            await room.host_ws.send_json(payload)
        except Exception:
            pass
    for p in room.players.values():
        if p.ws is not None:
            try:
                await p.ws.send_json(payload)
            except Exception:
                pass
    return {"ok": True, "winner": room.winner}


@app.post("/api/rooms/{room_code}/new_game")
async def new_game(room_code: str, body: AssignBody):
    room = get_authorized_room(room_code, body.host_token)
    # Reset game state but keep the room, its code, and its joined players.
    room.assigned = False
    room.ended = False
    room.winner = None
    room.selected_roles = []
    for p in room.players.values():
        p.role = None
        p.alive = True
        p.dead_convo_left = 0
        p.dead_vote_left = 0
    await broadcast_room_state(room)
    return {"ok": True}


# ---------------------------------------------------------------------------
# WebSockets
# ---------------------------------------------------------------------------

@app.websocket("/ws/host/{room_code}/{host_token}")
async def ws_host(websocket: WebSocket, room_code: str, host_token: str):
    room = ROOMS.get(room_code.upper())
    if not room or room.host_token != host_token:
        await websocket.close(code=4403)
        return
    await websocket.accept()
    room.host_ws = websocket
    await broadcast_room_state(room)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        room.host_ws = None


@app.websocket("/ws/player/{room_code}/{player_token}")
async def ws_player(websocket: WebSocket, room_code: str, player_token: str):
    room = ROOMS.get(room_code.upper())
    if not room or player_token not in room.players:
        await websocket.close(code=4404)
        return
    await websocket.accept()
    player = room.players[player_token]
    player.connected = True
    player.ws = websocket
    await broadcast_room_state(room)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        player.connected = False
        player.ws = None
        await broadcast_room_state(room)

# Collab Editor

A real-time collaborative code editor. Several people open the same room link and edit one file at once, with live cursors and names.

**Stack:** React + CodeMirror 6 · Node/Express + `ws` · Yjs (CRDT) · file persistence (MongoDB planned)

## Run it

Requires Node 18 or newer.

```bash
npm install        # installs server + client (npm workspaces)
npm run dev        # server on :1234, client on http://localhost:5173
```

Open http://localhost:5173. The URL gets a `?room=...` id. Click **Copy invite link**, paste it into a second tab (or another browser), and type in both. Each tab gets its own random name and cursor color, and your own chip is marked "(you)".

```bash
npm test           # server tests: sync, convergence, room isolation, persistence, bad room names, name/cursor updates
npm run build      # production build of the client (client/dist)
```

## How it works

```
Browser A ──┐                        ┌── data/<room>.bin  (saved doc)
            ├── WebSocket /<room> ──►│ server: one Yjs doc per room
Browser B ──┘                        └── broadcasts updates + cursors
```

- `server/src/collab.js`: the core. Keeps one Yjs document per room, applies each client's updates, broadcasts them to the others, tracks cursors ("awareness"), cleans up dead connections with a ping/pong heartbeat, and frees idle rooms.
- `server/src/persistence.js`: debounced, atomic saves of each room (temp file + rename).
- `server/src/app.js`: HTTP server, `/health`, WebSocket upgrade with room-name validation.
- `client/src/Editor.jsx`: creates the Yjs doc, connects, and binds it to CodeMirror.

Why Yjs: it merges simultaneous edits automatically, so nobody overwrites anyone. Be ready to explain that in interviews: *you* built the networking, rooms, persistence, reconnection handling and measurements around it.

## Roadmap

**Week 1 (done in this starter):** two tabs editing live, room links, cursors, names, saved rooms, tests.

**Week 2: the hard parts**
- [ ] Replace file storage with **MongoDB** (keep `load / save / scheduleSave`).
- [ ] Add **JWT login** and per-room permissions (owner / editor / viewer).
- [ ] Show an offline banner and queue edits while disconnected; verify they merge on reconnect (add a test).
- [ ] Add a room list page for the signed-in user.

**Week 3: measure it (these become your resume numbers)**
- [ ] Write `loadtest/` that opens N simulated clients in one room, each making edits.
- [ ] Record **p50 / p95 sync latency** and the **max users per server** before latency degrades.
- [ ] Record memory use per room.

**Week 4: ship it**
- [ ] Deploy (server on Render/Railway/Fly, client on Vercel; set `VITE_WS_URL`).
- [ ] Add an architecture diagram and screenshots/GIF to this README.
- [ ] Optional, last: a "run code" button. Sandboxing safely is a project in itself.

## Resume bullets (fill in after Week 3)

- Built a real-time collaborative code editor supporting **[N]** concurrent users per room with **[X] ms** p95 sync latency.
- Implemented conflict-free merging with Yjs, WebSocket heartbeat and reconnection handling, and persistent document storage in MongoDB.
- Wrote **[N]** automated tests covering sync, convergence, room isolation and persistence across restarts.

## Known limits of this starter

- Persistence is a local folder (`server/data/`), so it does not work across multiple server instances. Fine for Week 1.
- No authentication yet: anyone with a room link can edit.
- JavaScript syntax highlighting only.
- The client build warns about bundle size (CodeMirror). Harmless for now.

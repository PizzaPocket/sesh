const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '../data/state.json');

// ─── Persistence ───────────────────────────────────────────────────────────────
function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let grid = {};
let inventory = { r: 0, g: 0, b: 0 };

ensureDataDir();
if (existsSync(DATA_FILE)) {
  try {
    const data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    grid = data.grid ?? {};
    inventory = data.inventory ?? { r: 0, g: 0, b: 0 };
    console.log('State loaded from', DATA_FILE);
  } catch (e) {
    console.warn('Could not load state:', e.message);
  }
}

function saveState() {
  try {
    ensureDataDir();
    writeFileSync(DATA_FILE, JSON.stringify({ grid, inventory }));
  } catch (e) {
    console.warn('Could not save state:', e.message);
  }
}

// ─── Game state ────────────────────────────────────────────────────────────────
const COLORS = ['#FF0000', '#00FF00', '#0000FF'];
const COLOR_CHANNEL = { '#FF0000': 'r', '#00FF00': 'g', '#0000FF': 'b' };
const users = new Map();
const connections = new Map();
let colorIndex = 0;

// ─── Server ────────────────────────────────────────────────────────────────────
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('sesh');
});

const wss = new WebSocketServer({ server });

function broadcast(message, excludeId = null) {
  for (const [uid, ws] of connections) {
    if (uid !== excludeId && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  const userId = crypto.randomUUID();
  connections.set(userId, ws);

  const usersObj = {};
  for (const [id, u] of users) usersObj[id] = u;
  ws.send(JSON.stringify({ type: 'init', myId: userId, users: usersObj, grid, inventory }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    switch (data.type) {
      case 'join': {
        const name = String(data.name ?? '').slice(0, 24);
        const color = COLORS[colorIndex % COLORS.length];
        colorIndex++;
        users.set(userId, { name, color, x: 0, y: 0, message: '', messageState: null });
        broadcast(JSON.stringify({ type: 'user-joined', userId, name, color }));
        break;
      }

      case 'cursor-move': {
        const user = users.get(userId);
        if (!user) break;
        user.x = Number(data.x) || 0;
        user.y = Number(data.y) || 0;
        broadcast(JSON.stringify({ type: 'cursor-move', userId, x: user.x, y: user.y }), userId);
        break;
      }

      case 'cursor-chat': {
        const user = users.get(userId);
        if (!user) break;
        user.message = String(data.message ?? '');
        user.messageState = data.state ? String(data.state) : null;
        broadcast(JSON.stringify({ type: 'cursor-chat', userId, message: user.message, state: user.messageState }), userId);
        break;
      }

      case 'grid-click-left': {
        const user = users.get(userId);
        if (!user) break;
        const ch = COLOR_CHANNEL[user.color];
        if (!ch) break;
        const col = Number(data.col);
        const row = Number(data.row);
        const count = Math.min(Math.max(1, Number(data.count ?? 1)), 10);
        const key = `${col}_${row}`;
        const cell = { ...(grid[key] ?? { r: 255, g: 255, b: 255 }) };
        const actual = Math.min(cell[ch], count);
        if (actual > 0) {
          cell[ch] -= actual;
          inventory[ch] += actual;
          grid[key] = cell;
          broadcast(JSON.stringify({ type: 'grid-update', col, row, r: cell.r, g: cell.g, b: cell.b, userId, action: 'mine', count: actual }));
          broadcast(JSON.stringify({ type: 'inventory-update', ...inventory }));
          saveState();
        }
        break;
      }

      case 'grid-click-right': {
        const user = users.get(userId);
        if (!user) break;
        const ch = COLOR_CHANNEL[user.color];
        if (!ch) break;
        if (inventory[ch] <= 0) break;
        const col = Number(data.col);
        const row = Number(data.row);
        const count = Math.min(Math.max(1, Number(data.count ?? 1)), 10);
        const key = `${col}_${row}`;
        const cell = { ...(grid[key] ?? { r: 255, g: 255, b: 255 }) };
        const actual = Math.min(255 - cell[ch], count, inventory[ch]);
        if (actual > 0) {
          cell[ch] += actual;
          inventory[ch] -= actual;
          grid[key] = cell;
          broadcast(JSON.stringify({ type: 'grid-update', col, row, r: cell.r, g: cell.g, b: cell.b, userId, action: 'place', count: actual }));
          broadcast(JSON.stringify({ type: 'inventory-update', ...inventory }));
          saveState();
        }
        break;
      }

      case 'grid-tnt': {
        const user = users.get(userId);
        if (!user) break;
        const ch = COLOR_CHANNEL[user.color];
        if (!ch) break;
        const col = Number(data.col);
        const row = Number(data.row);
        const BLAST_RADIUS = 4;
        const cells = [];
        for (let dc = -BLAST_RADIUS; dc <= BLAST_RADIUS; dc++) {
          for (let dr = -BLAST_RADIUS; dr <= BLAST_RADIUS; dr++) {
            const dist = Math.sqrt(dc * dc + dr * dr);
            if (dist <= BLAST_RADIUS) cells.push({ dc, dr, dist });
          }
        }
        cells.sort((a, b) => a.dist - b.dist);
        let totalMined = 0;
        for (const { dc, dr, dist } of cells) {
          const c = col + dc;
          const r = row + dr;
          const key = `${c}_${r}`;
          const cell = { ...(grid[key] ?? { r: 255, g: 255, b: 255 }) };
          let damage;
          if (dist === 0) {
            damage = 255;
          } else {
            const base = Math.round(255 * Math.pow(1 - dist / 4.5, 1.5));
            const rand = Math.round((Math.random() - 0.5) * 60);
            damage = Math.max(0, Math.min(255, base + rand));
          }
          const actual = Math.min(cell[ch], damage);
          if (actual > 0) {
            cell[ch] -= actual;
            inventory[ch] += actual;
            grid[key] = cell;
            totalMined += actual;
            broadcast(JSON.stringify({ type: 'grid-update', col: c, row: r, r: cell.r, g: cell.g, b: cell.b, userId, action: 'tnt', count: actual, blastIdx: Math.round(dist) }));
          }
        }
        if (totalMined > 0) {
          broadcast(JSON.stringify({ type: 'inventory-update', ...inventory }));
          saveState();
        }
        break;
      }

      case 'grid-flashbang': {
        const user = users.get(userId);
        if (!user) break;
        const ch = COLOR_CHANNEL[user.color];
        if (!ch) break;
        if (inventory[ch] <= 0) break;
        const col = Number(data.col);
        const row = Number(data.row);
        const BLAST_RADIUS = 4;
        const cells = [];
        for (let dc = -BLAST_RADIUS; dc <= BLAST_RADIUS; dc++) {
          for (let dr = -BLAST_RADIUS; dr <= BLAST_RADIUS; dr++) {
            const dist = Math.sqrt(dc * dc + dr * dr);
            if (dist <= BLAST_RADIUS) cells.push({ dc, dr, dist });
          }
        }
        cells.sort((a, b) => a.dist - b.dist);
        let totalPlaced = 0;
        for (const { dc, dr, dist } of cells) {
          if (inventory[ch] <= 0) break;
          const c = col + dc;
          const r = row + dr;
          const key = `${c}_${r}`;
          const cell = { ...(grid[key] ?? { r: 255, g: 255, b: 255 }) };
          let amount;
          if (dist === 0) {
            amount = 255;
          } else {
            const base = Math.round(255 * Math.pow(1 - dist / 4.5, 1.5));
            const rand = Math.round((Math.random() - 0.5) * 60);
            amount = Math.max(0, Math.min(255, base + rand));
          }
          const actual = Math.min(255 - cell[ch], amount, inventory[ch]);
          if (actual > 0) {
            cell[ch] += actual;
            inventory[ch] -= actual;
            grid[key] = cell;
            totalPlaced += actual;
            broadcast(JSON.stringify({ type: 'grid-update', col: c, row: r, r: cell.r, g: cell.g, b: cell.b, userId, action: 'flashbang', count: actual, blastIdx: Math.round(dist) }));
          }
        }
        if (totalPlaced > 0) {
          broadcast(JSON.stringify({ type: 'inventory-update', ...inventory }));
          saveState();
        }
        break;
      }
      case 'godmode-reset': {
        grid = {};
        inventory = { r: 0, g: 0, b: 0 };
        saveState();
        broadcast(JSON.stringify({ type: 'full-reset' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    connections.delete(userId);
    users.delete(userId);
    broadcast(JSON.stringify({ type: 'user-left', userId }));
  });
});

server.listen(PORT, () => {
  console.log(`Sesh listening on port ${PORT}`);
});

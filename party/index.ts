import type * as Party from 'partykit/server';

const COLORS = ['#FF0000', '#00FF00', '#0000FF'] as const;
const COLOR_CHANNEL: Record<string, 'r' | 'g' | 'b'> = {
  '#FF0000': 'r',
  '#00FF00': 'g',
  '#0000FF': 'b',
};

type Channel = 'r' | 'g' | 'b';

interface CellState { r: number; g: number; b: number; }
interface GridState { [key: string]: CellState; }
interface Inventory { r: number; g: number; b: number; }
interface UserState {
  name: string;
  color: string;
  x: number;
  y: number;
  message: string;
  messageState: string | null;
}

export default class SeshServer implements Party.Server {
  options: Party.ServerOptions = { hibernate: true };

  private users: Map<string, UserState> = new Map();
  private grid: GridState = {};
  private inventory: Inventory = { r: 0, g: 0, b: 0 };
  private colorIndex = 0;
  private loaded = false;

  constructor(readonly room: Party.Room) {}

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const grid = await this.room.storage.get<GridState>('grid');
    const inventory = await this.room.storage.get<Inventory>('communalInventory');
    if (grid) this.grid = grid;
    if (inventory) this.inventory = inventory;
  }

  async onConnect(conn: Party.Connection) {
    await this.ensureLoaded();

    const usersObj: Record<string, UserState> = {};
    for (const [id, u] of this.users) usersObj[id] = u;

    conn.send(JSON.stringify({
      type: 'init',
      myId: conn.id,
      users: usersObj,
      grid: this.grid,
      inventory: this.inventory,
    }));
  }

  async onMessage(message: string, sender: Party.Connection) {
    await this.ensureLoaded();

    let data: { type: string; [key: string]: unknown };
    try { data = JSON.parse(message); } catch { return; }

    const userId = sender.id;

    switch (data.type) {
      case 'join': {
        const name = String(data.name ?? '').slice(0, 24);
        const color = COLORS[this.colorIndex % COLORS.length];
        this.colorIndex++;
        this.users.set(userId, { name, color, x: 50, y: 50, message: '', messageState: null });
        this.room.broadcast(JSON.stringify({ type: 'user-joined', userId, name, color }));
        break;
      }

      case 'cursor-move': {
        const user = this.users.get(userId);
        if (!user) break;
        user.x = Number(data.x) || 0;
        user.y = Number(data.y) || 0;
        const moveMsg = JSON.stringify({ type: 'cursor-move', userId, x: user.x, y: user.y });
        for (const conn of this.room.getConnections()) {
          if (conn.id !== userId) conn.send(moveMsg);
        }
        break;
      }

      case 'cursor-chat': {
        const user = this.users.get(userId);
        if (!user) break;
        user.message = String(data.message ?? '');
        user.messageState = data.state ? String(data.state) : null;
        const chatMsg = JSON.stringify({ type: 'cursor-chat', userId, message: user.message, state: user.messageState });
        for (const conn of this.room.getConnections()) {
          if (conn.id !== userId) conn.send(chatMsg);
        }
        break;
      }

      case 'grid-click-left': {
        const user = this.users.get(userId);
        if (!user) break;
        const ch: Channel = COLOR_CHANNEL[user.color];
        if (!ch) break;
        const col = Number(data.col);
        const row = Number(data.row);
        const count = Math.min(Math.max(1, Number(data.count ?? 1)), 10);
        const key = `${col}_${row}`;
        const cell: CellState = { ...(this.grid[key] ?? { r: 255, g: 255, b: 255 }) };
        const actual = Math.min(cell[ch], count);
        if (actual > 0) {
          cell[ch] -= actual;
          this.inventory[ch] += actual;
          this.grid[key] = cell;
          this.room.broadcast(JSON.stringify({
            type: 'grid-update', col, row, r: cell.r, g: cell.g, b: cell.b,
            userId, action: 'mine', count: actual,
          }));
          this.room.broadcast(JSON.stringify({ type: 'inventory-update', ...this.inventory }));
          await this.room.storage.put('grid', this.grid);
          await this.room.storage.put('communalInventory', this.inventory);
        }
        break;
      }

      case 'grid-click-right': {
        const user = this.users.get(userId);
        if (!user) break;
        const ch: Channel = COLOR_CHANNEL[user.color];
        if (!ch) break;
        if (this.inventory[ch] <= 0) break;
        const col = Number(data.col);
        const row = Number(data.row);
        const count = Math.min(Math.max(1, Number(data.count ?? 1)), 10);
        const key = `${col}_${row}`;
        const cell: CellState = { ...(this.grid[key] ?? { r: 255, g: 255, b: 255 }) };
        const actual = Math.min(255 - cell[ch], count, this.inventory[ch]);
        if (actual > 0) {
          cell[ch] += actual;
          this.inventory[ch] -= actual;
          this.grid[key] = cell;
          this.room.broadcast(JSON.stringify({
            type: 'grid-update', col, row, r: cell.r, g: cell.g, b: cell.b,
            userId, action: 'place', count: actual,
          }));
          this.room.broadcast(JSON.stringify({ type: 'inventory-update', ...this.inventory }));
          await this.room.storage.put('grid', this.grid);
          await this.room.storage.put('communalInventory', this.inventory);
        }
        break;
      }

      case 'grid-tnt': {
        const user = this.users.get(userId);
        if (!user) break;
        const ch: Channel = COLOR_CHANNEL[user.color];
        if (!ch) break;
        const col = Number(data.col);
        const row = Number(data.row);
        const BLAST_RADIUS = 4;

        const cells: Array<{ dc: number; dr: number; dist: number }> = [];
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
          const cell: CellState = { ...(this.grid[key] ?? { r: 255, g: 255, b: 255 }) };

          let damage: number;
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
            this.inventory[ch] += actual;
            this.grid[key] = cell;
            totalMined += actual;
            const blastIdx = Math.round(dist);
            this.room.broadcast(JSON.stringify({
              type: 'grid-update',
              col: c, row: r, r: cell.r, g: cell.g, b: cell.b,
              userId, action: 'tnt', count: actual, blastIdx,
            }));
          }
        }

        if (totalMined > 0) {
          this.room.broadcast(JSON.stringify({ type: 'inventory-update', ...this.inventory }));
          await this.room.storage.put('grid', this.grid);
          await this.room.storage.put('communalInventory', this.inventory);
        }
        break;
      }

      case 'grid-flashbang': {
        const user = this.users.get(userId);
        if (!user) break;
        const ch: Channel = COLOR_CHANNEL[user.color];
        if (!ch) break;
        if (this.inventory[ch] <= 0) break;
        const col = Number(data.col);
        const row = Number(data.row);
        const BLAST_RADIUS = 4;

        const cells: Array<{ dc: number; dr: number; dist: number }> = [];
        for (let dc = -BLAST_RADIUS; dc <= BLAST_RADIUS; dc++) {
          for (let dr = -BLAST_RADIUS; dr <= BLAST_RADIUS; dr++) {
            const dist = Math.sqrt(dc * dc + dr * dr);
            if (dist <= BLAST_RADIUS) cells.push({ dc, dr, dist });
          }
        }
        cells.sort((a, b) => a.dist - b.dist);

        let totalPlaced = 0;
        for (const { dc, dr, dist } of cells) {
          if (this.inventory[ch] <= 0) break;
          const c = col + dc;
          const r = row + dr;
          const key = `${c}_${r}`;
          const cell: CellState = { ...(this.grid[key] ?? { r: 255, g: 255, b: 255 }) };

          let amount: number;
          if (dist === 0) {
            amount = 255;
          } else {
            const base = Math.round(255 * Math.pow(1 - dist / 4.5, 1.5));
            const rand = Math.round((Math.random() - 0.5) * 60);
            amount = Math.max(0, Math.min(255, base + rand));
          }

          const actual = Math.min(255 - cell[ch], amount, this.inventory[ch]);
          if (actual > 0) {
            cell[ch] += actual;
            this.inventory[ch] -= actual;
            this.grid[key] = cell;
            totalPlaced += actual;
            const blastIdx = Math.round(dist);
            this.room.broadcast(JSON.stringify({
              type: 'grid-update',
              col: c, row: r, r: cell.r, g: cell.g, b: cell.b,
              userId, action: 'flashbang', count: actual, blastIdx,
            }));
          }
        }

        if (totalPlaced > 0) {
          this.room.broadcast(JSON.stringify({ type: 'inventory-update', ...this.inventory }));
          await this.room.storage.put('grid', this.grid);
          await this.room.storage.put('communalInventory', this.inventory);
        }
        break;
      }
    }
  }

  onClose(conn: Party.Connection) {
    this.users.delete(conn.id);
    this.room.broadcast(JSON.stringify({ type: 'user-left', userId: conn.id }));
  }
}

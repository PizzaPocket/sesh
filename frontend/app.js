// ─── Transport ────────────────────────────────────────────────────────────────
const WS_URL = window.location.hostname === 'localhost'
  ? `ws://${window.location.hostname}:8080`
  : 'wss://join-sesh.fly.dev';

const socket = new WebSocket(WS_URL);
socket.addEventListener('close', () => setTimeout(() => window.location.reload(), 1500));

// ─── State ────────────────────────────────────────────────────────────────────
let myUserId = null;
let myColor = '#FFFFFF';
let myName = '';
let joined = false;
let mouseX = 0;
let mouseY = 0;

// Map of userId → { el, nametag, color, name, chatTimer }
const remoteCursors = {};

// Chat state
let chatMode = false;
let chatInput = null;
let chatInactivityTimer = null;
let chatMinWidth = 110;

// Tool state
let hasPickaxe = false;
let pickaxeDurability = 80;
let pickaxeEquipped = false;

let hasJackhammer = false;
let jackhammerDurability = 400;
let jackhammerEquipped = false;
let jackhammerInterval = null;

let hasTNT = false;
let tntEquipped = false;

let hasFlashbang = false;
let flashbangEquipped = false;

let hasLightBrush = false;
let lightBrushDurability = 80;
let lightBrushEquipped = false;

let hasRayGun = false;
let rayGunDurability = 400;
let rayGunEquipped = false;
let rayGunInterval = null;

// Deferred inventory from init (applied after user-joined sets myColor)
let latestInventory = null;

// Hidden mirror span for measuring single-line text width
const chatMirror = document.createElement('span');
Object.assign(chatMirror.style, {
  position: 'fixed', top: '-9999px', left: '-9999px',
  fontSize: '14px', fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
  fontWeight: '400', lineHeight: '1.45', whiteSpace: 'pre',
  visibility: 'hidden', pointerEvents: 'none',
});
document.body.appendChild(chatMirror);

// Grid state
const gridState = {};

// Cell the cursor is currently hovering over (for live hex inspector)
let cursorCell = { col: 0, row: 0 };

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const modalOverlay   = document.getElementById('modal-overlay');
const nameInput      = document.getElementById('name-input');
const joinBtn        = document.getElementById('join-btn');
const cursorLayer    = document.getElementById('cursor-layer');
const effectLayer    = document.getElementById('effect-layer');
const hintBar        = document.getElementById('hint-bar');
const inventoryBar   = document.getElementById('inventory-bar');
const inventoryCount = document.getElementById('inventory-count');
const cellHexEl      = document.getElementById('cell-hex');
const gridCanvas     = document.getElementById('grid-canvas');
const gridCtx        = gridCanvas.getContext('2d');

// ─── Canvas ───────────────────────────────────────────────────────────────────
function drawCell(col, row, r, g, b) {
  gridCtx.fillStyle = `rgb(${r},${g},${b})`;
  gridCtx.fillRect(col * 32, row * 32, 32, 32);
}

function redrawGrid() {
  gridCtx.fillStyle = '#ffffff';
  gridCtx.fillRect(0, 0, gridCanvas.width, gridCanvas.height);
  for (const [key, cell] of Object.entries(gridState)) {
    const [col, row] = key.split('_').map(Number);
    drawCell(col, row, cell.r, cell.g, cell.b);
  }
}

function resizeCanvas() {
  gridCanvas.width = window.innerWidth;
  gridCanvas.height = window.innerHeight;
  redrawGrid();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── My cursor element ────────────────────────────────────────────────────────
const myCursorEl = document.createElement('div');
myCursorEl.id = 'my-cursor';
myCursorEl.innerHTML = cursorSVG('#FFFFFF');
document.body.appendChild(myCursorEl);


// ─── Util ─────────────────────────────────────────────────────────────────────
function textColorFor(bgColor) {
  return bgColor === '#00FF00' ? '#333333' : '#fff';
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Cursor SVG ───────────────────────────────────────────────────────────────
function cursorSVG(color) {
  return `<svg class="cursor-arrow" viewBox="0 0 20 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 0 L0 20 L4.5 14.5 L8 22.5 L10.5 21.5 L7 13.5 L13 13.5 Z" fill="${color}"/>
  </svg>`;
}

// ─── Modal / Join ─────────────────────────────────────────────────────────────
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptJoin();
});
joinBtn.addEventListener('click', attemptJoin);

function attemptJoin() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  send('join', { name });
}

// ─── Message dispatch ─────────────────────────────────────────────────────────
function send(type, payload = {}) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, ...payload }));
  }
}

const handlers = {};

socket.addEventListener('message', (event) => {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  handlers[data.type]?.(data);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
handlers.init = ({ myId, users: initUsers, grid: initGrid, inventory }) => {
  myUserId = myId;

  for (const [uid, data] of Object.entries(initUsers)) {
    if (uid !== myUserId) {
      createRemoteCursor(uid, data.name, data.color, data.x, data.y);
    }
  }

  if (initGrid) {
    for (const [key, cell] of Object.entries(initGrid)) {
      gridState[key] = cell;
      const [col, row] = key.split('_').map(Number);
      drawCell(col, row, cell.r, cell.g, cell.b);
    }
  }

  if (inventory) latestInventory = inventory;
};

// ─── User joined/left ─────────────────────────────────────────────────────────
handlers['user-joined'] = ({ userId, name, color }) => {
  if (userId === myUserId) {
    myColor = color;
    myName  = name;
    joined  = true;

    myCursorEl.innerHTML = cursorSVG(color);
    const newNametag = document.createElement('div');
    newNametag.className = 'nametag';
    newNametag.innerHTML = `<div class="nametag-inner" style="background:${color}"><span class="nametag-name" style="color:${textColorFor(color)}">${escHtml(name)}</span></div>`;
    myCursorEl.appendChild(newNametag);

    modalOverlay.classList.add('hidden');
    document.body.classList.add('joined');
    myCursorEl.style.display = 'block';

    inventoryBar.style.background = color;
    inventoryBar.style.color = textColorFor(color);
    if (latestInventory) updateInventoryDisplay(latestInventory);

    renderToolbar();
    hintBar.classList.add('visible');
  } else {
    createRemoteCursor(userId, name, color);
  }
};

handlers['user-left'] = ({ userId }) => {
  removeRemoteCursor(userId);
};

// ─── Remote cursor management ─────────────────────────────────────────────────
function createRemoteCursor(userId, name, color, x = 50, y = 50) {
  if (remoteCursors[userId]) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'cursor-wrapper';
  wrapper.style.left = x + '%';
  wrapper.style.top  = y + '%';

  wrapper.innerHTML = cursorSVG(color);

  const nametag = document.createElement('div');
  nametag.className = 'nametag';
  nametag.innerHTML = `<div class="nametag-inner" style="background:${color}">
    <span class="nametag-name" style="color:${textColorFor(color)}">${escHtml(name)}</span>
  </div>`;
  wrapper.appendChild(nametag);

  cursorLayer.appendChild(wrapper);

  remoteCursors[userId] = { el: wrapper, nametag, nameEl: nametag.querySelector('.nametag-name'), color, name, chatTimer: null };
}

function removeRemoteCursor(userId) {
  const cursor = remoteCursors[userId];
  if (!cursor) return;
  cursor.el.remove();
  delete remoteCursors[userId];
}

// ─── Cursor move ──────────────────────────────────────────────────────────────
handlers['cursor-move'] = ({ userId, x, y }) => {
  const cursor = remoteCursors[userId];
  if (!cursor) return;
  cursor.el.style.left = x + '%';
  cursor.el.style.top  = y + '%';
};

let lastMoveSent = 0;
document.addEventListener('mousemove', (e) => {
  const now = Date.now();
  mouseX = e.clientX;
  mouseY = e.clientY;

  myCursorEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;

  if (joined) {
    const col = Math.floor(e.clientX / 32);
    const row = Math.floor(e.clientY / 32);
    if (col !== cursorCell.col || row !== cursorCell.row) cursorCell = { col, row };
    const cell = gridState[`${col}_${row}`] ?? { r: 255, g: 255, b: 255 };
    cellHexEl.textContent = rgbToHex(cell.r, cell.g, cell.b);
  }

  if (!joined) return;
  if (now - lastMoveSent < 30) return;
  lastMoveSent = now;
  const x = (e.clientX / window.innerWidth)  * 100;
  const y = (e.clientY / window.innerHeight) * 100;
  send('cursor-move', { x, y });
});

// ─── Grid clicks ──────────────────────────────────────────────────────────────

// Jackhammer: hold left-click to auto-mine at 50ms
document.addEventListener('mousedown', (e) => {
  if (!joined) return;
  if (e.target.closest('#modal-overlay')) return;
  if (chatMode) return;

  if (e.button === 0 && jackhammerEquipped && hasJackhammer) {
    function jhTick() {
      const col = Math.floor(mouseX / 32);
      const row = Math.floor(mouseY / 32);
      send('grid-click-left', { col, row, count: 1 });
      jackhammerDurability--;
      if (jackhammerDurability <= 0) {
        hasJackhammer = false;
        jackhammerEquipped = false;
        clearInterval(jackhammerInterval);
        jackhammerInterval = null;
        renderToolbar();
      }
    }
    jhTick();
    jackhammerInterval = setInterval(jhTick, 50);
  }

  // Ray gun: hold right-click to auto-place at 50ms
  if (e.button === 2 && rayGunEquipped && hasRayGun) {
    function rgTick() {
      const col = Math.floor(mouseX / 32);
      const row = Math.floor(mouseY / 32);
      send('grid-click-right', { col, row, count: 1 });
      rayGunDurability--;
      if (rayGunDurability <= 0) {
        hasRayGun = false;
        rayGunEquipped = false;
        clearInterval(rayGunInterval);
        rayGunInterval = null;
        renderToolbar();
      }
    }
    rgTick();
    rayGunInterval = setInterval(rgTick, 50);
  }
});

document.addEventListener('mouseup', (e) => {
  if (e.button === 0 && jackhammerInterval !== null) {
    clearInterval(jackhammerInterval);
    jackhammerInterval = null;
  }
  if (e.button === 2 && rayGunInterval !== null) {
    clearInterval(rayGunInterval);
    rayGunInterval = null;
  }
});

document.addEventListener('click', (e) => {
  if (!joined) return;
  if (e.target.closest('#modal-overlay')) return;
  if (chatMode) return;
  if (jackhammerEquipped && hasJackhammer) return; // handled by mousedown

  const col = Math.floor(e.clientX / 32);
  const row = Math.floor(e.clientY / 32);

  if (tntEquipped && hasTNT) {
    hasTNT = false;
    tntEquipped = false;
    send('grid-tnt', { col, row });
    renderToolbar();
    return;
  }

  const count = (pickaxeEquipped && hasPickaxe) ? 10 : 1;
  send('grid-click-left', { col, row, count });

  if (pickaxeEquipped && hasPickaxe) {
    pickaxeDurability--;
    if (pickaxeDurability <= 0) {
      hasPickaxe = false;
      pickaxeEquipped = false;
    }
    renderToolbar();
  }

  spawnRipple(e.clientX, e.clientY, myColor);
});

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!joined) return;
  if (chatMode) return;
  if (rayGunEquipped && hasRayGun) return; // handled by mousedown

  const col = Math.floor(e.clientX / 32);
  const row = Math.floor(e.clientY / 32);

  if (flashbangEquipped && hasFlashbang) {
    hasFlashbang = false;
    flashbangEquipped = false;
    send('grid-flashbang', { col, row });
    renderToolbar();
    return;
  }

  const count = (lightBrushEquipped && hasLightBrush) ? 10 : 1;
  send('grid-click-right', { col, row, count });

  if (lightBrushEquipped && hasLightBrush) {
    lightBrushDurability--;
    if (lightBrushDurability <= 0) {
      hasLightBrush = false;
      lightBrushEquipped = false;
    }
    renderToolbar();
  }

  spawnSquare(e.clientX, e.clientY, myColor);
});

handlers['grid-update'] = ({ col, row, r, g, b, userId: uid, action, count, blastIdx }) => {
  const key = `${col}_${row}`;
  gridState[key] = { r, g, b };
  drawCell(col, row, r, g, b);

  if (col === cursorCell.col && row === cursorCell.row) {
    cellHexEl.textContent = rgbToHex(r, g, b);
  }

  if (uid === myUserId) {
    if (action === 'mine') {
      const n = Math.min(count ?? 1, 10);
      for (let i = 0; i < n; i++) spawnMineParticle(col, row, i * 20);

    } else if (action === 'tnt') {
      const delay = (blastIdx ?? 0) * 20;
      setTimeout(() => spawnRipple(col * 32 + 16, row * 32 + 16, myColor), delay);
      if ((blastIdx ?? 0) === 0) setTimeout(() => spawnSquare(col * 32 + 16, row * 32 + 16, myColor), delay);
      // Spawn a particle per mined unit from this cell (capped at 5)
      const n = Math.min(count ?? 1, 5);
      for (let i = 0; i < n; i++) spawnMineParticle(col, row, delay + i * 20);

    } else if (action === 'place') {
      const n = Math.min(count ?? 1, 10);
      for (let i = 0; i < n; i++) spawnPlaceParticle(col, row, i * 20);

    } else if (action === 'flashbang') {
      const delay = (blastIdx ?? 0) * 20;
      setTimeout(() => spawnRipple(col * 32 + 16, row * 32 + 16, myColor), delay);
      spawnPlaceParticle(col, row, delay);
    }
  } else {
    const color = remoteCursors[uid]?.color ?? '#ffffff';
    const cx = col * 32 + 16;
    const cy = row * 32 + 16;
    if (action === 'tnt') {
      const delay = (blastIdx ?? 0) * 20;
      setTimeout(() => spawnRipple(cx, cy, color), delay);
      if ((blastIdx ?? 0) === 0) setTimeout(() => spawnSquare(cx, cy, color), delay);
    } else if (action === 'flashbang') {
      const delay = (blastIdx ?? 0) * 20;
      setTimeout(() => spawnRipple(cx, cy, color), delay);
    } else if (action === 'place') {
      spawnSquare(cx, cy, color);
    } else {
      action === 'mine' ? spawnRipple(cx, cy, color) : spawnSquare(cx, cy, color);
    }
  }
};

// ─── Inventory ────────────────────────────────────────────────────────────────
let pendingInventoryData = null;
let localParticlesInFlight = 0;

function updateInventoryDisplay({ r, g, b }) {
  if (!joined) return;
  const ch = myColor === '#FF0000' ? r : myColor === '#00FF00' ? g : b;
  inventoryCount.textContent = Number(ch).toLocaleString();
}

handlers['inventory-update'] = (data) => {
  pendingInventoryData = data;
  // Update immediately for remote/teammate mining; local particles handle their own update on landing
  if (localParticlesInFlight === 0) updateInventoryDisplay(data);
};

// ─── Click effects ────────────────────────────────────────────────────────────
function spawnRipple(cx, cy, color) {
  const el = document.createElement('div');
  el.className = 'click-effect click-ripple';
  el.style.setProperty('--clr', color);
  el.style.left = cx + 'px';
  el.style.top  = cy + 'px';
  effectLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function spawnSquare(cx, cy, color) {
  const el = document.createElement('div');
  el.className = 'click-effect click-square';
  el.style.setProperty('--clr', color);
  el.style.left = cx + 'px';
  el.style.top  = cy + 'px';
  effectLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ─── Tool drop ────────────────────────────────────────────────────────────────
// Weights: tier 1 (common) = 1.0, tier 2 (uncommon) = 0.35, tier 3 (rare) = 0.12
const TOOL_WEIGHTS = {
  pickaxe:    1.00,
  brush:      1.00,
  jackhammer: 0.35,
  raygun:     0.35,
  tnt:        0.12,
  bucket:     0.12,
};
const TOOL_DROP_CHANCE = 0.03;

function availableToolDrops() {
  return Object.keys(TOOL_WEIGHTS).filter(t =>
    t === 'pickaxe'    ? !hasPickaxe    :
    t === 'jackhammer' ? !hasJackhammer :
    t === 'tnt'        ? !hasTNT        :
    t === 'flashbang'     ? !hasFlashbang     :
    t === 'lightbrush'      ? !hasLightBrush      :
    t === 'raygun'     ? !hasRayGun     : false
  );
}

function pickWeightedTool(drops) {
  const total = drops.reduce((s, t) => s + TOOL_WEIGHTS[t], 0);
  let r = Math.random() * total;
  for (const t of drops) {
    r -= TOOL_WEIGHTS[t];
    if (r <= 0) return t;
  }
  return drops[drops.length - 1];
}

function grantTool(tool) {
  if (tool === 'pickaxe')    { hasPickaxe = true;    pickaxeDurability = 80; }
  else if (tool === 'jackhammer') { hasJackhammer = true; jackhammerDurability = 400; }
  else if (tool === 'tnt')    hasTNT = true;
  else if (tool === 'flashbang') hasFlashbang = true;
  else if (tool === 'lightbrush')  { hasLightBrush = true; lightBrushDurability = 80; }
  else if (tool === 'raygun') { hasRayGun = true; rayGunDurability = 400; }
}

function spawnToolDropParticle(col, row, tool) {
  const startX = col * 32 + 16;
  const startY = row * 32 + 16;
  const hintRect = hintBar.getBoundingClientRect();
  const endX = hintRect.left + hintRect.width / 2;
  const endY = hintRect.top + hintRect.height / 2;
  const dx = endX - startX;
  const dy = endY - startY;

  const el = document.createElement('div');
  el.className = 'mine-particle';
  el.style.background = '#FFD700';
  el.style.width = '10px';
  el.style.height = '10px';
  el.style.borderRadius = '50%';
  el.style.left = startX + 'px';
  el.style.top  = startY + 'px';
  effectLayer.appendChild(el);

  el.animate([
    { offset: 0,    transform: 'translate(-50%, -50%) scale(1)',                                                    opacity: 1, easing: 'cubic-bezier(0.2, 0.8, 0.4, 1)' },
    { offset: 0.20, transform: 'translate(-50%, calc(-50% - 38px)) scale(1.5)',                                     opacity: 1, easing: 'ease-in' },
    { offset: 1,    transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%)) scale(0.75)`,                  opacity: 1 },
  ], { duration: 1240, fill: 'forwards' })
    .finished.then(() => {
      el.remove();
      grantTool(tool);
      renderToolbar();
    });
}

// ─── Mine particle ────────────────────────────────────────────────────────────
function spawnMineParticle(col, row, delay = 0) {
  // Small chance of dropping a tool instead
  const drops = availableToolDrops();
  if (drops.length > 0 && Math.random() < TOOL_DROP_CHANCE) {
    const tool = pickWeightedTool(drops);
    setTimeout(() => spawnToolDropParticle(col, row, tool), delay);
    return;
  }

  const startX = col * 32 + 16;
  const startY = row * 32 + 16;
  const barRect = inventoryBar.getBoundingClientRect();
  const dx = (barRect.left + barRect.width / 2) - startX;
  const dy = (barRect.top  + barRect.height / 2) - startY;

  localParticlesInFlight++;

  setTimeout(() => {
    const el = document.createElement('div');
    el.className = 'mine-particle';
    el.style.background = myColor;
    el.style.left = startX + 'px';
    el.style.top  = startY + 'px';
    effectLayer.appendChild(el);

    el.animate([
      { offset: 0,    transform: 'translate(-50%, -50%) scale(1)',                                                  opacity: 1, easing: 'cubic-bezier(0.2, 0.8, 0.4, 1)' },
      { offset: 0.20, transform: 'translate(-50%, calc(-50% - 38px)) scale(1.35)',                                  opacity: 1, easing: 'ease-in' },
      { offset: 1,    transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%)) scale(0.75)`,                opacity: 1 },
    ], { duration: 620, fill: 'forwards' })
      .finished.then(() => {
        el.remove();
        localParticlesInFlight--;
        if (pendingInventoryData !== null) updateInventoryDisplay(pendingInventoryData);
      });
  }, delay);
}

// ─── Place particle (inventory → cell) ───────────────────────────────────────
function spawnPlaceParticle(col, row, delay = 0) {
  const endX = col * 32 + 16;
  const endY = row * 32 + 16;
  const barRect = inventoryBar.getBoundingClientRect();
  const startX = barRect.left + barRect.width / 2;
  const startY = barRect.top  + barRect.height / 2;
  const dx = endX - startX;
  const dy = endY - startY;

  setTimeout(() => {
    const el = document.createElement('div');
    el.className = 'mine-particle';
    el.style.background = myColor;
    el.style.left = startX + 'px';
    el.style.top  = startY + 'px';
    effectLayer.appendChild(el);

    el.animate([
      { offset: 0,    transform: 'translate(-50%, -50%) scale(0.75)',                                               opacity: 1, easing: 'ease-out' },
      { offset: 0.70, transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%)) scale(1.2)`,                  opacity: 1, easing: 'cubic-bezier(0.2, 0.8, 0.4, 1)' },
      { offset: 1,    transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%)) scale(0.5)`,                  opacity: 0 },
    ], { duration: 500, fill: 'forwards' })
      .finished.then(() => el.remove());
  }, delay);
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────
function renderToolbar() {
  const parts = [];
  const sep = `<div class="toolbar-sep"></div>`;

  function toolItem(label, active) {
    const style = active ? `background:${myColor};color:${textColorFor(myColor)}` : '';
    return `<span class="tool-item${active ? ' active' : ''}" style="${style}">${label}</span>`;
  }

  function section(label, content) {
    return `<div class="toolbar-section"><span class="section-label">${label}</span>${content}</div>`;
  }

  // MINING section — subtractive tools, left click
  const sub = [];
  if (hasPickaxe)    sub.push(toolItem('<kbd>[P]</kbd>ickaxe',    pickaxeEquipped));
  if (hasJackhammer) sub.push(toolItem('<kbd>[J]</kbd>ackhammer', jackhammerEquipped));
  if (hasTNT)        sub.push(toolItem('<kbd>[T]</kbd>NT',        tntEquipped));
  if (sub.length > 0) {
    parts.push(section('MINING', `<span class="tool-group">(${sub.join(', ')}) + click</span>`));
    parts.push(sep);
  }

  // TOOLS section — always shown
  parts.push(section('TOOLS', `<span class="tool-group"><kbd>"/"</kbd> to chat &nbsp; <kbd>"esc"</kbd> to clear</span>`));

  // LIGHTING section — additive tools, right click (ordered by power)
  const add = [];
  if (hasLightBrush)  add.push(toolItem('<kbd>[L]</kbd>ight brush', lightBrushEquipped));
  if (hasRayGun) add.push(toolItem('<kbd>[R]</kbd>ay gun',    rayGunEquipped));
  if (hasFlashbang) add.push(toolItem('<kbd>[F]</kbd>lash bang', flashbangEquipped));
  if (add.length > 0) {
    parts.push(sep);
    parts.push(section('LIGHTING', `<span class="tool-group">(${add.join(', ')}) + right click</span>`));
  }

  hintBar.innerHTML = parts.join('');
}

// ─── Keyboard / tools ─────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (!joined) return;

  if (e.key === '/' && !chatMode) {
    e.preventDefault();
    enterChatMode();
    return;
  }

  if (chatMode && e.key === 'Escape') {
    exitChatMode(true);
    return;
  }

  if (chatMode) return;

  const k = e.key.toLowerCase();

  if (k === 'escape') {
    if (pickaxeEquipped || jackhammerEquipped || tntEquipped || flashbangEquipped || lightBrushEquipped || rayGunEquipped) {
      unequipAll();
      renderToolbar();
    }
    return;
  }

  // Tool hotkeys — toggle, mutually exclusive
  const toolMap = { p: 'pickaxe', j: 'jackhammer', t: 'tnt', f: 'flashbang', l: 'lightbrush', r: 'raygun' };
  const tool = toolMap[k];
  if (!tool) return;

  const hasIt = tool === 'pickaxe' ? hasPickaxe : tool === 'jackhammer' ? hasJackhammer :
                tool === 'tnt' ? hasTNT : tool === 'flashbang' ? hasFlashbang :
                tool === 'lightbrush' ? hasLightBrush : hasRayGun;
  if (!hasIt) return;

  const wasEquipped = equippedTool() === tool;
  unequipAll();
  if (!wasEquipped) equipTool(tool);
  renderToolbar();
});

function equippedTool() {
  if (pickaxeEquipped)    return 'pickaxe';
  if (jackhammerEquipped) return 'jackhammer';
  if (tntEquipped)        return 'tnt';
  if (flashbangEquipped)     return 'flashbang';
  if (lightBrushEquipped)      return 'lightbrush';
  if (rayGunEquipped)     return 'raygun';
  return null;
}

function unequipAll() {
  pickaxeEquipped = jackhammerEquipped = tntEquipped = flashbangEquipped = lightBrushEquipped = rayGunEquipped = false;
  if (jackhammerInterval !== null) { clearInterval(jackhammerInterval); jackhammerInterval = null; }
  if (rayGunInterval !== null)     { clearInterval(rayGunInterval);     rayGunInterval = null; }
}

function equipTool(tool) {
  if (tool === 'pickaxe')    pickaxeEquipped    = true;
  if (tool === 'jackhammer') jackhammerEquipped = true;
  if (tool === 'tnt')        tntEquipped        = true;
  if (tool === 'flashbang')     flashbangEquipped     = true;
  if (tool === 'lightbrush')      lightBrushEquipped      = true;
  if (tool === 'raygun')     rayGunEquipped     = true;
}

// ─── Cursor Chat ──────────────────────────────────────────────────────────────
function enterChatMode() {
  chatMode = true;

  const nametag = myCursorEl.querySelector('.nametag');
  const inner   = nametag.querySelector('.nametag-inner');

  const nameSpan = inner.querySelector('.nametag-name');
  chatMinWidth = Math.max(110, nameSpan.offsetWidth);

  const startW = inner.offsetWidth;
  const startH = inner.offsetHeight;
  inner.style.transition = 'none';
  inner.style.minWidth = startW + 'px';
  inner.style.overflow = 'hidden';
  inner.style.maxHeight = startH + 'px';

  inner.innerHTML = `<span class="nametag-name" style="color:${textColorFor(myColor)}">${escHtml(myName)}</span>`;
  chatInput = document.createElement('textarea');
  chatInput.className = 'nametag-input';
  chatInput.maxLength = 200;
  chatInput.autocomplete = 'off';
  chatInput.spellcheck = false;
  chatInput.rows = 1;

  chatInput.style.width = '0px';
  chatInput.style.transition = 'none';
  chatInput.style.color = textColorFor(myColor);
  chatInput.style.caretColor = textColorFor(myColor);
  inner.appendChild(chatInput);

  void chatInput.offsetWidth;
  chatInput.style.transition = 'width 100ms ease';
  chatInput.style.width = chatMinWidth + 'px';
  inner.style.transition = 'min-width 100ms ease, max-height 100ms ease';
  inner.style.minWidth = (chatMinWidth + 14) + 'px';
  inner.style.maxHeight = '240px';

  nametag.style.pointerEvents = 'auto';
  chatInput.focus();

  chatInput.addEventListener('input', onChatInput);
  chatInput.addEventListener('keydown', onChatKey);
}

function onChatInput() {
  if (!chatInput) return;
  if (chatInput.classList.contains('fading')) chatInput.classList.remove('fading');

  const msg = chatInput.value;
  chatMirror.textContent = msg || '\u200b';
  const textWidth = chatMirror.offsetWidth + 2;
  const newWidth = Math.min(Math.max(chatMinWidth, textWidth), 220);
  chatInput.style.transition = 'none';
  chatInput.style.width = newWidth + 'px';
  chatInput.style.height = 'auto';
  chatInput.style.height = chatInput.scrollHeight + 'px';

  send('cursor-chat', { message: msg, state: 'typing' });

  clearTimeout(chatInactivityTimer);
  chatInactivityTimer = setTimeout(lockAndSendMessage, 3000);
}

function onChatKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    lockAndSendMessage();
  }
}

function lockAndSendMessage() {
  if (!chatMode || !chatInput) return;
  const msg = chatInput.value;
  const trimmed = msg.trim();
  clearTimeout(chatInactivityTimer);

  // Cheat codes — silently grant tool and exit chat
  const cheats = { 'cheat pickaxe': 'pickaxe', 'cheat jackhammer': 'jackhammer',
                   'cheat tnt': 'tnt', 'cheat flashbang': 'flashbang', 'cheat lightbrush': 'lightbrush',
                   'cheat raygun': 'raygun' };
  if (cheats[trimmed]) {
    grantTool(cheats[trimmed]);
    renderToolbar();
    exitChatMode(true);
    return;
  }

  send('cursor-chat', { message: msg, state: 'sent' });
  chatInput.classList.add('fading');
  chatInput.addEventListener('animationend', finishChatMode, { once: true });
}

function finishChatMode() {
  if (!chatInput) return;
  clearTimeout(chatInactivityTimer);

  const nametag = myCursorEl.querySelector('.nametag');
  const inner   = nametag.querySelector('.nametag-inner');
  nametag.style.pointerEvents = '';

  inner.innerHTML = `<span class="nametag-name" style="color:${textColorFor(myColor)}">${escHtml(myName)}</span>`;
  send('cursor-chat', { message: '', state: 'expired' });

  chatInput = null;
  chatMode  = false;
}

function exitChatMode(cancel = false) {
  if (!chatInput) return;
  clearTimeout(chatInactivityTimer);
  chatInput.classList.remove('fading');

  const el      = chatInput;
  const nametag = myCursorEl.querySelector('.nametag');
  const inner   = nametag.querySelector('.nametag-inner');

  chatInput = null;
  chatMode  = false;

  const nameOnlyWidth = inner.querySelector('.nametag-name')?.offsetWidth ?? 0;
  const nameOnlyH = (inner.querySelector('.nametag-name')?.offsetHeight ?? 20) + 6;
  inner.style.overflow = 'hidden';
  inner.style.maxHeight = inner.offsetHeight + 'px';
  inner.style.transition = 'min-width 100ms ease, max-height 100ms ease';
  inner.style.minWidth = (nameOnlyWidth + 14) + 'px';
  inner.style.maxHeight = nameOnlyH + 'px';

  el.style.transition = 'width 100ms ease';
  el.style.width = '0px';

  setTimeout(() => {
    nametag.style.pointerEvents = '';
    inner.style.minWidth = '';
    inner.style.maxHeight = '';
    inner.style.overflow = '';
    inner.style.transition = '';
    inner.innerHTML = `<span class="nametag-name" style="color:${textColorFor(myColor)}">${escHtml(myName)}</span>`;
    if (cancel) send('cursor-chat', { message: '', state: 'expired' });
  }, 100);
}

// ─── Remote chat display ──────────────────────────────────────────────────────
handlers['cursor-chat'] = ({ userId, message, state }) => {
  const cursor = remoteCursors[userId];
  if (!cursor) return;

  const inner = cursor.nametag.querySelector('.nametag-inner');

  if (state === 'typing') {
    let msgSpan = inner.querySelector('.nametag-message');
    if (!msgSpan) {
      msgSpan = document.createElement('span');
      msgSpan.className = 'nametag-message';
      inner.appendChild(msgSpan);
    }
    msgSpan.classList.remove('fade-out');
    msgSpan.textContent = message;
    clearTimeout(cursor.chatTimer);

  } else if (state === 'sent') {
    let msgSpan = inner.querySelector('.nametag-message');
    if (!msgSpan) {
      msgSpan = document.createElement('span');
      msgSpan.className = 'nametag-message';
      inner.appendChild(msgSpan);
    }
    msgSpan.textContent = message;
    clearTimeout(cursor.chatTimer);
    cursor.chatTimer = setTimeout(() => {
      msgSpan.classList.add('fade-out');
      msgSpan.addEventListener('animationend', () => msgSpan.remove(), { once: true });
    }, 100);

  } else if (state === 'expired') {
    clearTimeout(cursor.chatTimer);
    inner.querySelector('.nametag-message')?.remove();
  }
};

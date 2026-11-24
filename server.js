'use strict';
// Duel Me — online walk-around duelling game.
// Mix of nallystake-online (open 3D plaza, real players) + 3-Tick Duel Arena combat.
// Server-authoritative: gold, stakes, escrow, combat ticks and records live here.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');
const PUBLIC = path.join(__dirname, 'public');

// ---------- Outfits (copied from 3-Tick Duel Arena game.ts OUTFITS) ----------
const OUTFITS = [
  { id: 'peasant', name: 'Peasant Rags', price: 0,    blurb: 'What you walked in wearing.', colors: { armor: '#9a8a72', trim: '#6b5d49', plume: '#b0a58e', shield: '#8a7a5f' } },
  { id: 'bronze',  name: 'Bronze Trim',  price: 75,   blurb: 'First real metal. Smells like victory.', colors: { armor: '#a8763e', trim: '#6e4a24', plume: '#d99a4e', shield: '#8a5c2e' } },
  { id: 'steel',   name: 'Steel Plate',  price: 200,  blurb: 'Polished plate that turns heads at the gate.', colors: { armor: '#9fb2c8', trim: '#5f7189', plume: '#dfe9f5', shield: '#7d93ad' } },
  { id: 'shadow',  name: 'Shadow Cloak', price: 350,  blurb: 'Dark leathers for fighters who strike first.', colors: { armor: '#3d4457', trim: '#232833', plume: '#6b7690', shield: '#2e3442' } },
  { id: 'mithril', name: 'Mithril Shine',price: 450,  blurb: 'Blue-purple sheen, light as cloth, hard as a vault door.', colors: { armor: '#7d7fd6', trim: '#4a4a9e', plume: '#b9b9f2', shield: '#5f5fb8' } },
  { id: 'dragon',  name: 'Dragon Red',   price: 900,  blurb: 'Red as a hitsplat. The pit goes quiet when it walks in.', colors: { armor: '#b03030', trim: '#6e1d1d', plume: '#e05a4e', shield: '#8c2626' } },
  { id: 'gilded',  name: 'Gilded King',  price: 2000, blurb: 'Solid gold plate. You don\'t wear it — it announces you.', colors: { armor: '#e3b93c', trim: '#9e7d1c', plume: '#f7dd7a', shield: '#c9a227' } },
];
const outfitById = id => OUTFITS.find(o => o.id === id) || OUTFITS[0];

// ---------- Combat (EXACTLY the duelgame rules) ----------
const MOVES = ['melee', 'magic', 'range'];
const BEATS = { melee: 'range', magic: 'melee', range: 'magic' }; // Melee>Range, Range>Magic, Magic>Melee
const WIN_DAMAGE = { melee: 6, magic: 5, range: 4 };
const MAX_HP = 30;
const STAKES = [5, 10, 25, 50, 100, 250];
const BOT_STAKES = [5, 10, 25];
const BOT_NAME = 'Squire Pip';
const BOT_STYLE = { melee: 3, magic: 3, range: 4 }; // Pip's simple weighted style

function resolveExchange(a, b) {
  // returns {aDmg: damage dealt TO a, bDmg: damage dealt TO b, word, winner:'a'|'b'|'clash'}
  if (a === b) {
    return { aDmg: 1, bDmg: 1, word: 'CLASH!', winner: 'clash' };
  }
  const wordFor = m => m === 'melee' ? 'SLASH!' : m === 'magic' ? 'ZAP!' : 'SNIPED!';
  if (BEATS[a] === b) {
    return { aDmg: 0, bDmg: WIN_DAMAGE[a], word: wordFor(a), winner: 'a' };
  }
  return { aDmg: WIN_DAMAGE[b], bDmg: 0, word: wordFor(b), winner: 'b' };
}
function pickBotMove() {
  const total = BOT_STYLE.melee + BOT_STYLE.magic + BOT_STYLE.range;
  let roll = Math.random() * total;
  for (const m of MOVES) { roll -= BOT_STYLE[m]; if (roll <= 0) return m; }
  return 'melee';
}

// ---------- Store (JSON file) ----------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { users: {} }; }
}
let db = loadDb();
let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }, 50);
}
function saveDbNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------- Passwords (scrypt, no extra deps) ----------
function hashPw(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function newUser(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPw(password, salt), gold: 50, owned: ['peasant'], outfit: 'peasant', wins: 0, losses: 0 };
}
function checkPw(user, password) {
  const h = Buffer.from(hashPw(password, user.salt), 'hex');
  const stored = Buffer.from(user.hash, 'hex');
  return h.length === stored.length && crypto.timingSafeEqual(h, stored);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Live state ----------
const clients = new Map(); // username -> {ws, x, z, rot, duelId}
const pending = new Map(); // targetUsername -> {from, stake, expires}
const duels = new Map();   // duelId -> duel
let duelSeq = 1;
const bot = { username: BOT_NAME, x: 8, z: 14, rot: 0, outfit: 'peasant', wins: 0, losses: 0, isBot: true, duelId: null, tx: 8, tz: 14 };

function send(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
function broadcast(obj, except) {
  for (const [name, c] of clients) if (name !== except) send(c.ws, obj);
}
function publicPlayer(name, c) {
  const u = db.users[name];
  return { username: name, x: c.x, z: c.z, rot: c.rot, outfit: u ? u.outfit : 'peasant', wins: u ? u.wins : 0, losses: u ? u.losses : 0, inDuel: !!c.duelId };
}
function playerList() {
  const list = [];
  for (const [name, c] of clients) list.push(publicPlayer(name, c));
  list.push({ username: bot.username, x: bot.x, z: bot.z, rot: bot.rot, outfit: bot.outfit, wins: bot.wins, losses: bot.losses, inDuel: !!bot.duelId, isBot: true });
  return list;
}
function broadcastPlayers() { broadcast({ type: 'players', players: playerList() }); }
function personalState(name) {
  const u = db.users[name]; if (!u) return;
  const c = clients.get(name);
  send(c && c.ws, { type: 'state', gold: u.gold, wins: u.wins, losses: u.losses, owned: u.owned, outfit: u.outfit });
}
function sysChat(text) { broadcast({ type: 'chat', from: '⚔️ Duel Me', text, kind: 'system' }); }

// Bot wandering (server-side, broadcast like a real player)
setInterval(() => {
  if (bot.duelId) return;
  if (Math.random() < 0.4) { bot.tx = (Math.random() * 70 - 35); bot.tz = (Math.random() * 70 - 35); }
  const dx = bot.tx - bot.x, dz = bot.tz - bot.z, d = Math.hypot(dx, dz);
  if (d > 0.5) { bot.x += dx / d * 0.8; bot.z += dz / d * 0.8; bot.rot = Math.atan2(dx, dz); broadcastPlayers(); }
}, 700);

// ---------- Duels ----------
function startDuel(nameA, nameB, stake) {
  // nameB may be BOT_NAME. Both stakes already validated by caller.
  const isBotDuel = nameB === BOT_NAME;
  const ua = db.users[nameA];
  ua.gold -= stake;
  let ub = null;
  if (!isBotDuel) { ub = db.users[nameB]; ub.gold -= stake; }
  saveDb();
  const id = 'duel' + (duelSeq++);
  const duel = {
    id, a: nameA, b: nameB, stake, pot: stake * 2, isBotDuel,
    hp: { a: MAX_HP, b: MAX_HP },
    locked: { a: null, b: null }, last: { a: 'melee', b: 'melee' },
    tick: 0, settled: false, phase: 'countdown', timer: null,
  };
  duels.set(id, duel);
  const ca = clients.get(nameA); if (ca) { ca.duelId = id; ca.x = -4; ca.z = 0; ca.rot = Math.PI / 2; }
  if (!isBotDuel) { const cb = clients.get(nameB); if (cb) { cb.duelId = id; cb.x = 4; cb.z = 0; cb.rot = -Math.PI / 2; } }
  else { bot.duelId = id; bot.x = 4; bot.z = 0; }
  personalState(nameA); if (ub) personalState(nameB);
  broadcastPlayers();
  broadcast({ type: 'duelStart', duelId: id, a: nameA, b: nameB, stake, pot: duel.pot, hpA: MAX_HP, hpB: MAX_HP });
  sysChat(`${nameA} vs ${nameB} — ${stake} gp each in the pit!`);
  let count = 3;
  broadcast({ type: 'duelCountdown', duelId: id, n: count });
  duel.timer = setInterval(() => {
    if (duel.settled) return;
    if (duel.phase === 'countdown') {
      count--;
      if (count > 0) { broadcast({ type: 'duelCountdown', duelId: id, n: count }); return; }
      duel.phase = 'fight';
      broadcast({ type: 'duelCountdown', duelId: id, n: 0 });
      return;
    }
    // fight phase: 3 ticks/sec, exchange every 3 ticks
    duel.tick++;
    if (duel.isBotDuel) duel.locked.b = pickBotMove();
    if (duel.tick % 3 !== 0) return;
    const moveA = duel.locked.a || duel.last.a;
    const moveB = duel.locked.b || duel.last.b;
    duel.last.a = moveA; duel.last.b = moveB;
    duel.locked.a = null; if (!duel.isBotDuel) duel.locked.b = null;
    const r = resolveExchange(moveA, moveB);
    duel.hp.a -= r.aDmg; duel.hp.b -= r.bDmg;
    broadcast({ type: 'duelExchange', duelId: id, a: duel.a, b: duel.b, moveA, moveB, aDmg: r.aDmg, bDmg: r.bDmg, word: r.word, winnerSide: r.winner, hpA: Math.max(0, duel.hp.a), hpB: Math.max(0, duel.hp.b) });
    if (duel.hp.a <= 0 || duel.hp.b <= 0) {
      let winner;
      if (duel.hp.a <= 0 && duel.hp.b <= 0) winner = duel.hp.a > duel.hp.b ? duel.a : duel.b; // double-KO via clash: lower-negative loses; tie -> b
      else winner = duel.hp.a <= 0 ? duel.b : duel.a;
      if (duel.hp.a === duel.hp.b && duel.hp.a <= 0) winner = duel.a; // exact tie: challenger edge, still exactly one winner
      settleDuel(duel, winner, 'ko');
    }
  }, 333);
  return duel;
}

function settleDuel(duel, winnerName, reason) {
  if (duel.settled) return false; // double-settle guard: pot is paid exactly once
  duel.settled = true;
  if (duel.timer) clearInterval(duel.timer);
  const loserName = winnerName === duel.a ? duel.b : duel.a;
  // Pay the full pot exactly once (bot has no account; its share is house gold)
  if (winnerName !== BOT_NAME) { const w = db.users[winnerName]; if (w) { w.gold += duel.pot; w.wins += 1; } }
  else bot.wins += 1;
  if (loserName !== BOT_NAME) { const l = db.users[loserName]; if (l) l.losses += 1; }
  else bot.losses += 1;
  saveDbNow();
  // Free fighters, restore positions to plaza edge of pit
  const ca = clients.get(duel.a); if (ca && ca.duelId === duel.id) { ca.duelId = null; ca.x = -8; ca.z = 10; }
  if (!duel.isBotDuel) { const cb = clients.get(duel.b); if (cb && cb.duelId === duel.id) { cb.duelId = null; cb.x = 8; cb.z = 10; } }
  if (bot.duelId === duel.id) { bot.duelId = null; bot.x = 8; bot.z = 14; }
  duels.delete(duel.id);
  broadcast({ type: 'duelEnd', duelId: duel.id, winner: winnerName, loser: loserName, pot: duel.pot, reason });
  sysChat(`🏆 ${winnerName} beat ${loserName} and took the ${duel.pot} gp pot!`);
  if (winnerName !== BOT_NAME) personalState(winnerName);
  if (loserName !== BOT_NAME) personalState(loserName);
  broadcastPlayers();
  return true;
}

// Exported for tests / introspection
function _settleById(duelId, winnerName) {
  const d = duels.get(duelId);
  if (!d) return false;
  return settleDuel(d, winnerName, 'test');
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let me = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    // --- auth ---
    if (m.type === 'register' || m.type === 'login') {
      const name = String(m.username || '').trim().slice(0, 16);
      const pw = String(m.password || '');
      if (!/^[A-Za-z0-9_ ]+$/.test(name) || pw.length < 3) return send(ws, { type: 'authErr', message: 'Name: letters/numbers, password 3+ chars.' });
      if (name.toLowerCase() === BOT_NAME.toLowerCase()) return send(ws, { type: 'authErr', message: 'That name is taken.' });
      if (m.type === 'register') {
        if (db.users[name]) return send(ws, { type: 'authErr', message: 'Name already taken — try logging in.' });
        db.users[name] = newUser(pw); saveDbNow();
      } else {
        const u = db.users[name];
        if (!u || !checkPw(u, pw)) return send(ws, { type: 'authErr', message: 'Wrong name or password.' });
      }
      if (clients.has(name)) { const old = clients.get(name); try { old.ws.close(); } catch {} }
      me = name;
      clients.set(name, { ws, x: Math.random() * 10 - 5, z: 18 + Math.random() * 4, rot: 0, duelId: null });
      const u = db.users[name];
      send(ws, { type: 'authOk', username: name, gold: u.gold, wins: u.wins, losses: u.losses, owned: u.owned, outfit: u.outfit, outfits: OUTFITS, players: playerList() });
      broadcastPlayers();
      sysChat(`${name} entered the plaza.`);
      return;
    }
    if (!me) return; // everything below needs login
    const myClient = clients.get(me);
    const myUser = db.users[me];
    if (!myClient || !myUser) return;

    if (m.type === 'move') {
      if (myClient.duelId) return; // movement locked to the pit during a duel
      const x = Math.max(-56, Math.min(56, Number(m.x) || 0));
      const z = Math.max(-56, Math.min(56, Number(m.z) || 0));
      myClient.x = x; myClient.z = z; myClient.rot = Number(m.rot) || 0;
      broadcast({ type: 'playerMove', username: me, x, z, rot: myClient.rot }, me);
      return;
    }
    if (m.type === 'chat') {
      const text = String(m.text || '').trim().slice(0, 200);
      if (text) broadcast({ type: 'chat', from: me, text });
      return;
    }
    if (m.type === 'refill') {
      if (myUser.gold >= 5) return send(ws, { type: 'error', message: 'Refill refused: you still have 5+ gp. Broke is under 5 gp.' });
      myUser.gold += 50; saveDb();
      send(ws, { type: 'refillOk', gold: myUser.gold });
      personalState(me);
      return;
    }
    if (m.type === 'buy') {
      const o = outfitById(m.outfitId);
      if (myUser.owned.includes(o.id)) return send(ws, { type: 'error', message: 'You already own that outfit.' });
      if (myUser.gold < o.price) return send(ws, { type: 'error', message: 'Not enough gold for that outfit.' });
      myUser.gold -= o.price; myUser.owned.push(o.id); myUser.outfit = o.id; saveDb();
      personalState(me); broadcastPlayers();
      return;
    }
    if (m.type === 'equip') {
      const o = outfitById(m.outfitId);
      if (!myUser.owned.includes(o.id)) return send(ws, { type: 'error', message: 'You don\'t own that outfit.' });
      myUser.outfit = o.id; saveDb();
      personalState(me); broadcastPlayers();
      return;
    }
    if (m.type === 'challenge') {
      const target = String(m.target || '');
      const stake = Number(m.stake);
      const allowed = target === BOT_NAME ? BOT_STAKES : STAKES;
      if (!allowed.includes(stake)) return send(ws, { type: 'error', message: 'Pick a valid stake.' });
      if (myClient.duelId) return send(ws, { type: 'error', message: 'You are already in a duel.' });
      if (myUser.gold < stake) return send(ws, { type: 'error', message: 'You can\'t afford that stake.' });
      if (target === BOT_NAME) {
        if (bot.duelId) return send(ws, { type: 'error', message: 'Squire Pip is already fighting.' });
        startDuel(me, BOT_NAME, stake); // bot auto-accepts practice fights
        return;
      }
      if (target === me) return send(ws, { type: 'error', message: 'You can\'t duel yourself.' });
      const tc = clients.get(target); const tu = db.users[target];
      if (!tc || !tu) return send(ws, { type: 'error', message: 'That player is not online.' });
      if (tc.duelId) return send(ws, { type: 'error', message: 'That player is already in a duel.' });
      if (tu.gold < stake) return send(ws, { type: 'error', message: `${target} can't afford ${stake} gp.` });
      pending.set(target, { from: me, stake, expires: Date.now() + 30000 });
      send(tc.ws, { type: 'challengeIncoming', from: me, stake });
      send(ws, { type: 'challengeSent', to: target, stake });
      return;
    }
    if (m.type === 'accept') {
      const p = pending.get(me);
      if (!p || p.from !== m.from || Date.now() > p.expires) return send(ws, { type: 'error', message: 'That challenge expired.' });
      pending.delete(me);
      const fromUser = db.users[p.from]; const fromClient = clients.get(p.from);
      if (!fromClient || !fromUser) return send(ws, { type: 'error', message: 'Challenger went offline.' });
      if (fromUser.gold < p.stake || myUser.gold < p.stake) return send(ws, { type: 'error', message: 'Someone can no longer afford the stake.' });
      if (fromClient.duelId || myClient.duelId) return send(ws, { type: 'error', message: 'Someone is already in a duel.' });
      startDuel(p.from, me, p.stake);
      return;
    }
    if (m.type === 'decline') {
      const p = pending.get(me);
      if (p && p.from === m.from) {
        pending.delete(me);
        const fc = clients.get(p.from);
        if (fc) send(fc.ws, { type: 'error', message: `${me} declined your challenge.` });
      }
      return;
    }
    if (m.type === 'duelMove') {
      if (!MOVES.includes(m.move)) return;
      const d = myClient.duelId && duels.get(myClient.duelId);
      if (!d || d.phase !== 'fight') return;
      if (d.a === me) d.locked.a = m.move;
      else if (d.b === me) d.locked.b = m.move;
      return;
    }
  });
  ws.on('close', () => {
    if (!me) return;
    const c = clients.get(me);
    clients.delete(me);
    pending.delete(me);
    if (c && c.duelId) {
      const d = duels.get(c.duelId);
      if (d) { const winner = d.a === me ? d.b : d.a; settleDuel(d, winner, 'forfeit'); }
    }
    broadcastPlayers();
    sysChat(`${me} left the plaza.`);
  });
});

server.listen(PORT, () => console.log(`Duel Me listening on :${PORT} (db: ${DB_PATH})`));
module.exports = { _settleById, duels, db, resolveExchange };

# ⚔️ Duel Me

A standalone online game: **nallystake's open walk-around plaza + the 3-Tick Duel Arena's combat, against real people.**

Walk a stone plaza in front of a castle gate, see every other real player walking around in real time, tap one, stake gold, and fight them in the duel pit. Winner takes the pot.

## Run it

```bash
npm install
npm start          # http://localhost:3000  (PORT env to change)
npm test           # two-client integration test
```

Accounts, gold, outfits and W-L records persist in `data/db.json` (created on first run). Passwords are hashed with Node's built-in `scrypt` — the only dependency is `ws`. Deploys like nallystake: see `render.yaml` (build `npm install`, start `npm start`).

## How to play (mobile first — designed for a phone in portrait)

- **Move:** big circular joystick, bottom-left. Tap the ground to walk there; WASD/arrows + drag-to-orbit camera also work on desktop.
- **Challenge:** tap a player (generous tap — near counts), or open 👥 Players on the right-hand rail. Pick a stake chip: **5 / 10 / 25 / 50 / 100 / 250 gp**. The server checks *both* players can afford it before the challenge is even sent.
- **New accounts** start with **50 gp** and Peasant Rags. When you're under 5 gp, claim a **free +50 gp refill** in the Outfit Shop.
- **Outfits:** 7 in the shop (Peasant Rags 0, Bronze Trim 75, Steel Plate 200, Shadow Cloak 350, Mithril Shine 450, Dragon Red 900, Gilded King 2000). Your outfit's colours show on your knight, cape and sword — to everyone.
- **Squire Pip** 🤖 is a practice bot wandering the plaza (light-blue name). Challenge him at 5/10/25 gp only. Real-player fights are the main event.
- Tap the wooden **notice board** in the plaza for the rules, the colour key, and the last duel result.

## Duel rules (exactly the duelgame's)

- Both stakes are **escrowed** the moment a challenge is accepted; both fighters are placed in the pit, movement locked, 3-2-1 countdown.
- The server ticks **3 times per second**; one exchange resolves **every 3 ticks (1 second)** using each player's locked-in move. You can change your locked move until the exchange lands; no move locked = your last style repeats (default Melee).
- **The triangle:** 🟠 **Melee hits Range** (6 dmg, "SLASH!") · 🔵 **Magic hits Melee** (5 dmg, "ZAP!") · 🟢 **Range hits Magic** (4 dmg, "SNIPED!"). Cycle: Melee → Range → Magic → Melee. Same style vs same style = "CLASH!" — both take 1.
- **30 HP each.** First to 0 loses. The winner is paid the **full pot, exactly once** (server-side settle guard), records update, both return to the plaza healed.
- **Disconnecting mid-duel is a forfeit** — the other player wins the pot.
- Everyone in the plaza spectates automatically: fighters, hitsplats and HP bars are visible to all.

## The colour code (taught on the notice board in-game)

One code everywhere — buttons, splats, banners, names, minimap, pit, chat — and every colour also carries an icon or a word, never colour alone:

| Cue | Meaning |
|---|---|
| 🗡️ **ORANGE** #fb8c00 | Melee (button, style names, slash arc, tick meter) |
| ✨ **BLUE** #1e88e5 | Magic (button, spell bolt, "ZAP!") · orange is kept for challenge notices in chat only outside styles |
| 🏹 **GREEN** #43a047 | Range (button, arrow shot, "SNIPED!") — green means Range ONLY |
| Red splat, white number | Damage dealt/taken |
| Orange "SLASH!" / blue "ZAP!" / green "SNIPED!" / grey "CLASH!" | Exchange result words, each in the winning style's colour |
| Single crimson HP bar | Health reads from the bar's LENGTH + the HP number; flashes only under 25% — over heads and at top of screen |
| Pit ring: white/grey stone / gold pulsing / red | Pit free / challenge pending or countdown / duel live |
| **GOLD** | All money: gold pill, stake chips, pot, "+pot GP" winner floater, WINNER text; a challenger's name + the incoming-challenge banner; duel/system chat |
| Grey-red "-10 GP" | A lost stake |
| Names | Gold = you (and a challenger, with "!"), red = your live opponent, white = everyone else, light blue = Pip the bot |
| Minimap dots | White = you, yellow = other players, red = the two live fighters, light blue = bot, gold = shop stall |

## Files

- `server.js` — HTTP + WebSocket server: accounts, escrow, server-run duel ticks, bot, persistence.
- `public/index.html` — the whole client: Three.js low-poly plaza (castle gate, red crossed-sword banners, torches, notice board, statue), mobile HUD (joystick, round move buttons, circular minimap, right icon rail, bottom-sheet panels).
- `test/two-clients.js` — registers two clients, checks presence/movement, fights a 10 gp duel to a KO and asserts gold conservation + records, proves the double-settle guard, and exercises the refill rule (refused at 50 gp; works at 0 gp after two forfeited bot duels).

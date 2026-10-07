# Cross-device Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ratings, fights, removed songs and duplicate decisions sync automatically between all of a user's devices through Firebase, merging actions made on several devices before they synced.

**Architecture:** Every state change becomes an action (`op`) applied by one pure function `applyOp` in a new `core.js`. Each device keeps the last cloud-agreed snapshot (`base`) plus its not-yet-uploaded actions (`pending`); a Firestore transaction either writes the local state or replays the pending actions on top of the newer cloud state. Firebase (Google sign-in + one Firestore document per user, gzip-compressed) is loaded lazily from gstatic only when the user signs in.

**Tech Stack:** Plain HTML/JS (no build step, no npm dependencies), Firebase JS SDK 12.19.0 (modular, from `https://www.gstatic.com/firebasejs/12.19.0/`), Node 24 built-in test runner (`node --test`) for `core.js`, headless Chrome + Python for a page smoke test.

**Spec:** `docs/superpowers/specs/2026-10-07-cross-device-sync-design.md`

## Global Constraints

- The site keeps working exactly as today without signing in; Firebase is not downloaded until sign-in (or until a previous sign-in exists on this device).
- No build step and no npm packages: `index.html` + `core.js` are served as-is by GitHub Pages and by `serve.py` (127.0.0.1:8888).
- UI text is English, like the rest of the site; keep the existing look (dark theme, red/blue corners, `.option`/`.btn` components).
- Firestore document `users/{uid}`: fields `v` (number), `data` (Bytes, gzip of JSON `{tracks, fights, removed, resolved}`), `schema` (number, currently `1`), `updatedAt` (server timestamp), `device` (string).
- Compressed state larger than 900 KB is never written (`MAX_BYTES = 900 * 1024`).
- `history` (the undo stack) is local to a device and is never uploaded.
- Debounce after an action: 5 s. Also sync on open, on tab hidden, on `online`, and every 60 s while visible with pending actions.
- `applyOp` is deterministic (no `Date.now()`, `Math.random()`, network) and never throws on missing songs.
- Spotify side effects (unlike/like) run only on the device that created the action, never during replay.
- Commits: `git -c user.name=Seezov -c user.email=Seezov@users.noreply.github.com commit ...`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push (only in the last task) with `GH_TOKEN=$(gh auth token -u Seezov)` over HTTPS: `git push "https://x-access-token:$GH_TOKEN@github.com/Seezov/Songsrank.git" main` (the default SSH key belongs to another account and is rejected).
- Spec addition: one extra action type `reopen` (`{ sigs }`) for the existing "a new version reopens a *not duplicates* decision" logic in `renderDupes`, which today mutates state directly.

## Review Focus

1. An action made while a sync transaction is in flight (tap during the 5 s debounce firing) must not be lost — Task 3 test `action made during a sync is kept`.
2. A song removed (or merged away) on one device while the other device fought it offline: the fight must be skipped without crashing and `fights` must stay consistent — Task 2 test `fight with a missing song is a no-op`, Task 3 test `remove on A + fight on B`.
3. Restore-backup (`replace`) on one device while another device has pending fights: after both sync, the backup wins and the other device's fights on surviving songs are applied on top — Task 3 test `replace on A, fights on B`.
4. Undo of a fight that already reached the cloud after other fights changed the same songs: games/wins come back exactly, rating moves back by the recorded delta — Task 2 test `unfight reverts counters and rating delta`.
5. Cloud data that is too large or written by a newer schema must stop sync without touching local data — Task 3 tests `too large state is not written` and `newer schema stops sync`.

---

### Task 1: Firebase project setup (owner, in the console)

The project `songsrank` already exists (https://console.firebase.google.com/u/0/project/songsrank/overview). The remaining steps are done by the owner in the browser; the implementer only verifies and records the result.

**Files:** none (output is the `firebaseConfig` object used in Task 5)

- [ ] **Step 1: Enable Google sign-in**

Console → Build → Authentication → Get started → Sign-in method → Google → Enable → pick the support email → Save.

- [ ] **Step 2: Authorize the site's domains**

Authentication → Settings → Authorized domains → Add domain: `seezov.github.io`, then `127.0.0.1`.

- [ ] **Step 3: Create Firestore**

Build → Firestore Database → Create database → Standard edition → location `eur3 (europe)` → Start in production mode → Create.

- [ ] **Step 4: Publish the security rules**

Firestore → Rules → replace everything with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

→ Publish.

- [ ] **Step 5: Register the web app and copy its config**

Project settings (gear) → General → Your apps → Web (`</>`) → nickname `songsrank-web`, no Hosting → Register app → copy the `firebaseConfig` object (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`). It is public by design and will be committed. Hand it to the implementer for Task 5.

---

### Task 2: `core.js` — state actions (`applyOp`)

**Files:**
- Create: `core.js`
- Create: `tests/core.test.js`

**Interfaces:**
- Produces (globals in the browser, `module.exports` in Node):
  - `START: number` (1500), `SCHEMA: number` (1), `MAX_BYTES: number` (921600)
  - `kFactor(track) -> number`, `expected(ra, rb) -> number`
  - `migrate(state) -> state` (moved unchanged from `index.html`)
  - `shareable(state) -> { tracks, fights, removed, resolved }` (same object references, no `history`)
  - `applyOp(state, op) -> effect | null` — mutates `state`; effects: `fight → { da, db }`, `remove → { track }`, `restore → { track, unliked }`, `merge`/`removeVersions → { removedIds }`, `unresolve → { relikeIds }`, `import → { added, removed, total }`, everything else `null`
- Action shape: `{ id: string, type: string, at: ISO string, ...payload }`; payloads: `fight {a, b, score}`, `unfight {a, b, score, da, db}`, `remove {trackId}`, `restore {trackId}`, `markUnliked {trackIds}`, `merge {sig, keepId, removeIds}`, `removeVersions {sig, keepId, removeIds}`, `distinct {sig}`, `reopen {sigs}`, `unresolve {sig}`, `import {tracks, removeMissing}`, `cover {trackId, url}`, `reset {}`, `replace {state}`

- [ ] **Step 1: Write the failing tests**

`tests/core.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');
const { applyOp, START } = core;

const track = (id, extra = {}) => ({
  id, name: 'Song ' + id, artists: 'Artist ' + id, album: '', img: '', imgSm: '', added: '', isrc: '', released: '',
  rating: START, games: 0, wins: 0, losses: 0, draws: 0, ...extra,
});
const fixture = () => ({
  tracks: { a: track('a'), b: track('b'), c: track('c'), d: track('d') },
  fights: 0, history: [], removed: {}, resolved: {},
});
let n = 0;
const op = (type, payload = {}) => ({ id: 'op' + (++n), type, at: '2026-10-07T12:00:00.000Z', ...payload });

test('fight: winner gains, loser loses, counters move', () => {
  const s = fixture();
  const e = applyOp(s, op('fight', { a: 'a', b: 'b', score: 1 }));
  assert.equal(e.da, 24); // k=48, expected 0.5
  assert.equal(e.db, -24);
  assert.equal(s.tracks.a.rating, 1524);
  assert.equal(s.tracks.b.rating, 1476);
  assert.deepEqual([s.tracks.a.wins, s.tracks.b.losses, s.tracks.a.games, s.tracks.b.games, s.fights], [1, 1, 1, 1, 1]);
});

test('fight: draw counts as a draw for both', () => {
  const s = fixture();
  applyOp(s, op('fight', { a: 'a', b: 'b', score: 0.5 }));
  assert.deepEqual([s.tracks.a.draws, s.tracks.b.draws, s.tracks.a.rating], [1, 1, START]);
});

test('fight with a missing song is a no-op', () => {
  const s = fixture();
  delete s.tracks.b;
  assert.equal(applyOp(s, op('fight', { a: 'a', b: 'b', score: 1 })), null);
  assert.equal(s.fights, 0);
  assert.equal(s.tracks.a.games, 0);
});

test('unfight reverts counters and rating delta', () => {
  const s = fixture();
  const e = applyOp(s, op('fight', { a: 'a', b: 'b', score: 0 }));
  applyOp(s, op('fight', { a: 'a', b: 'c', score: 1 })); // another fight moves a's rating
  const ratingA = s.tracks.a.rating;
  applyOp(s, op('unfight', { a: 'a', b: 'b', score: 0, da: e.da, db: e.db }));
  assert.equal(s.tracks.a.rating, ratingA - e.da);
  assert.equal(s.tracks.b.rating, START);
  assert.deepEqual([s.tracks.a.games, s.tracks.a.losses, s.tracks.a.wins, s.tracks.b.games, s.tracks.b.wins, s.fights], [1, 0, 1, 0, 0, 1]);
});

test('remove then restore puts the song back with its stats', () => {
  const s = fixture();
  applyOp(s, op('fight', { a: 'a', b: 'b', score: 1 }));
  const e = applyOp(s, op('remove', { trackId: 'a' }));
  assert.equal(e.track.id, 'a');
  assert.equal(s.tracks.a, undefined);
  assert.equal(s.removed.a.removedAt, '2026-10-07T12:00:00.000Z');
  assert.equal(s.removed.a.unliked, false);
  applyOp(s, op('markUnliked', { trackIds: ['a', 'zzz'] }));
  assert.equal(s.removed.a.unliked, true);
  const r = applyOp(s, op('restore', { trackId: 'a' }));
  assert.equal(r.unliked, true);
  assert.equal(s.tracks.a.rating, 1524);
  assert.equal(s.tracks.a.removedAt, undefined);
  assert.equal(s.removed.a, undefined);
  assert.equal(applyOp(s, op('restore', { trackId: 'a' })), null);
  assert.equal(applyOp(s, op('remove', { trackId: 'nope' })), null);
});

test('merge combines stats, records the group, restore gives them back', () => {
  const s = fixture();
  s.tracks.a = track('a', { rating: 1600, games: 2, wins: 2 });
  s.tracks.b = track('b', { rating: 1400, games: 2, losses: 2 });
  const e = applyOp(s, op('merge', { sig: 'a,b', keepId: 'a', removeIds: ['b'] }));
  assert.deepEqual(e.removedIds, ['b']);
  assert.equal(s.tracks.a.rating, 1500);
  assert.deepEqual([s.tracks.a.games, s.tracks.a.wins, s.tracks.a.losses], [4, 2, 2]);
  assert.equal(s.removed.b.mergedInto, 'a');
  assert.deepEqual(s.resolved['a,b'], { type: 'merged', ids: ['a', 'b'], keepId: 'a', removedIds: ['b'], ratingShift: -100, at: '2026-10-07T12:00:00.000Z' });
  applyOp(s, op('restore', { trackId: 'b' }));
  assert.deepEqual([s.tracks.a.games, s.tracks.a.wins, s.tracks.a.losses], [2, 2, 0]);
  assert.equal(s.resolved['a,b'], undefined);
});

test('merge whose keeper is gone is a no-op', () => {
  const s = fixture();
  delete s.tracks.a;
  assert.equal(applyOp(s, op('merge', { sig: 'a,b', keepId: 'a', removeIds: ['b'] })), null);
  assert.ok(s.tracks.b);
});

test('unresolve undoes a merge and reports songs to like again', () => {
  const s = fixture();
  s.tracks.a = track('a', { rating: 1600, games: 2, wins: 2 });
  s.tracks.b = track('b', { rating: 1400, games: 2, losses: 2 });
  applyOp(s, op('merge', { sig: 'a,b', keepId: 'a', removeIds: ['b'] }));
  applyOp(s, op('markUnliked', { trackIds: ['b'] }));
  const e = applyOp(s, op('unresolve', { sig: 'a,b' }));
  assert.deepEqual(e.relikeIds, ['b']);
  assert.equal(s.tracks.a.rating, 1600);
  assert.equal(s.tracks.a.games, 2);
  assert.equal(s.tracks.b.rating, 1400);
  assert.equal(s.resolved['a,b'], undefined);
  assert.deepEqual(applyOp(s, op('unresolve', { sig: 'a,b' })), { relikeIds: [] });
});

test('removeVersions removes without combining stats; unresolve brings them back', () => {
  const s = fixture();
  s.tracks.b = track('b', { games: 3, wins: 3 });
  applyOp(s, op('removeVersions', { sig: 'a,b', keepId: 'a', removeIds: ['b'] }));
  assert.equal(s.tracks.a.games, 0);
  assert.equal(s.removed.b.mergedInto, undefined);
  assert.equal(s.resolved['a,b'].type, 'removed');
  applyOp(s, op('unresolve', { sig: 'a,b' }));
  assert.equal(s.tracks.b.wins, 3);
});

test('distinct and reopen', () => {
  const s = fixture();
  applyOp(s, op('distinct', { sig: 'a,b' }));
  assert.deepEqual(s.resolved['a,b'], { type: 'distinct', ids: ['a', 'b'], at: '2026-10-07T12:00:00.000Z' });
  applyOp(s, op('reopen', { sigs: ['a,b', 'x,y'] }));
  assert.equal(s.resolved['a,b'], undefined);
});

test('import adds, updates, skips removed, and drops missing on a full sync', () => {
  const s = fixture();
  applyOp(s, op('remove', { trackId: 'd' }));
  const e = applyOp(s, op('import', {
    tracks: [{ id: 'a', name: 'New name', artists: 'X', album: 'Al', img: 'i', imgSm: 'j' }, { id: 'e', name: 'E', artists: 'Y', album: '' }, { id: 'd', name: 'D', artists: '' }],
    removeMissing: true,
  }));
  assert.deepEqual(e, { added: 1, removed: 2, total: 2 }); // b, c dropped
  assert.equal(s.tracks.a.name, 'New name');
  assert.equal(s.tracks.e.rating, START);
  assert.equal(s.tracks.d, undefined);
  assert.equal(s.removed.d.unliked, false); // still liked: d came back in the import
});

test('cover, reset, replace', () => {
  const s = fixture();
  applyOp(s, op('cover', { trackId: 'a', url: 'u' }));
  assert.equal(s.tracks.a.img + s.tracks.a.imgSm, 'uu');
  applyOp(s, op('fight', { a: 'a', b: 'b', score: 1 }));
  applyOp(s, op('reset'));
  assert.equal(s.fights, 0);
  assert.ok(Object.values(s.tracks).every(t => t.rating === START && t.games === 0));
  s.history = [{ opId: 'keep me' }];
  applyOp(s, op('replace', { state: { tracks: { z: track('z') }, fights: 7, notDupes: { 'p,q': true } } }));
  assert.deepEqual(Object.keys(s.tracks), ['z']);
  assert.equal(s.fights, 7);
  assert.equal(s.resolved['p,q'].type, 'distinct');
  assert.deepEqual(s.history, [{ opId: 'keep me' }]);
});

test('unknown action types are ignored', () => {
  const s = fixture();
  assert.equal(applyOp(s, op('fromTheFuture', { x: 1 })), null);
  assert.equal(s.fights, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/*.test.js`
Expected: FAIL — `Cannot find module '../core.js'`.

- [ ] **Step 3: Write `core.js`**

```js
/* Song Fight Night: state logic shared by the page and the Node tests.
   Every change to the ranking is an action, applied by applyOp. No DOM, no network,
   no clock: whatever an action needs travels inside it, so replaying the same actions
   on another device gives the same result. */
const START = 1500;
const SCHEMA = 1;
const MAX_BYTES = 900 * 1024; // Firestore caps a document at 1 MiB

const kFactor = s => s.games < 5 ? 48 : s.games < 15 ? 32 : 20;
const expected = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

// resolved: group signature (sorted ids) -> {type: 'merged'|'removed'|'distinct', ids, keepId, removedIds, ratingShift, at}
function migrate(st) {
  st.removed ||= {};
  st.resolved ||= {};
  for (const sig of Object.keys(st.notDupes || {})) st.resolved[sig] ||= { type: 'distinct', ids: sig.split(','), at: new Date().toISOString() };
  delete st.notDupes;
  // merges made before resolved groups existed: rebuild them from the removed list (pre-merge rating unknown)
  const known = new Set(Object.values(st.resolved).flatMap(r => r.removedIds || []));
  const byKeeper = {};
  for (const r of Object.values(st.removed)) if (r.mergedInto && !known.has(r.id)) (byKeeper[r.mergedInto] ||= []).push(r);
  for (const [keepId, rs] of Object.entries(byKeeper)) {
    const ids = [keepId, ...rs.map(r => r.id)].sort();
    st.resolved[ids.join(',')] = { type: 'merged', ids, keepId, removedIds: rs.map(r => r.id), ratingShift: 0, at: rs.map(r => r.removedAt).sort().pop() };
  }
  return st;
}

// the part of the state that is the same on every device (history is per device)
const shareable = st => ({ tracks: st.tracks, fights: st.fights, removed: st.removed, resolved: st.resolved });

// a removed-list entry back to a ranking track
const unpack = ({ removedAt, unliked, mergedInto, ...t }) => t;
const STATS = ['wins', 'losses', 'draws', 'games'];

function applyOp(st, op) {
  const T = st.tracks, R = st.removed;
  switch (op.type) {
    case 'fight': {
      const a = T[op.a], b = T[op.b];
      if (!a || !b) return null; // one of them was removed on another device
      const ea = expected(a.rating, b.rating);
      const da = kFactor(a) * (op.score - ea);
      const db = kFactor(b) * ((1 - op.score) - (1 - ea));
      a.rating += da; b.rating += db;
      a.games++; b.games++;
      if (op.score === 1) { a.wins++; b.losses++; } else if (op.score === 0) { b.wins++; a.losses++; } else { a.draws++; b.draws++; }
      st.fights++;
      return { da, db };
    }
    case 'unfight': {
      const result = (score, first) => score === 0.5 ? 'draws' : (score === 1) === first ? 'wins' : 'losses';
      for (const [id, d, first] of [[op.a, op.da, true], [op.b, op.db, false]]) {
        const s = T[id];
        if (!s) continue;
        s.rating -= d;
        s.games = Math.max(0, s.games - 1);
        const k = result(op.score, first);
        s[k] = Math.max(0, s[k] - 1);
      }
      st.fights = Math.max(0, st.fights - 1);
      return null;
    }
    case 'remove': {
      const t = T[op.trackId];
      if (!t) return null;
      R[t.id] = { ...t, removedAt: op.at, unliked: false };
      delete T[t.id];
      return { track: t };
    }
    case 'restore': {
      const r = R[op.trackId];
      if (!r) return null;
      const t = unpack(r);
      delete R[t.id];
      const keep = r.mergedInto && T[r.mergedInto];
      if (keep) for (const k of STATS) keep[k] = Math.max(0, keep[k] - t[k]);
      T[t.id] = t;
      // once every merged-away version is back, the group is open again
      for (const [sig, x] of Object.entries(st.resolved)) {
        if ((x.type === 'merged' || x.type === 'removed') && x.removedIds.includes(t.id) && x.removedIds.every(id => !R[id])) delete st.resolved[sig];
      }
      return { track: t, unliked: !!r.unliked };
    }
    case 'markUnliked':
      for (const id of op.trackIds) if (R[id]) R[id].unliked = true;
      return null;
    case 'merge': {
      const keep = T[op.keepId];
      if (!keep) return null;
      const before = keep.rating;
      const gone = op.removeIds.map(id => T[id]).filter(Boolean);
      const games = keep.games + gone.reduce((n, s) => n + s.games, 0);
      // fight-weighted average: a version with no fights doesn't drag the rating toward 1500
      if (games > 0) keep.rating = (keep.rating * keep.games + gone.reduce((n, s) => n + s.rating * s.games, 0)) / games;
      for (const s of gone) {
        for (const k of STATS) keep[k] += s[k];
        R[s.id] = { ...s, removedAt: op.at, unliked: false, mergedInto: op.keepId };
        delete T[s.id];
      }
      const removedIds = gone.map(s => s.id);
      st.resolved[op.sig] = { type: 'merged', ids: op.sig.split(','), keepId: op.keepId, removedIds, ratingShift: keep.rating - before, at: op.at };
      return { removedIds };
    }
    case 'removeVersions': {
      const gone = op.removeIds.map(id => T[id]).filter(Boolean);
      for (const x of gone) {
        R[x.id] = { ...x, removedAt: op.at, unliked: false };
        delete T[x.id];
      }
      const removedIds = gone.map(x => x.id);
      st.resolved[op.sig] = { type: 'removed', ids: op.sig.split(','), keepId: op.keepId, removedIds, at: op.at };
      return { removedIds };
    }
    case 'distinct':
      st.resolved[op.sig] = { type: 'distinct', ids: op.sig.split(','), at: op.at };
      return null;
    case 'reopen':
      for (const sig of op.sigs) if (st.resolved[sig]?.type === 'distinct') delete st.resolved[sig];
      return null;
    case 'unresolve': {
      const r = st.resolved[op.sig];
      const relikeIds = [];
      if (!r) return { relikeIds };
      delete st.resolved[op.sig];
      if (r.type === 'merged') {
        const keep = T[r.keepId];
        for (const id of r.removedIds) {
          const gone = R[id];
          if (!gone || gone.mergedInto !== r.keepId) continue; // already put back from Settings
          const t = unpack(gone);
          if (keep) for (const k of STATS) keep[k] = Math.max(0, keep[k] - t[k]);
          if (gone.unliked) relikeIds.push(id);
          delete R[id];
          T[id] = t;
        }
        // undo the merge's rating change but keep whatever the song gained or lost in fights since
        if (keep) keep.rating -= r.ratingShift || 0;
      }
      if (r.type === 'removed') {
        for (const id of r.removedIds) {
          const gone = R[id];
          if (!gone || gone.mergedInto) continue; // already put back, or merged elsewhere since
          if (gone.unliked) relikeIds.push(id);
          delete R[id];
          T[id] = unpack(gone);
        }
      }
      return { relikeIds };
    }
    case 'import': {
      const seen = new Set(); let added = 0, removed = 0;
      for (const t of op.tracks) {
        seen.add(t.id);
        if (R[t.id]) continue; // removed here but not unliked in Spotify yet
        const old = T[t.id];
        if (old) Object.assign(old, {
          name: t.name, artists: t.artists, album: t.album, img: t.img || old.img, imgSm: t.imgSm || old.imgSm,
          isrc: t.isrc || old.isrc || '', released: t.released || old.released || '',
        });
        else { T[t.id] = { ...t, rating: START, games: 0, wins: 0, losses: 0, draws: 0 }; added++; }
      }
      if (op.removeMissing) {
        for (const id of Object.keys(T)) if (!seen.has(id)) { delete T[id]; removed++; }
        for (const [id, r] of Object.entries(R)) if (!seen.has(id)) r.unliked = true;
      }
      return { added, removed, total: Object.keys(T).length };
    }
    case 'cover': {
      const t = T[op.trackId];
      if (t) t.img = t.imgSm = op.url;
      return null;
    }
    case 'reset':
      for (const s of Object.values(T)) Object.assign(s, { rating: START, games: 0, wins: 0, losses: 0, draws: 0 });
      st.fights = 0;
      return null;
    case 'replace': {
      const n = migrate(structuredClone(op.state));
      Object.assign(st, { tracks: n.tracks || {}, fights: n.fights || 0, removed: n.removed, resolved: n.resolved });
      return null;
    }
    default:
      return null; // an action from a newer version of the site: skip it
  }
}

if (typeof module !== 'undefined') module.exports = { START, SCHEMA, MAX_BYTES, kFactor, expected, migrate, shareable, applyOp };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/*.test.js`
Expected: all 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add core.js tests/core.test.js
git -c user.name=Seezov -c user.email=Seezov@users.noreply.github.com commit -m "Add core.js: every ranking change as a replayable action

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `core.js` — replay, merge and the sync step

**Files:**
- Modify: `core.js` (append before the `module.exports` line, extend the export list)
- Create: `tests/sync.test.js`

**Interfaces:**
- Consumes: `applyOp`, `shareable`, `migrate`, `SCHEMA`, `MAX_BYTES` from Task 2.
- Produces:
  - `replay(base, ops) -> { state, effects }` — `state` is a deep copy of `shareable(base)` with all ops applied; `effects` maps op id → effect for ops that returned one.
  - `mergeRemote(remote, local) -> { next, write: boolean, v: number }` — `remote`: `null | { v, state }` (`state` may be `null` when `remote.v === local.v`); `local`: `{ v, state, ops }`.
  - `firstSyncAction(remoteExists: boolean, localHasSongs: boolean) -> 'none' | 'upload' | 'adopt' | 'ask'`
  - `summary(state) -> { songs: number, fights: number }`
  - `encodeState(state) -> Promise<Uint8Array>` (gzip JSON of `shareable(state)`), `decodeState(bytes) -> Promise<state>` (runs `migrate`)
  - `syncOnce(store, dev) -> Promise<effects>` — `store.transact(fn)`: runs `await fn(doc | null)` where `doc = { v, data: Uint8Array, schema }`; if `fn` returns a doc, the store writes it atomically. `dev = { meta: { v }, base, pending: op[], state }` is updated in place: `meta.v`, `base`, `pending` (ops added to `dev.pending` while the transaction ran stay), `state` (rebuilt; keeps `dev.state.history`). Throws `Error('SCHEMA')` or `Error('TOO_BIG')` without touching `dev`.

- [ ] **Step 1: Write the failing tests**

`tests/sync.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');
const { applyOp, replay, mergeRemote, firstSyncAction, summary, encodeState, decodeState, syncOnce, START, SCHEMA } = core;

const track = id => ({ id, name: 'Song ' + id, artists: 'A', album: '', img: '', imgSm: '', added: '', isrc: '', released: '', rating: START, games: 0, wins: 0, losses: 0, draws: 0 });
const fixture = (ids = ['a', 'b', 'c', 'd']) => ({ tracks: Object.fromEntries(ids.map(i => [i, track(i)])), fights: 0, history: [], removed: {}, resolved: {} });
let n = 0;
const op = (type, payload = {}) => ({ id: 'op' + (++n), type, at: '2026-10-07T12:00:00.000Z', ...payload });

// an in-memory stand-in for the Firestore document
function memoryStore(doc = null) {
  return {
    get doc() { return doc; },
    async transact(fn) { const w = await fn(doc && structuredClone(doc)); if (w) doc = w; },
  };
}
// a device that already agreed with the cloud at version v
function device(base, v) {
  return { meta: { v }, base: structuredClone(base), pending: [], state: { ...structuredClone(base), history: [] } };
}
// what the page's dispatch() does
function act(dev, o) { const e = applyOp(dev.state, o); dev.pending.push(o); return e; }

test('replay applies actions to a copy and reports effects', () => {
  const base = fixture();
  const f = op('fight', { a: 'a', b: 'b', score: 1 });
  const r = replay(base, [f, op('reset')]);
  assert.equal(base.fights, 0);
  assert.equal(r.state.fights, 0);
  assert.equal(r.state.history, undefined);
  assert.deepEqual(r.effects[f.id], { da: 24, db: -24 });
});

test('mergeRemote: same version writes local, newer remote replays local actions on it', () => {
  const local = { v: 3, state: fixture(), ops: [] };
  assert.deepEqual(mergeRemote({ v: 3, state: null }, local).write, false);
  const f = op('fight', { a: 'a', b: 'b', score: 1 });
  const remoteState = fixture(); remoteState.fights = 10;
  const m = mergeRemote({ v: 5, state: remoteState }, { v: 3, state: fixture(), ops: [f] });
  assert.equal(m.write, true);
  assert.equal(m.v, 5);
  assert.equal(m.next.fights, 11);
  assert.equal(mergeRemote(null, { v: 2, state: fixture(), ops: [] }).write, true);
});

test('firstSyncAction', () => {
  assert.equal(firstSyncAction(false, false), 'none');
  assert.equal(firstSyncAction(false, true), 'upload');
  assert.equal(firstSyncAction(true, false), 'adopt');
  assert.equal(firstSyncAction(true, true), 'ask');
  assert.deepEqual(summary({ ...fixture(), fights: 4 }), { songs: 4, fights: 4 });
});

test('encode/decode round trip, and 2 500 songs fit in a document', async () => {
  const s = fixture();
  assert.deepEqual(await decodeState(await encodeState({ ...s, history: [1] })), { tracks: s.tracks, fights: 0, removed: {}, resolved: {} });
  const big = fixture([]);
  const words = ['love', 'night', 'fire', 'dream', 'heart', 'city', 'blue', 'gold', 'run', 'home'];
  for (let i = 0; i < 2500; i++) {
    const id = i.toString(36).padStart(22, '0');
    big.tracks[id] = { ...track(id), name: `${words[i % 10]} ${words[(i * 7) % 10]} ${i}`, artists: `Artist ${i % 400}`, album: `Album ${i % 900}`,
      img: `https://i.scdn.co/image/ab67616d00001e02${id}`, imgSm: `https://i.scdn.co/image/ab67616d00004851${id}`, added: '2024-01-01T00:00:00Z',
      isrc: 'USRC1' + String(i).padStart(7, '0'), released: '2010-05-05', rating: 1400 + (i % 200), games: i % 20, wins: i % 11, losses: i % 9 };
  }
  const bytes = await encodeState(big);
  assert.ok(bytes.length < core.MAX_BYTES, `${bytes.length} bytes`);
});

test('two devices fight offline, both sync: every fight counts and both end equal', async () => {
  const start = fixture();
  const store = memoryStore({ v: 1, data: await encodeState(start), schema: SCHEMA });
  const A = device(start, 1), B = device(start, 1);
  act(A, op('fight', { a: 'a', b: 'b', score: 1 }));
  act(A, op('fight', { a: 'c', b: 'd', score: 0 }));
  act(B, op('fight', { a: 'a', b: 'c', score: 0.5 }));
  act(B, op('merge', { sig: 'b,d', keepId: 'b', removeIds: ['d'] }));
  await syncOnce(store, A);
  await syncOnce(store, B);
  await syncOnce(store, A); // A catches up with B
  assert.equal(store.doc.v, 3);
  assert.deepEqual(A.pending, []);
  assert.deepEqual(B.pending, []);
  assert.equal(B.state.fights, 3);
  assert.ok(B.state.removed.d);
  assert.deepEqual(core.shareable(A.state), core.shareable(B.state));
  assert.deepEqual(core.shareable(await decodeState(store.doc.data)), core.shareable(B.state));
});

test('remove on A + fight on B: the fight on the removed song is skipped', async () => {
  const start = fixture();
  const store = memoryStore({ v: 1, data: await encodeState(start), schema: SCHEMA });
  const A = device(start, 1), B = device(start, 1);
  act(A, op('remove', { trackId: 'a' }));
  act(B, op('fight', { a: 'a', b: 'b', score: 1 }));
  act(B, op('fight', { a: 'c', b: 'b', score: 1 }));
  await syncOnce(store, A);
  await syncOnce(store, B);
  assert.equal(B.state.fights, 1);
  assert.equal(B.state.tracks.a, undefined);
  assert.equal(B.state.tracks.b.games, 1);
});

test('replace on A, fights on B: the backup wins, B\'s fights land on top', async () => {
  const start = fixture();
  const store = memoryStore({ v: 1, data: await encodeState(start), schema: SCHEMA });
  const A = device(start, 1), B = device(start, 1);
  const backup = fixture(['a', 'b']); backup.fights = 50;
  act(A, op('replace', { state: backup }));
  act(B, op('fight', { a: 'a', b: 'b', score: 1 }));
  act(B, op('fight', { a: 'c', b: 'd', score: 1 }));
  await syncOnce(store, A);
  await syncOnce(store, B);
  assert.deepEqual(Object.keys(B.state.tracks).sort(), ['a', 'b']);
  assert.equal(B.state.fights, 51);
});

test('action made during a sync is kept', async () => {
  const start = fixture();
  const inner = memoryStore({ v: 1, data: await encodeState(start), schema: SCHEMA });
  const A = device(start, 1);
  act(A, op('fight', { a: 'a', b: 'b', score: 1 }));
  const late = op('fight', { a: 'c', b: 'd', score: 1 });
  const store = { async transact(fn) { await inner.transact(async d => { act(A, late); return fn(d); }); } };
  await syncOnce(store, A);
  assert.deepEqual(A.pending.map(o => o.id), [late.id]);
  assert.equal(A.state.fights, 2);
  assert.equal(A.base.fights, 1);
  assert.equal(A.meta.v, 2);
});

test('nothing to send and nothing new: no write', async () => {
  const start = fixture();
  const store = memoryStore({ v: 4, data: await encodeState(start), schema: SCHEMA });
  const A = device(start, 4);
  A.state.history = [{ opId: 'x' }];
  await syncOnce(store, A);
  assert.equal(store.doc.v, 4);
  assert.deepEqual(A.state.history, [{ opId: 'x' }]);
});

test('empty cloud: first sync writes version 1', async () => {
  const store = memoryStore(null);
  const A = device(fixture(), 0);
  await syncOnce(store, A);
  assert.equal(store.doc.v, 1);
  assert.equal(A.meta.v, 1);
});

test('newer schema stops sync', async () => {
  const start = fixture();
  const store = memoryStore({ v: 2, data: await encodeState(start), schema: SCHEMA + 1 });
  const A = device(start, 1);
  act(A, op('fight', { a: 'a', b: 'b', score: 1 }));
  await assert.rejects(syncOnce(store, A), /SCHEMA/);
  assert.equal(A.pending.length, 1);
  assert.equal(A.meta.v, 1);
});

test('too large state is not written', async () => {
  const start = fixture();
  const store = memoryStore({ v: 1, data: await encodeState(start), schema: SCHEMA });
  const A = device(start, 1);
  // random text does not compress, so this is well over the limit
  const noise = Array.from({ length: 2000 }, (_, i) => Array.from({ length: 1000 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join(''));
  act(A, op('import', { tracks: noise.map((name, i) => ({ id: 'n' + i, name, artists: '', album: '' })), removeMissing: false }));
  await assert.rejects(syncOnce(store, A), /TOO_BIG/);
  assert.equal(store.doc.v, 1);
  assert.equal(A.pending.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/*.test.js`
Expected: `tests/core.test.js` passes, `tests/sync.test.js` FAILS — `replay is not a function`.

- [ ] **Step 3: Append the sync functions to `core.js`**

Insert before the `if (typeof module ...` line:

```js
/* ---------- sync ---------- */
function replay(base, ops) {
  const state = structuredClone(shareable(base));
  const effects = {};
  for (const o of ops) { const e = applyOp(state, o); if (e) effects[o.id] = e; }
  return { state, effects };
}

// remote: null (no document) or {v, state}; state is only needed when the cloud moved on.
// local: {v: version our base came from, state: base + ops, ops: actions not uploaded yet}
function mergeRemote(remote, local) {
  if (!remote) return { next: shareable(local.state), write: true, v: 0 };
  if (remote.v === local.v) return { next: shareable(local.state), write: local.ops.length > 0, v: remote.v };
  return { next: replay(remote.state, local.ops).state, write: local.ops.length > 0, v: remote.v };
}

function firstSyncAction(remoteExists, localHasSongs) {
  if (!remoteExists) return localHasSongs ? 'upload' : 'none';
  return localHasSongs ? 'ask' : 'adopt';
}

const summary = st => ({ songs: Object.keys(st.tracks).length, fights: st.fights });

async function encodeState(st) {
  const stream = new Blob([JSON.stringify(shareable(st))]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function decodeState(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return migrate(JSON.parse(await new Response(stream).text()));
}

// One round trip with the cloud. store.transact(fn) runs fn(doc|null) atomically and writes the
// doc fn returns, if any. dev = {meta: {v}, base, pending, state} is updated in place; actions
// pushed to dev.pending while the transaction runs stay pending.
async function syncOnce(store, dev) {
  const n = dev.pending.length;
  const local = { v: dev.meta.v, state: structuredClone(shareable(dev.state)), ops: dev.pending.slice(0, n) };
  let res;
  await store.transact(async doc => {
    if (doc && doc.schema > SCHEMA) throw new Error('SCHEMA');
    const remote = doc && { v: doc.v, state: doc.v === local.v ? null : await decodeState(doc.data) };
    res = mergeRemote(remote, local);
    if (!res.write) return null;
    const data = await encodeState(res.next);
    if (data.length > MAX_BYTES) throw new Error('TOO_BIG');
    return { v: res.v + 1, data, schema: SCHEMA };
  });
  dev.meta.v = res.write ? res.v + 1 : res.v;
  dev.base = res.next;
  dev.pending = dev.pending.slice(n);
  const r = replay(dev.base, dev.pending);
  dev.state = Object.assign(r.state, { history: dev.state.history });
  return r.effects;
}
```

Replace the export line with:

```js
if (typeof module !== 'undefined') module.exports = {
  START, SCHEMA, MAX_BYTES, kFactor, expected, migrate, shareable, applyOp,
  replay, mergeRemote, firstSyncAction, summary, encodeState, decodeState, syncOnce,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/*.test.js`
Expected: all tests in both files PASS.

- [ ] **Step 5: Commit**

```bash
git add core.js tests/sync.test.js
git -c user.name=Seezov -c user.email=Seezov@users.noreply.github.com commit -m "core.js: replay, merge and one-step sync against a document store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Page uses actions for every change (still local-only)

All behaviour stays the same for a user who never signs in; afterwards every mutation goes through `dispatch(op)`.

**Files:**
- Modify: `index.html` (script section; line numbers below are from commit `d1c85bb` and shift as you edit — find by the quoted code)
- Create: `tests/smoke.py`

**Interfaces:**
- Consumes: everything exported by `core.js` (as browser globals).
- Produces (page globals used by Task 5):
  - `let pending: op[]`, `let base: state | null`, `let syncMeta: { uid, v } | null` (from `sfn.pending`, `sfn.base`, `sfn.sync`)
  - `op(type, payload) -> op`
  - `dispatch(o) -> effect` — applies to `state`, appends to `pending` when `syncMeta` is set, saves, calls `scheduleSync()`
  - `let scheduleSync = () => {}` — replaced in Task 5
  - `saveSync()` — writes `syncMeta`, `base`, `pending` to localStorage (deletes the keys when `syncMeta` is null)
  - `rebuild()` — `state = replay(base, pending)` keeping `state.history`, refreshes `da/db` of fight history entries from the effects, saves
  - `pushHistory(entry)`; history entries: `{ opId, type: 'fight', a, b, score, da, db }` or `{ opId, type: 'remove', trackId, pair }`

- [ ] **Step 1: Write the failing smoke test**

`tests/smoke.py`:

```python
"""Headless smoke test of the real page: plays a fight and removes a song, then undoes both."""
import json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'

def track(i):
    return dict(id=f't{i}', name=f'Song {i}', artists='Artist', album='', img='x', imgSm='x', added='', isrc='',
                released='', rating=1500, games=0, wins=0, losses=0, draws=0)

state = dict(tracks={t['id']: t for t in map(track, range(4))}, fights=0, history=[], removed={}, resolved={})
SEED = "<script>localStorage.clear();localStorage.setItem('sfn.state', %s);</script>" % json.dumps(json.dumps(state))
PROBE = """<script>setTimeout(() => {
  const r = {};
  decide(1);
  r.fightsAfterPick = state.fights;
  r.historyType = state.history.at(-1).type;
  r.opIdIsSet = !!state.history.at(-1).opId;
  busy = false;
  undo();
  r.fightsAfterUndo = state.fights;
  r.allBackTo1500 = Object.values(state.tracks).every(t => t.rating === 1500 && t.games === 0);
  current = current || nextPair();
  const gone = current[0];
  removeSong('a');
  r.removed = !state.tracks[gone] && !!state.removed[gone];
  undo();
  r.restored = !!state.tracks[gone] && !state.removed[gone];
  r.pendingWhenSignedOut = pending.length;
  document.title = 'RESULT ' + JSON.stringify(r);
}, 800);</script></body>"""

tmp = tempfile.mkdtemp()
try:
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    html = html.replace('<head>', '<head>' + SEED, 1).replace('</body>', PROBE, 1)
    open(os.path.join(tmp, 'index.html'), 'w', encoding='utf-8').write(html)
    shutil.copy(os.path.join(ROOT, 'core.js'), tmp)
    out = subprocess.run([CHROME, '--headless=new', '--disable-gpu', f'--user-data-dir={tmp}/profile',
                          '--virtual-time-budget=5000', '--dump-dom', 'file:///' + tmp.replace('\\', '/') + '/index.html'],
                         capture_output=True, text=True, encoding='utf-8', timeout=120).stdout
    title = out.split('<title>', 1)[1].split('</title>', 1)[0]
    assert title.startswith('RESULT '), title
    r = json.loads(title[7:].replace('&quot;', '"'))
    expected = dict(fightsAfterPick=1, historyType='fight', opIdIsSet=True, fightsAfterUndo=0, allBackTo1500=True,
                    removed=True, restored=True, pendingWhenSignedOut=0)
    assert r == expected, f'{r} != {expected}'
    print('smoke OK', r)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python tests/smoke.py`
Expected: FAIL — `AssertionError` (`opIdIsSet` false / `historyType` missing, `pending` is not defined).

- [ ] **Step 3: Load `core.js` and remove the duplicated definitions from `index.html`**

Directly before the existing `<script>` that starts with `/* ====... Storage`, add:

```html
<script src="core.js"></script>
```

Delete from `index.html`: `const START = 1500;`, the whole `function migrate(st) { ... }` (with its `// resolved: ...` comment line above it), `const kFactor = ...`, `const expected = ...`. Keep the line `migrate(state);` (it now calls the core version).

- [ ] **Step 4: Add the action plumbing after `const list = () => Object.values(state.tracks);`**

```js
// undo entries from before the action log were state snapshots; they can't be undone as actions
state.history = (state.history || []).filter(h => h.opId);

/* ---------- actions and the local side of sync ---------- */
// syncMeta {uid, v}: whose cloud copy base is, and which version. null = not signed in.
let syncMeta = LS.get('sfn.sync', null);
let base = LS.get('sfn.base', null);
let pending = LS.get('sfn.pending', []);
let scheduleSync = () => {}; // replaced by the cloud code once it's loaded

const op = (type, payload = {}) => ({ id: randomString(12), type, at: new Date().toISOString(), ...payload });

function dispatch(o) {
  const effect = applyOp(state, o);
  if (syncMeta) { pending.push(o); LS.set('sfn.pending', pending); scheduleSync(); }
  save();
  return effect;
}

function saveSync() {
  if (!syncMeta) { for (const k of ['sfn.sync', 'sfn.base', 'sfn.pending']) LS.del(k); return; }
  LS.set('sfn.sync', syncMeta); LS.set('sfn.base', base); LS.set('sfn.pending', pending);
}

// state = base + pending, keeping this device's undo stack
function rebuild() {
  const history = state.history;
  const r = replay(base, pending);
  state = Object.assign(r.state, { history });
  for (const h of history) if (h.type === 'fight' && r.effects[h.opId]) Object.assign(h, r.effects[h.opId]);
  save();
}

function pushHistory(h) {
  state.history.push(h);
  if (state.history.length > 200) state.history.shift();
  save();
}
```

- [ ] **Step 5: Route imports through `import` actions**

In `importCSV`, replace `return merge(tracks, false);` with:

```js
  return dispatch(op('import', { tracks, removeMissing: false }));
```

In `syncLiked`, replace `return merge(fetched, true);` with:

```js
  return dispatch(op('import', { tracks: fetched, removeMissing: true }));
```

Delete the whole `function merge(incoming, removeMissing) { ... }`.

- [ ] **Step 6: Fights and undo**

Delete the whole `function applyResult(a, b, scoreA) { ... }`. Replace the whole `function undo() { ... }` with:

```js
function undo() {
  const h = state.history.pop();
  if (!h) { toast('Nothing to undo'); return; }
  const before = h.type === 'remove' ? state.removed[h.trackId] : null;
  if (pending.some(o => o.id === h.opId)) {
    // not uploaded yet: just forget the action
    pending = pending.filter(o => o.id !== h.opId);
    saveSync();
    rebuild();
  } else if (h.type === 'fight') dispatch(op('unfight', { a: h.a, b: h.b, score: h.score, da: h.da, db: h.db }));
  else dispatch(op('restore', { trackId: h.trackId }));
  save();
  if (h.type === 'remove') {
    current = h.pair.every(id => state.tracks[id]) ? h.pair : nextPair();
    renderFight();
    const name = before ? before.name : 'the song';
    if (before?.unliked) relike([h.trackId], `Put "${name}" back and liked it again in Spotify`,
      `Put "${name}" back in the ranking, but liking it again in Spotify failed. Like it there, or the next sync will remove it.`);
    else toast(`Put "${name}" back`);
    return;
  }
  current = state.tracks[h.a] && state.tracks[h.b] ? [h.a, h.b] : nextPair();
  renderFight();
  toast('Last fight undone');
}
```

In `decide(scoreA)`, replace the two lines

```js
  const a = state.tracks[current[0]], b = state.tracks[current[1]];
  const { da, db } = applyResult(a, b, scoreA);
```

with:

```js
  const o = op('fight', { a: current[0], b: current[1], score: scoreA });
  const { da, db } = dispatch(o);
  pushHistory({ opId: o.id, type: 'fight', a: o.a, b: o.b, score: scoreA, da, db });
```

- [ ] **Step 7: Removing, restoring, unliking**

In `removeSong`, replace

```js
  state.removed[t.id] = { ...t, removedAt: new Date().toISOString(), unliked: false };
  delete state.tracks[t.id];
  state.history.push({ removed: state.removed[t.id], pair: [...current] });
  if (state.history.length > 200) state.history.shift();
  save();
```

with:

```js
  const o = op('remove', { trackId: t.id });
  dispatch(o);
  pushHistory({ opId: o.id, type: 'remove', trackId: t.id, pair: [...current] });
```

Replace the body of `unlikeInSpotify`'s batch callback:

```js
const unlikeInSpotify = ids => libraryRequest('DELETE', ids, chunk => dispatch(op('markUnliked', { trackIds: chunk })));
```

Replace the whole `function restoreSong(id) { ... }` with:

```js
function restoreSong(id) {
  const r = dispatch(op('restore', { trackId: id }));
  renderRemoved();
  if (!r) return;
  if (r.unliked) relike([id], `Put "${r.track.name}" back and liked it again in Spotify`,
    `Put "${r.track.name}" back in the ranking, but liking it again in Spotify failed. Like it there, or the next sync will remove it.`);
  else toast(`Put "${r.track.name}" back in the ranking`);
}
```

- [ ] **Step 8: Duplicates**

In `renderDupes`, replace

```js
  for (const [sig, r] of Object.entries(state.resolved)) {
    if (r.type === 'distinct' && open.some(g => r.ids.every(id => g.sig.split(',').includes(id)))) delete state.resolved[sig];
  }
  save();
```

with:

```js
  const reopened = Object.entries(state.resolved)
    .filter(([, r]) => r.type === 'distinct' && open.some(g => r.ids.every(id => g.sig.split(',').includes(id))))
    .map(([sig]) => sig);
  if (reopened.length) dispatch(op('reopen', { sigs: reopened }));
```

Replace the whole `function unresolve(sig) { ... }` with:

```js
function unresolve(sig) {
  const { relikeIds } = dispatch(op('unresolve', { sig }));
  renderDupes();
  const n = relikeIds.length;
  relike(relikeIds, n ? `Unresolved, and liked ${n} version${n > 1 ? 's' : ''} again in Spotify` : 'Unresolved. The group is open again.',
    `Unresolved, but liking ${n > 1 ? 'them' : 'it'} again in Spotify failed. Like ${n > 1 ? 'them' : 'it'} there, or the next sync will remove ${n > 1 ? 'them' : 'it'}.`);
}
```

Replace the whole `async function mergeDupes(...) { ... }` and `async function removeVersions(...) { ... }` with:

```js
async function mergeDupes(sig, keepId, removeIds) {
  return resolveVersions(op('merge', { sig, keepId, removeIds }));
}
async function removeVersions(sig, keepId, removeIds) {
  return resolveVersions(op('removeVersions', { sig, keepId, removeIds }));
}
// true when the removed versions were also unliked in Spotify
async function resolveVersions(o) {
  const r = dispatch(o);
  if (current && current.some(id => !state.tracks[id])) current = null;
  if (!r || !r.removedIds.length) return false;
  if (await accessToken()) { try { await unlikeInSpotify(r.removedIds); return true; } catch {} }
  return false;
}
```

In the `$('dupes-list').onclick` handler, replace

```js
    state.resolved[g.dataset.sig] = { type: 'distinct', ids: g.dataset.sig.split(','), at: new Date().toISOString() }; save();
```

with:

```js
    dispatch(op('distinct', { sig: g.dataset.sig }));
```

- [ ] **Step 9: Covers, reset, restore backup**

In `fetchCover`, replace

```js
    if (url && state.tracks[s.id]) { state.tracks[s.id].img = state.tracks[s.id].imgSm = url; save(); }
```

with:

```js
    if (url && state.tracks[s.id] && state.tracks[s.id].img !== url) dispatch(op('cover', { trackId: s.id, url }));
```

Replace the `$('reset').onclick` handler with:

```js
$('reset').onclick = () => {
  if (!confirm('Reset every rating to 1500 and clear fight history?')) return;
  dispatch(op('reset'));
  state.history = []; save(); current = null; toast('Ratings reset'); show('fight');
};
```

In the `$('restore').onchange = $('restore-setup').onchange` handler replace

```js
    state = migrate({ tracks: s.tracks, fights: s.fights || 0, history: s.history || [], removed: s.removed, resolved: s.resolved, notDupes: s.notDupes });
    save(); current = null; toast('Backup restored'); show('ranks');
```

with:

```js
    dispatch(op('replace', { state: { tracks: s.tracks, fights: s.fights || 0, removed: s.removed || {}, resolved: s.resolved || {}, notDupes: s.notDupes } }));
    state.history = []; save(); current = null; toast('Backup restored'); show('ranks');
```

- [ ] **Step 10: Run all tests**

Run: `node --test tests/*.test.js && python tests/smoke.py`
Expected: node tests PASS; smoke prints `smoke OK {...}`.

Also run `grep -n "state\.\(tracks\|removed\|resolved\)\[[^]]*\] *=[^=]\|delete state\.\|state\.fights *[-+=]" index.html` — expected: no matches (every mutation goes through `dispatch`).

- [ ] **Step 11: Manual check in a browser**

Run `python serve.py`, open http://127.0.0.1:8888/ (your real data is there): play a few fights, Undo, remove a song and Undo, open Duplicates, open Rankings. Everything behaves as before and the counts are right.

- [ ] **Step 12: Commit**

```bash
git add index.html tests/smoke.py
git -c user.name=Seezov -c user.email=Seezov@users.noreply.github.com commit -m "Route every ranking change through actions from core.js

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Cloud sync engine and UI

**Files:**
- Modify: `index.html` (HTML: header, setup, settings, a dialog; CSS; script)

**Interfaces:**
- Consumes: `syncOnce`, `decodeState`, `firstSyncAction`, `summary`, `shareable`, `SCHEMA` (core); `dispatch`, `op`, `pending`, `base`, `syncMeta`, `saveSync`, `rebuild`, `scheduleSync` (Task 4); the `firebaseConfig` object from Task 1.
- Produces: `signIn()`, `signOutCloud()`, `syncNow()`, `setCloudStatus(status, message?)`, `renderAccount()`.

- [ ] **Step 1: Markup**

In `<header>`, right after `<h1 class="brand">…</h1>`:

```html
  <span id="sync-ind" class="sync-ind hidden" role="status"></span>
```

In the setup section, right after the "Or restore a backup" `.option` block:

```html
    <div class="option">
      <h3>Already ranking on another device?</h3>
      <p>Sign in with the same Google account to bring your songs and ratings here.</p>
      <button class="btn" id="sign-in-setup">Sign in with Google</button>
    </div>
```

In the settings section, right after `<h2>Settings</h2>`:

```html
    <div class="option" id="account">
      <h3>Account</h3>
      <div id="account-out">
        <p>Sign in to keep your songs and ratings in sync on your phone and computer.</p>
        <button class="btn" id="sign-in">Sign in with Google</button>
      </div>
      <div id="account-in" class="hidden">
        <p>Signed in as <b id="account-email"></b>. <span id="account-status"></span></p>
        <div class="row">
          <button class="btn ghost" id="sync-now">Sync now</button>
          <button class="btn ghost" id="sign-out">Sign out</button>
        </div>
      </div>
    </div>
```

Right before `<div class="toast" id="toast" role="status"></div>`:

```html
<dialog id="first-sync" class="dialog">
  <form method="dialog">
    <h3>Which ratings should this account keep?</h3>
    <p>Your account already has songs in the cloud, and this device has its own. Pick one; the other is replaced on every device.</p>
    <button class="btn" value="adopt">Keep the cloud data <span id="fs-cloud"></span></button>
    <button class="btn ghost" value="upload">Use this device's data <span id="fs-local"></span></button>
    <button class="btn ghost" value="cancel">Cancel and sign out</button>
  </form>
</dialog>
```

- [ ] **Step 2: CSS**

Add after the `nav button:hover` rule:

```css
.sync-ind { font-size: 13px; color: var(--muted); white-space: nowrap; }
.sync-ind[data-state="offline"], .sync-ind[data-state="error"] { color: var(--gold); }
.dialog {
  background: var(--bg-2); color: var(--text); border: 1px solid var(--line); border-radius: 14px;
  padding: 24px; max-width: 440px; width: calc(100% - 32px);
}
.dialog::backdrop { background: rgba(0, 0, 0, .6); }
.dialog h3 { margin: 0 0 8px; font-size: 20px; }
.dialog p { color: var(--muted); margin: 0 0 16px; }
.dialog .btn { display: block; width: 100%; margin-top: 8px; text-align: left; }
.dialog .btn span { font-weight: 400; opacity: .75; }
```

- [ ] **Step 3: The sync engine**

Add this block to the script right after the `/* ---------- full-song playback ---------- */` section's `playFull` function (before `async function removeSong`):

```js
/* ---------- cloud sync (Firebase) ----------
   See docs/superpowers/specs/2026-10-07-cross-device-sync-design.md. Firebase loads only once
   someone signs in. One Firestore document per Google account holds the gzipped state. */
const FIREBASE_CONFIG = /* the firebaseConfig object from Task 1, pasted verbatim */;
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
const cloud = { user: null, fs: null, auth: null, authM: null, db: null, ref: null, unwatch: null, timer: null, syncing: false, again: false, lastSync: 0, error: '' };
const deviceName = () => (navigator.userAgent.match(/Android|iPhone|iPad|Windows|Mac|Linux/) || ['Browser'])[0];

async function loadCloud() {
  if (cloud.fs) return;
  const [appM, authM, fs] = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => import(FIREBASE_SDK + f)));
  const app = appM.initializeApp(FIREBASE_CONFIG);
  Object.assign(cloud, { authM, fs, auth: authM.getAuth(app), db: fs.getFirestore(app) });
  authM.onAuthStateChanged(cloud.auth, onUser);
}

// the Firestore document behind syncOnce (core.js)
const firestoreStore = {
  transact: fn => cloud.fs.runTransaction(cloud.db, async tx => {
    const snap = await tx.get(cloud.ref);
    const d = snap.exists() ? snap.data() : null;
    const w = await fn(d && { v: d.v, schema: d.schema, data: d.data.toUint8Array() });
    if (w) tx.set(cloud.ref, { ...w, data: cloud.fs.Bytes.fromUint8Array(w.data), updatedAt: cloud.fs.serverTimestamp(), device: deviceName() });
  }),
};

async function signIn() {
  try {
    await loadCloud();
    await cloud.authM.signInWithPopup(cloud.auth, new cloud.authM.GoogleAuthProvider());
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    toast(e.code === 'auth/popup-blocked' ? 'The sign-in window was blocked. Allow pop-ups for this site and try again.'
      : 'Sign-in failed: ' + (e.code || e.message));
  }
}

async function onUser(user) {
  cloud.unwatch?.(); cloud.unwatch = null;
  cloud.user = user;
  if (!user) {
    // syncMeta still set means the session ended without Sign out: keep queueing, ask to sign in
    if (syncMeta) setCloudStatus('error', 'Signed out. Sign in again to keep syncing.'); else setCloudStatus('off');
    return;
  }
  cloud.ref = cloud.fs.doc(cloud.db, 'users', user.uid);
  await syncNow();
  cloud.unwatch = cloud.fs.onSnapshot(cloud.ref, onRemote, () => setCloudStatus('error', 'Lost the live connection to the cloud'));
  renderAccount();
}

// first sign-in on this device (or another account): decide whose data wins
async function firstSync() {
  const snap = await cloud.fs.getDoc(cloud.ref);
  const d = snap.exists() ? snap.data() : null;
  if (d && d.schema > SCHEMA) throw new Error('SCHEMA');
  const remote = d && await decodeState(d.data.toUint8Array());
  let choice = firstSyncAction(!!d, list().length > 0);
  if (choice === 'ask') choice = await askWhichData(summary(remote), summary(state));
  if (choice === 'cancel') { await signOutCloud(); return; }
  const uid = cloud.user.uid;
  if (choice === 'adopt') {
    syncMeta = { uid, v: d.v }; base = remote; pending = []; state.history = [];
  } else if (choice === 'upload') {
    // cloud copy (or nothing) as the base, plus one action that swaps in this device's data
    syncMeta = { uid, v: d ? d.v : 0 }; base = remote || { tracks: {}, fights: 0, removed: {}, resolved: {} };
    pending = [op('replace', { state: structuredClone(shareable(state)) })];
  } else {
    syncMeta = { uid, v: 0 }; base = structuredClone(shareable(state)); pending = [];
  }
  saveSync(); rebuild(); refreshAfterSync();
  if (pending.length) cloud.again = true; // upload right after this sync round
}

function askWhichData(cloudSum, localSum) {
  const d = $('first-sync');
  const fmt = s => `(${s.songs} songs, ${s.fights} fights)`;
  $('fs-cloud').textContent = fmt(cloudSum);
  $('fs-local').textContent = fmt(localSum);
  d.returnValue = '';
  d.showModal();
  return new Promise(res => { d.onclose = () => res(d.returnValue === 'adopt' || d.returnValue === 'upload' ? d.returnValue : 'cancel'); });
}

async function syncNow() {
  if (!cloud.user) return;
  if (cloud.syncing) { cloud.again = true; return; }
  cloud.syncing = true;
  clearTimeout(cloud.timer);
  setCloudStatus('syncing');
  try {
    if (!syncMeta || syncMeta.uid !== cloud.user.uid) await firstSync();
    else {
      const dev = { meta: syncMeta, base, pending, state };
      const effects = await syncOnce(firestoreStore, dev);
      ({ meta: syncMeta, base, pending, state } = dev);
      for (const h of state.history) if (h.type === 'fight' && effects[h.opId]) Object.assign(h, effects[h.opId]);
      save(); saveSync(); refreshAfterSync();
    }
    if (cloud.user) { cloud.lastSync = Date.now(); setCloudStatus(pending.length ? 'syncing' : 'synced'); }
  } catch (e) {
    if (e.message === 'TOO_BIG') setCloudStatus('error', 'Your data is too large to sync. It is still saved on this device.');
    else if (e.message === 'SCHEMA') setCloudStatus('error', 'A newer version of this site wrote your data. Reload the page.');
    else if (e instanceof SyntaxError || /gzip|incorrect header|decompress/i.test(e.message)) setCloudStatus('error', 'The cloud copy is unreadable. Nothing was changed here.');
    else setCloudStatus(navigator.onLine ? 'error' : 'offline', e.code || e.message);
  }
  cloud.syncing = false;
  if (cloud.again) { cloud.again = false; syncNow(); }
}

// another device wrote a newer version
async function onRemote(snap) {
  if (snap.metadata.hasPendingWrites || !snap.exists() || !syncMeta || cloud.syncing) return;
  const d = snap.data();
  if (d.v <= syncMeta.v) return;
  if (pending.length) { syncNow(); return; }
  let remote;
  try { remote = await decodeState(d.data.toUint8Array()); }
  catch { setCloudStatus('error', 'The cloud copy is unreadable. Nothing was changed here.'); return; }
  if (pending.length || cloud.syncing || d.v <= syncMeta.v) { syncNow(); return; } // something happened while decoding
  syncMeta.v = d.v; base = remote;
  saveSync(); rebuild(); refreshAfterSync();
  cloud.lastSync = Date.now(); setCloudStatus('synced');
}

// redraw whatever is on screen with the new state
function refreshAfterSync() {
  if (busy) { setTimeout(refreshAfterSync, 300); return; }
  if (current && current.some(id => !state.tracks[id])) current = null;
  if (view === 'fight' && current && list().length >= 2) renderFight();
  else show(view);
}

async function signOutCloud() {
  if (pending.length && cloud.user && !cloud.syncing) await syncNow(); // best effort
  cloud.unwatch?.(); cloud.unwatch = null;
  syncMeta = null; base = null; pending = [];
  saveSync();
  if (cloud.auth) await cloud.authM.signOut(cloud.auth); // onUser(null) sets the status
  else setCloudStatus('off');
}

function setCloudStatus(status, message = '') {
  cloud.error = status === 'error' || status === 'offline' ? message : '';
  const el = $('sync-ind');
  el.dataset.state = status;
  el.textContent = { off: '', syncing: 'Syncing…', synced: 'Synced', offline: `Offline · ${pending.length} pending`, error: 'Sync error' }[status];
  el.title = message || el.textContent;
  el.classList.toggle('hidden', status === 'off');
  renderAccount();
}

function renderAccount() {
  const u = cloud.user;
  $('account-out').classList.toggle('hidden', !!u);
  $('account-in').classList.toggle('hidden', !u);
  if (!u) return;
  $('account-email').textContent = u.email;
  $('account-status').textContent = cloud.error || (cloud.lastSync ? 'Last synced at ' + new Date(cloud.lastSync).toLocaleTimeString() + '.' : '');
}

scheduleSync = () => {
  if (!cloud.user) return;
  setCloudStatus('syncing');
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(syncNow, 5000);
};
```

In `undo()` (from Task 4), change the condition `if (pending.some(o => o.id === h.opId)) {` to:

```js
  if (!cloud.syncing && pending.some(o => o.id === h.opId)) {
```

so an undo during a running sync becomes a reverse action instead of rebuilding the state under the transaction.

Then replace `/* the firebaseConfig object from Task 1, pasted verbatim */` with the actual object from Task 1, e.g. `{ apiKey: '…', authDomain: 'songsrank.firebaseapp.com', projectId: 'songsrank', storageBucket: '…', messagingSenderId: '…', appId: '…' }` with the real values.

- [ ] **Step 4: Wiring and triggers**

In the `/* ---------- wiring ---------- */` section add:

```js
$('sign-in').onclick = $('sign-in-setup').onclick = signIn;
$('sign-out').onclick = () => signOutCloud();
$('sync-now').onclick = () => syncNow();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' || pending.length) syncNow();
});
addEventListener('online', () => { if (syncMeta && !cloud.fs) loadCloud().catch(() => {}); else syncNow(); });
addEventListener('offline', () => { if (cloud.user) setCloudStatus('offline'); });
setInterval(() => { if (pending.length && document.visibilityState === 'visible') syncNow(); }, 60000);
```

Replace the `$('reset').onclick` confirm text line with:

```js
  if (!confirm(syncMeta ? 'Reset every rating to 1500 on all your signed-in devices?' : 'Reset every rating to 1500 and clear fight history?')) return;
```

At the top of the restore-backup handler's `try {`, after `if (!s || typeof s.tracks !== 'object') throw 0;`, add:

```js
    if (syncMeta && !confirm('This replaces your songs and ratings on all your signed-in devices. Continue?')) return;
```

Replace the `$('wipe').onclick` handler with:

```js
$('wipe').onclick = async () => {
  if (!confirm(syncMeta ? 'Remove all songs, ratings and your Spotify login from this browser? You will be signed out; your cloud copy stays.'
    : 'Remove all songs, ratings and your Spotify login from this browser?')) return;
  if (syncMeta) await signOutCloud();
  state = { tracks: {}, fights: 0, history: [], removed: {}, resolved: {} }; save(); LS.del('sfn.token'); current = null; show('fight');
};
```

In `show(v)`, extend the settings line so the Account block is current:

```js
  if (v === 'settings') { $('client-id-2').value = LS.get('sfn.clientId', ''); $('sync').disabled = !LS.get('sfn.clientId', ''); renderRemoved(); renderAccount(); }
```

In the boot IIFE, right after `show('fight');`, add:

```js
  if (syncMeta) { setCloudStatus('syncing'); loadCloud().catch(() => setCloudStatus('offline')); }
```

- [ ] **Step 5: Run the automated tests**

Run: `node --test tests/*.test.js && python tests/smoke.py`
Expected: PASS (the page still works signed out; `pendingWhenSignedOut` is 0).

- [ ] **Step 6: Manual check on the PC**

`python serve.py`, open http://127.0.0.1:8888/ → Settings → Sign in with Google → the popup signs in → indicator shows "Synced"; Firestore console → Data shows `users/<uid>` with `v: 1`, `schema: 1`, `device: "Windows"`. Play a fight → "Syncing…" → about 5 s later "Synced" and `v: 2` in the console. Undo → `v: 3`. Reload the page → still signed in, same counts.

- [ ] **Step 7: Commit**

```bash
git add index.html
git -c user.name=Seezov -c user.email=Seezov@users.noreply.github.com commit -m "Sync songs and ratings across devices with Firebase

Google sign-in, one gzipped Firestore document per account, actions
replayed over newer cloud versions, live updates, offline queue.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Ship and verify on both devices

**Files:** none (deploy + verification)

- [ ] **Step 1: Push**

```bash
export GH_TOKEN=$(gh auth token -u Seezov)
git push "https://x-access-token:$GH_TOKEN@github.com/Seezov/Songsrank.git" main
```

Wait for Pages: `curl -s "https://seezov.github.io/Songsrank/core.js?v=$RANDOM" | grep -c syncOnce` prints `1` (retry every 15 s, up to 3 min).

- [ ] **Step 2: Phone joins the account**

On the phone open https://seezov.github.io/Songsrank/ → Settings → Sign in with Google (same account as the PC). The phone already has its own songs, so the "Which ratings should this account keep?" dialog appears: pick the side with more fights. Both devices now show the same fight count.

- [ ] **Step 3: Live update**

With both open, play a fight on the phone → within ~10 s the PC's fight counter goes up without a reload.

- [ ] **Step 4: Offline merge**

Phone in airplane mode → play 3 fights (indicator: "Offline · 3 pending"). On the PC play 2 fights. Turn airplane mode off → phone syncs; both devices show the previous count + 5.

- [ ] **Step 5: Undo and restore-backup**

Undo on the PC after it synced → the other device's count drops by one. Settings → Download backup on the phone, Restore backup on the PC (confirm the "all your signed-in devices" prompt) → the phone follows.

- [ ] **Step 6: Update the project memory**

Append to `C:\Users\user\.claude\projects\C--Users-user\memory\song-fight-night-app.md`: sync shipped (date), Firebase project `songsrank`, `core.js` holds actions and sync logic, tests `node --test tests/*.test.js` + `python tests/smoke.py`.

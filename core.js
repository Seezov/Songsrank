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

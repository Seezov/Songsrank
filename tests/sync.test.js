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
  const B_first = op('fight', { a: 'a', b: 'b', score: 1 }), B_second = op('fight', { a: 'c', b: 'b', score: 1 });
  act(B, B_first);
  act(B, B_second);
  await syncOnce(store, A);
  const out = await syncOnce(store, B);
  assert.ok(out.replayedIds.includes(B_first.id));
  assert.equal(out.effects[B_first.id], undefined); // skipped: undo must not reverse it
  assert.ok(out.effects[B_second.id]);
  assert.equal(out.remoteChanged, true);
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
  const out = await syncOnce(store, A);
  assert.equal(out.remoteChanged, false);
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
  act(A, op('import', { tracks: noise.map((name, i) => ({ id: 'n' + i, name, artists: '', album: '' })) }));
  await assert.rejects(syncOnce(store, A), /TOO_BIG/);
  assert.equal(store.doc.v, 1);
  assert.equal(A.pending.length, 1);
});

test('own upload reports no remote change; effects of uploaded ops come from the replay on the newer cloud', async () => {
  const start = fixture();
  const store = memoryStore({ v: 1, data: await encodeState(start), schema: SCHEMA });
  const A = device(start, 1), B = device(start, 1);
  act(A, op('fight', { a: 'a', b: 'b', score: 1 }));
  const mine = op('fight', { a: 'a', b: 'c', score: 1 });
  const local = act(B, mine);
  const up = await syncOnce(store, A);
  assert.equal(up.remoteChanged, false);
  const out = await syncOnce(store, B);
  assert.ok(out.replayedIds.includes(mine.id));
  assert.notDeepEqual(out.effects[mine.id], local); // a's rating moved first, so the replayed delta differs
  assert.ok(Math.abs(out.effects[mine.id].da - (B.state.tracks.a.rating - (start.tracks.a.rating + 24))) < 1e-9);
});

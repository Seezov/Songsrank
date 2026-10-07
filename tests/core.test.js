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

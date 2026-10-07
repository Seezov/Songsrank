"""Headless tests of the page's sync engine against an in-memory stand-in for Firestore.
Each scenario loads the real page in a fresh browser profile and reports what it saw."""
import json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'

def track(i, **extra):
    return {**dict(id=f't{i}', name=f'Song {i}', artists='Artist', album='', img='x', imgSm='x', added='', isrc='',
                   released='', rating=1500, games=0, wins=0, losses=0, draws=0), **extra}

def state_of(tracks):
    return dict(tracks={t['id']: t for t in tracks}, fights=0, history=[], removed={}, resolved={})

FOUR = state_of(map(track, range(4)))

# shared helpers available to every scenario
PRELUDE = """
const r = {};
const U = { uid: 'u1', email: 'me@example.com' };
const sleep = ms => new Promise(res => setTimeout(res, ms));
const wait = async cond => { for (let i = 0; i < 150 && !cond(); i++) await sleep(20); };
const wrap = d => ({ exists: () => !!d, data: () => d, metadata: { hasPendingWrites: false } });
const bytes = u => ({ toUint8Array: () => u });
function installFake(doc = null) {
  const F = { store: { doc }, listeners: [], slow: 0 };
  Object.assign(cloud, {
    db: {}, auth: {},
    authM: { signOut: async () => onUser(null) },
    fs: {
      doc: (db, col, id) => ({ path: col + '/' + id }),
      getDoc: async () => wrap(F.store.doc),
      runTransaction: async (db, fn) => {
        if (F.slow) await sleep(F.slow);
        let w = null;
        await fn({ get: async () => wrap(F.store.doc), set: (ref, data) => { w = data; } });
        if (w) F.store.doc = w;
      },
      onSnapshot: (ref, cb) => { F.listeners.push(cb); return () => {}; },
      Bytes: { fromUint8Array: bytes },
      serverTimestamp: () => 'now',
    },
  });
  return F;
}
async function signedIn() {
  const F = installFake();
  await onUser(U);
  await wait(() => F.store.doc && !cloud.syncing && !pending.length);
  return F;
}
async function remoteWrite(F, change, schema = 1) {
  const other = await decodeState(F.store.doc.data.toUint8Array());
  change(other);
  F.store.doc = { v: F.store.doc.v + 1, schema, data: bytes(await encodeState(other)) };
  await F.listeners[0](wrap(F.store.doc));
}
"""

SCENARIOS = {
    'first sign-in, fight, remote update, sign out': (FOUR, """
const F = await signedIn();
r.firstVersion = F.store.doc.v;
r.uploadedSongs = Object.keys((await decodeState(F.store.doc.data.toUint8Array())).tracks).length;
r.meta = JSON.parse(localStorage.getItem('sfn.sync'));
decide(1); busy = false;
r.pendingAfterFight = pending.length;
await syncNow();
r.versionAfterFight = F.store.doc.v;
r.cloudFights = (await decodeState(F.store.doc.data.toUint8Array())).fights;
r.pendingAfterSync = pending.length;
await remoteWrite(F, s => { s.fights = 99; });
r.fightsAfterRemote = state.fights;
r.indicator = $('sync-ind').textContent;
await signOutCloud();
r.signedOut = syncMeta === null && localStorage.getItem('sfn.sync') === null && $('sync-ind').classList.contains('hidden');
r.keptLocal = state.fights;
""", dict(firstVersion=1, uploadedSongs=4, meta={'uid': 'u1', 'v': 1}, pendingAfterFight=1, versionAfterFight=2,
          cloudFights=1, pendingAfterSync=0, fightsAfterRemote=99, indicator='Synced', signedOut=True, keptLocal=99)),

    'C1: signing out during a sync does not bring the sync state back': (FOUR, """
const F = await signedIn();
decide(1); busy = false;
F.slow = 300;
const running = syncNow();
await sleep(50);
await signOutCloud();
await running;
await wait(() => !cloud.syncing);
r.syncMeta = syncMeta;
r.stored = ['sfn.sync', 'sfn.base', 'sfn.pending'].map(k => localStorage.getItem(k));
""", dict(syncMeta=None, stored=[None, None, None])),

    'I1: a newer schema from another device is not adopted': (FOUR, """
const F = await signedIn();
await remoteWrite(F, s => { s.fights = 99; }, 2);
r.fights = state.fights;
r.indicator = $('sync-ind').textContent;
""", dict(fights=0, indicator='Sync error')),

    'I2: undoing a fight that a remote removal skipped changes nothing': (FOUR, """
const F = await signedIn();
const [x, y] = current;
decide(1); busy = false;
const other = await decodeState(F.store.doc.data.toUint8Array());
other.removed[x] = { ...other.tracks[x], removedAt: 'now', unliked: false };
delete other.tracks[x];
F.store.doc = { v: F.store.doc.v + 1, schema: 1, data: bytes(await encodeState(other)) };
await syncNow();
undo();
r.y = [state.tracks[y].rating, state.tracks[y].games];
r.fights = state.fights;
""", dict(y=[1500, 0], fights=0)),

    'I4: the ranking is saved before the pending queue': (FOUR, """
const F = await signedIn();
const keys = [];
const orig = Storage.prototype.setItem;
Storage.prototype.setItem = function (k, v) { keys.push(k); return orig.call(this, k, v); };
decide(1); busy = false;
Storage.prototype.setItem = orig;
r.order = keys.filter(k => k === 'sfn.state' || k === 'sfn.pending').slice(0, 2);
""", dict(order=['sfn.state', 'sfn.pending'])),

    'I5: our own upload does not redraw the screen': (FOUR, """
const F = await signedIn();
decide(1); busy = false;
await sleep(700);
let redraws = 0;
const os = show, orf = renderFight;
show = v => { redraws++; return os(v); };
renderFight = () => { redraws++; return orf(); };
await syncNow();
show = os; renderFight = orf;
r.redraws = redraws;
""", dict(redraws=0)),

    'I5: re-rendering duplicates keeps the chosen version': (state_of([track(0, isrc='SAME'), track(1, isrc='SAME'), track(2), track(3)]), """
show('dupes');
const radios = [...document.querySelectorAll('#dupes-list .group input[type=radio]')];
radios[1].checked = true;
const chosen = radios[1].value;
renderDupes();
r.kept = document.querySelector('#dupes-list .group input:checked').value === chosen;
""", dict(kept=True)),

    'I6: cancelling the first-sync dialog leaves no live listener': (FOUR, """
const remote = { tracks: { z: { ...state.tracks.t0, id: 'z' } }, fights: 5, removed: {}, resolved: {} };
const F = installFake({ v: 3, schema: 1, data: bytes(await encodeState(remote)) });
const signing = onUser(U);
await wait(() => $('first-sync').open);
$('first-sync').querySelector('button[value=cancel]').click();
await signing;
r.listeners = F.listeners.length;
r.indicatorHidden = $('sync-ind').classList.contains('hidden');
r.syncMeta = syncMeta;
r.localSongs = list().length;
""", dict(listeners=0, indicatorHidden=True, syncMeta=None, localSongs=4)),
}


def run(seed, body):
    seed_js = "<script>localStorage.clear();localStorage.setItem('sfn.state', %s);</script>" % json.dumps(json.dumps(seed))
    probe = ("<script>setTimeout(async () => {" + PRELUDE +
             "try {" + body + "} catch (e) { r.error = String(e && e.stack || e); }\n"
             "document.title = 'RESULT ' + JSON.stringify(r);}, 800);</script></body>")
    tmp = tempfile.mkdtemp()
    try:
        html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
        html = html.replace('<head>', '<head>' + seed_js, 1).replace('</body>', probe, 1)
        open(os.path.join(tmp, 'index.html'), 'w', encoding='utf-8').write(html)
        shutil.copy(os.path.join(ROOT, 'core.js'), tmp)
        out = subprocess.run([CHROME, '--headless=new', '--disable-gpu', f'--user-data-dir={tmp}/profile',
                              '--virtual-time-budget=20000', '--dump-dom', 'file:///' + tmp.replace('\\', '/') + '/index.html'],
                             capture_output=True, text=True, encoding='utf-8', timeout=180).stdout
        title = out.split('<title>', 1)[1].split('</title>', 1)[0]
        if not title.startswith('RESULT '):
            return {'error': 'no result: ' + title}
        return json.loads(title[7:].replace('&quot;', '"').replace('&amp;', '&'))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


failed = 0
for name, (seed, body, expected) in SCENARIOS.items():
    got = run(seed, body)
    ok = got == expected
    failed += not ok
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'\n     got      {got}\n     expected {expected}'))
print(f'{len(SCENARIOS) - failed}/{len(SCENARIOS)} sync scenarios passed')
sys.exit(1 if failed else 0)

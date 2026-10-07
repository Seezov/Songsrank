"""Headless test of the page's sync engine against an in-memory stand-in for Firestore:
first sign-in uploads, a fight syncs, another device's write shows up, sign-out cleans up."""
import json, os, shutil, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'

def track(i):
    return dict(id=f't{i}', name=f'Song {i}', artists='Artist', album='', img='x', imgSm='x', added='', isrc='',
                released='', rating=1500, games=0, wins=0, losses=0, draws=0)

state = dict(tracks={t['id']: t for t in map(track, range(4))}, fights=0, history=[], removed={}, resolved={})
SEED = "<script>localStorage.clear();localStorage.setItem('sfn.state', %s);</script>" % json.dumps(json.dumps(state))
PROBE = """<script>setTimeout(async () => {
  const r = {};
  const wait = async cond => { for (let i = 0; i < 100 && !cond(); i++) await new Promise(res => setTimeout(res, 20)); };
  try {
    const store = { doc: null };
    const listeners = [];
    const wrap = d => ({ exists: () => !!d, data: () => d, metadata: { hasPendingWrites: false } });
    const bytes = u => ({ toUint8Array: () => u });
    Object.assign(cloud, {
      db: {}, auth: {},
      authM: { signOut: async () => onUser(null) },
      fs: {
        doc: (db, col, id) => ({ path: col + '/' + id }),
        getDoc: async () => wrap(store.doc),
        runTransaction: async (db, fn) => {
          let w = null;
          await fn({ get: async () => wrap(store.doc), set: (ref, data) => { w = data; } });
          if (w) store.doc = w;
        },
        onSnapshot: (ref, cb) => { listeners.push(cb); return () => {}; },
        Bytes: { fromUint8Array: bytes },
        serverTimestamp: () => 'now',
      },
    });

    await onUser({ uid: 'u1', email: 'me@example.com' });
    await wait(() => store.doc && !cloud.syncing);
    r.firstVersion = store.doc.v;
    r.uploadedSongs = Object.keys((await decodeState(store.doc.data.toUint8Array())).tracks).length;
    r.meta = JSON.parse(localStorage.getItem('sfn.sync'));

    decide(1); busy = false;
    r.pendingAfterFight = pending.length;
    await syncNow();
    r.versionAfterFight = store.doc.v;
    r.cloudFights = (await decodeState(store.doc.data.toUint8Array())).fights;
    r.pendingAfterSync = pending.length;

    const other = await decodeState(store.doc.data.toUint8Array());
    other.fights = 99;
    store.doc = { v: store.doc.v + 1, schema: 1, data: bytes(await encodeState(other)) };
    await listeners[0](wrap(store.doc));
    r.fightsAfterRemote = state.fights;
    r.indicator = $('sync-ind').textContent;

    await signOutCloud();
    r.signedOut = syncMeta === null && localStorage.getItem('sfn.sync') === null && $('sync-ind').classList.contains('hidden');
    r.keptLocal = state.fights;
  } catch (e) { r.error = String(e && e.stack || e); }
  document.title = 'RESULT ' + JSON.stringify(r);
}, 800);</script></body>"""

tmp = tempfile.mkdtemp()
try:
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    html = html.replace('<head>', '<head>' + SEED, 1).replace('</body>', PROBE, 1)
    open(os.path.join(tmp, 'index.html'), 'w', encoding='utf-8').write(html)
    shutil.copy(os.path.join(ROOT, 'core.js'), tmp)
    out = subprocess.run([CHROME, '--headless=new', '--disable-gpu', f'--user-data-dir={tmp}/profile',
                          '--virtual-time-budget=15000', '--dump-dom', 'file:///' + tmp.replace('\\', '/') + '/index.html'],
                         capture_output=True, text=True, encoding='utf-8', timeout=180).stdout
    title = out.split('<title>', 1)[1].split('</title>', 1)[0]
    assert title.startswith('RESULT '), title
    r = json.loads(title[7:].replace('&quot;', '"').replace('&amp;', '&'))
    expected = dict(firstVersion=1, uploadedSongs=4, meta={'uid': 'u1', 'v': 1}, pendingAfterFight=1, versionAfterFight=2,
                    cloudFights=1, pendingAfterSync=0, fightsAfterRemote=99, indicator='Synced', signedOut=True, keptLocal=99)
    assert r == expected, f'{r} != {expected}'
    print('sync smoke OK', r)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

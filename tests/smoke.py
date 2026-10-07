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

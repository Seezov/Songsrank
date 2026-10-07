# Local server for Song Fight Night. Same as `python -m http.server`, but tells the
# browser not to cache, so an updated index.html shows up on a normal reload.
import http.server
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        # started from the desktop shortcut (pythonw) there is no console to log to
        if sys.stderr:
            super().log_message(*args)


# Spotify only accepts this exact redirect address, so the host and port are fixed
http.server.ThreadingHTTPServer(('127.0.0.1', 8888), NoCache).serve_forever()

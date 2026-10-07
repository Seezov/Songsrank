# Desktop-shortcut launcher for Song Fight Night: starts the local server in the
# background if it isn't running yet, then opens the site in the default browser.
import os
import socket
import subprocess
import sys
import time
import webbrowser

HOST, PORT = '127.0.0.1', 8888
HERE = os.path.dirname(os.path.abspath(__file__))


def server_up():
    try:
        with socket.create_connection((HOST, PORT), timeout=0.3):
            return True
    except OSError:
        return False


if not server_up():
    # pythonw has no console window; detach so the server outlives this launcher
    pythonw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')
    subprocess.Popen([pythonw, os.path.join(HERE, 'serve.py')], cwd=HERE,
                     creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    for _ in range(50):
        if server_up():
            break
        time.sleep(0.1)

webbrowser.open(f'http://{HOST}:{PORT}/')

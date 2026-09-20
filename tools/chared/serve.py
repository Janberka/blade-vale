# tools/chared — the char editor's dev server. Serves the REPO ROOT (the editor reads the game's own rig at
# /assets/rigs/base and the game's own three at /vendor), never caches, and takes two POSTs from the page:
#   /shot?<name>    a screenshot           -> tools/chared/shots/<name>.jpg
#   /export?<file>  a baked piece or tile  -> tools/chared/items/<file>
# Run:  python3 tools/chared/serve.py    then open  http://localhost:8120/tools/chared/index.html
import http.server, socketserver, os, base64
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
P = int(os.environ.get('PORT', '8120'))

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=ROOT, **k)

    def do_GET(s):                                    # the root IS the editor (the repo is served under it so the rig and three resolve)
        if s.path in ('/', '/index.html'):
            s.send_response(302); s.send_header('Location', '/tools/chared/index.html'); s.end_headers(); return
        return super().do_GET()

    def end_headers(s):
        s.send_header('Cache-Control', 'no-store, must-revalidate'); s.send_header('Pragma', 'no-cache'); s.send_header('Expires', '0')
        super().end_headers()

    def _write(s, sub, name, data):
        d = os.path.join(HERE, sub); os.makedirs(d, exist_ok=True)
        body = base64.b64decode(data.split(',', 1)[1]) if data.startswith('data:') else data.encode()
        open(os.path.join(d, os.path.basename(name)), 'wb').write(body)
        s.send_response(200); s.end_headers(); s.wfile.write(b'ok')

    def do_POST(s):
        n = int(s.headers.get('Content-Length', 0)); data = s.rfile.read(n).decode()
        arg = s.path.split('?', 1)[1] if '?' in s.path else ''
        if s.path.startswith('/shot'): return s._write('shots', (arg or 'shot') + '.jpg', data)
        if s.path.startswith('/export') and arg: return s._write('items', arg, data)
        s.send_response(404); s.end_headers()

    def log_message(s, *a): pass

socketserver.TCPServer.allow_reuse_address = True
print('char editor: http://localhost:%d/tools/chared/index.html' % P)
socketserver.TCPServer(('', P), H).serve_forever()

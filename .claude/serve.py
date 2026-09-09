import http.server
import socketserver

DIRECTORY = "/Users/vic/Documents/GitHub/low-poly-hack-slash"
PORT = 8099


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, *args):
        pass


with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"serving {DIRECTORY} on :{PORT}")
    httpd.serve_forever()

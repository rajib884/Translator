import http.server, socketserver, os, sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

os.chdir(sys.argv[1] if len(sys.argv) > 1 else '.')
with socketserver.TCPServer(('', 8000), NoCacheHandler) as httpd:
    httpd.serve_forever()

#!/usr/bin/env python3
"""
receiver.py — tiny localhost helper used to get the pulled listings out of the
browser and onto disk during a refresh (see scraper/browser_pull.js).

Domain.com.au's CSP blocks the page from fetch()-ing localhost, so instead:
  1. Run this server:           python scraper/receiver.py
  2. From a domain.com.au tab, navigate (top-level, not fetch) to:
         http://127.0.0.1:8799/sink#<encodeURIComponent(localStorage._final)>
     The sink page reads the URL hash and POSTs it back to /save (same origin),
     which writes scratch/_pull_final.json.
  3. Merge that with config.json + a timestamp into data/listings.json.

Stdlib only. Stop it with Ctrl-C (or stop the background task).
"""
import http.server
import socketserver
from pathlib import Path

OUT = Path(__file__).resolve().parent / "_pull_final.json"
PORT = 8799

SINK = b"""<!doctype html><meta charset=utf-8><title>WAITING</title>
<body>sink<script>
(async () => {
  try {
    const data = decodeURIComponent(location.hash.slice(1));
    const r = await fetch('/save', { method:'POST', body: data });
    document.title = r.ok ? ('SAVED ' + data.length) : ('ERR ' + r.status);
  } catch (e) { document.title = 'ERR ' + e.message; }
})();
</script></body>"""


class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(SINK)))
        self.end_headers()
        self.wfile.write(SINK)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        OUT.write_bytes(body)
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "text/plain"); self.end_headers()
        self.wfile.write(b"ok")
        print(f"received {len(body)} bytes -> {OUT.name}", flush=True)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), H) as httpd:
        print(f"receiver+sink listening on http://127.0.0.1:{PORT}", flush=True)
        httpd.serve_forever()

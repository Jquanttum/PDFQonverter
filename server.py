"""PDF Qonverter - tiny local web server.

Why this exists: browsers refuse to run the PDF engine's background worker from a file:// address,
so the app is served from http://127.0.0.1 instead. Nothing is exposed to the network, and no
request ever leaves this computer.

Usage:  python server.py            (or double-click start.bat on Windows)
"""
import functools
import http.server
import os
import socket
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFERRED_PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".pdf": "application/pdf",
        ".bcmap": "application/octet-stream",
        ".pfb": "application/octet-stream",
        ".ttf": "font/ttf",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet
        pass


def free_port(start):
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("No free port found near %d" % start)


def main():
    port = free_port(PREFERRED_PORT)
    handler = functools.partial(Handler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = "http://127.0.0.1:%d/index.html" % port
    print("PDF Qonverter is running at", url)
    print("Keep this window open while you work. Press Ctrl+C to stop.")
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

import os
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
import webview
import sys

# PyInstaller uses sys._MEIPASS for the temp unpacked directory
if getattr(sys, 'frozen', False):
    # Running as a compiled .exe
    BASE_DIR = sys._MEIPASS
else:
    # Running as a casual python script
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DIST_DIR = os.path.join(BASE_DIR, 'dist')
PORT = 51730

class SPAHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST_DIR, **kwargs)

    def do_GET(self):
        # Fallback to index.html for React Router SPA behavior
        path = self.path.split('?')[0] # Strip query parameters
        file_path = os.path.join(DIST_DIR, path.lstrip('/'))
        
        # If the requested file doesn't exist, we send back index.html
        if not os.path.exists(file_path):
            self.path = '/index.html'
            
        return super().do_GET()

def start_server():
    server = HTTPServer(('localhost', PORT), SPAHandler)
    server.serve_forever()

if __name__ == '__main__':
    # Ensure the dist folder exists
    if not os.path.exists(DIST_DIR):
        print(f"Error: Could not find the built frontend inside {DIST_DIR}.")
        print("Please run `npm run build` first!")
        sys.exit(1)

    # 1. Start local web server in the background
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    # 2. Launch the desktop GUI wrapping our local web server
    window = webview.create_window(
        'Proxy Attendance System',
        f'http://localhost:{PORT}',
        width=1200, 
        height=800,
        min_size=(900, 700),
        text_select=False # Makes it feel more like a native app
    )
    
    # Setting private_mode=False enables standard Edge Chromium features (webcam)
    webview.start(private_mode=False)

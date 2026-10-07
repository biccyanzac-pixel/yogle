// Static server with cross-origin isolation (needed for threaded WASM) for the benchmark page.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.onnx': 'application/octet-stream', '.task': 'application/octet-stream', '.bin': 'application/octet-stream', '.mp4': 'video/mp4' };
export function start(port = 8765) {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      let p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { resp.writeHead(404); return resp.end(); }
      resp.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' });
      fs.createReadStream(p).pipe(resp);
    });
    srv.listen(port, () => res(srv));
  });
}
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) start().then(() => console.log('http://localhost:8765/web/'));

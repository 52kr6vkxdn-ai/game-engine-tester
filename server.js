const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.webp': 'image/webp',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found: ' + urlPath);
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500); res.end('Server error: ' + e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Static server listening on http://0.0.0.0:${PORT}`);
});

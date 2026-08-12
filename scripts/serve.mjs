#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(fileURLToPath(new URL('../apps/web/', import.meta.url)));
const requestedPort = Number(process.env.PORT || process.argv[2] || 8765);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 8765;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function localPath(url = '/') {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname); }
  catch { return null; }
  const candidate = resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  return candidate === webRoot || candidate.startsWith(`${webRoot}${sep}`) ? candidate : null;
}

const server = createServer((request, response) => {
  const path = localPath(request.url);
  if (!path) {
    response.writeHead(400).end('Bad request');
    return;
  }

  try {
    if (!statSync(path).isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`拾忆已启动：http://127.0.0.1:${port}`);
});

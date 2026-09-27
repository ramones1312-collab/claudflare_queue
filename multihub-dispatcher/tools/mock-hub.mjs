// Mock Hub for the physical gate: records POSTs; GET /received lists them (url, body). Port from PORT.
import http from 'node:http';
const got = [];
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/received') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(got)); }
  const c = []; req.on('data', d => c.push(d)); req.on('end', () => {
    got.push({ url: req.url, body: Buffer.concat(c).toString(), ct: req.headers['content-type'] || '' });
    console.log(`MOCK ${process.env.NAME || ''} received #${got.length}`);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
}).listen(Number(process.env.PORT || 9000), '0.0.0.0');

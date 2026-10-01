import { createServer } from 'node:http';

createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    console.log(body);
    response.writeHead(204).end();
  });
}).listen(1421, '127.0.0.1', () => console.log('Benchmark result receiver ready'));

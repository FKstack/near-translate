import { createServer } from 'node:http';

const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Near Translate test document</title>
<style>body{margin:0;background:#f2f5f2;color:#263b31;font:18px/1.9 Georgia,serif}main{max-width:820px;margin:60px auto;padding:40px 56px;background:white;border-radius:18px}h1{font:36px/1.2 Georgia,serif;margin-top:0}p{margin:24px 0}small{color:#788d7d}button{display:none!important}iframe{width:100%;height:170px;border:1px solid #dae5dc;border-radius:8px}textarea{width:100%;height:80px;font:17px Georgia,serif}.edge{position:fixed;bottom:10px;right:10px}</style></head>
<body><main><small>ENGLISH READING · LOCAL TEST FIXTURE</small><h1>Understanding technical writing</h1>
<p id="word-context">The <span id="bank">bank</span> approved the technical report.</p>
<p>I will <span id="record">record</span> the final result.</p>
<p id="paragraph">Concurrency does not imply parallelism.\nThe result is not statistically significant at 0.05.</p>
<p id="slow">Slow selection must never overwrite a newer translation.</p>
<p id="inert">Render translated HTML as plain text.</p>
<p id="retry">Retry the request after a temporary service failure.</p>
<textarea id="editable" aria-label="Editable English">The scheduler avoids unnecessary synchronization.</textarea>
<iframe title="English iframe" src="/frame"></iframe></main><span id="edge-word" class="edge">accuracy</span></body></html>`;

const frame = '<!doctype html><html><head><meta charset="utf-8"><style>body{font:18px/1.9 Georgia,serif;padding:12px 20px;color:#263b31}</style></head><body><p>The <span id="frame-word">scheduler</span> controls concurrent work.</p></body></html>';
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/frame') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(frame); return;
  }
  if (request.url === '/' || request.url?.startsWith('/?')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(document); return;
  }
  response.writeHead(404); response.end('Not found');
});
server.listen(4177, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));

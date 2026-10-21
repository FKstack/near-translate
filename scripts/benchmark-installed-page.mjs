import { createServer } from 'node:http';
import { readFile, writeFile, unlink, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

// Uses the installed extension's normal UI and backend. Never reads credential storage.
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const label = option('--label', 'page');
assert.match(label, /^[a-z0-9-]+$/);
const deadlineMs = Number(option('--timeout-ms', '360000'));
const reload = args.includes('--reload');
assert(deadlineMs >= 15000 && deadlineMs <= 600000);
const workspace = await realpath(process.cwd());
assert(process.env.NEAR_INSTALLED_EXTENSION_DIR, 'Set NEAR_INSTALLED_EXTENSION_DIR to the loaded extension directory inside this workspace.');
const installed = await realpath(path.resolve(workspace, process.env.NEAR_INSTALLED_EXTENSION_DIR));
const relativeInstalled = path.relative(workspace, installed);
assert(relativeInstalled && !path.isAbsolute(relativeInstalled) && relativeInstalled !== '..' && !relativeInstalled.startsWith(`..${path.sep}`), 'The installed extension must be inside this workspace.');
const extensionId = process.env.NEAR_INSTALLED_EXTENSION_ID;
assert(typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId), 'Set NEAR_INSTALLED_EXTENSION_ID to the browser extension ID.');
const browserExecutable = process.env.NEAR_BROWSER_EXECUTABLE;
assert(browserExecutable && path.isAbsolute(browserExecutable), 'Set NEAR_BROWSER_EXECUTABLE to an absolute browser executable path.');
const profileDirectory = process.env.NEAR_BROWSER_PROFILE_DIRECTORY || 'Default';
assert(/^[a-zA-Z0-9 ._-]{1,100}$/.test(profileDirectory), 'Invalid browser profile directory name.');
const sourceUrl = 'https://go.dev/talks/2012/splash.article';
const version = JSON.parse(await readFile(path.join(installed, 'manifest.json'), 'utf8')).version;
const token = randomBytes(20).toString('hex');
const basename = `near-speed-${token}`;
const html = path.join(installed, `${basename}.html`);
const script = path.join(installed, `${basename}.js`);
const events = [];
let finish;
const done = new Promise(resolve => { finish = resolve; });
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', `chrome-extension://${extensionId}`);
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (request.url !== `/${token}`) { response.writeHead(404).end(); return; }
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  if (request.method !== 'POST') { response.writeHead(405).end(); return; }
  let body = '';
  for await (const bytes of request) { body += bytes; if (body.length > 20000) { response.writeHead(413).end(); return; } }
  try {
    const incoming = JSON.parse(body);
    const event = Object.fromEntries(['phase', 'version', 'model', 'hasApiKey', 'webAccess', 'elapsedMs', 'firstMs', 'completed', 'failed', 'total', 'translatedChars', 'samples', 'status', 'message']
      .filter(key => ['string', 'number', 'boolean'].includes(typeof incoming[key]))
      .map(key => [key, typeof incoming[key] === 'string' ? incoming[key].slice(0, key === 'samples' ? 3000 : 500) : incoming[key]]));
    events.push(event);
    console.log(JSON.stringify(event));
    response.writeHead(200).end('ok');
    if (['complete', 'error', 'timeout'].includes(event.phase)) finish(event);
  } catch { response.writeHead(400).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/${token}`;
let timeout;
try {
  await writeFile(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>近译 · 整页速度测试</title><h1>近译 · 整页速度测试</h1><p id="status">正在测试公开 Go 文章。API Key 保留在扩展后台。</p><pre id="result"></pre><script src="${basename}.js"></script></html>`);
  await writeFile(script, `
const endpoint=${JSON.stringify(endpoint)};
const sourceUrl=${JSON.stringify(sourceUrl)};
const deadlineMs=${deadlineMs};
const report=async data=>{document.querySelector('#result').textContent=JSON.stringify(data,null,2);await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});};
async function run(){
 if(new URL(location.href).searchParams.has('reload')){await report({phase:'reloading',version:chrome.runtime.getManifest().version});chrome.runtime.reload();return;}
 const settings=await chrome.runtime.sendMessage({type:'get-settings'});
 const version=chrome.runtime.getManifest().version;
 await report({phase:'ready',version,model:settings.model,hasApiKey:settings.hasApiKey,webAccess:settings.webAccess});
 if(version!==${JSON.stringify(version)})throw new Error('扩展运行版本与安装目录不一致，请重新加载后再测试。');
 if(!settings.enabled||(!settings.hasApiKey&&settings.requiresApiKey!==false)||!settings.webAccess)throw new Error('请先启用网页翻译并完成当前模型 API 配置。');
 const tab=await chrome.tabs.create({url:sourceUrl,active:false});
 const readyDeadline=performance.now()+30000;
 while(true){
  try{const [state]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>!!document.querySelector('near-page-translate')?.shadowRoot?.querySelector('button[aria-label="翻译整个页面"]')});if(state?.result)break;}catch{}
  if(performance.now()>readyDeadline)throw new Error('目标网页翻译栏未加载。');
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
  const bar=document.querySelector('near-page-translate');
  const state={started:performance.now(),firstMs:null,elapsedMs:0,completed:0,failed:0,total:0,translatedChars:0,samples:'',status:'',finished:false};
  window.__nearSpeed=state;
  const update=()=>{
   const translated=[...document.querySelectorAll('near-page-translation[data-state="done"]')].map(node=>node.shadowRoot.querySelector('span')?.textContent||'');
   const completed=translated.length;
   if(completed&&state.firstMs===null)state.firstMs=performance.now()-state.started;
   state.completed=completed;state.translatedChars=translated.reduce((total,text)=>total+text.length,0);state.failed=document.querySelectorAll('near-page-translation[data-state="error"]').length;
   state.status=bar.shadowRoot.querySelector('[role="status"]')?.textContent||'';
   const counts=state.status.match(/(\\d+)\\s*\\/\\s*(\\d+)/);if(counts)state.total=Number(counts[2]);
   state.elapsedMs=performance.now()-state.started;
   if(state.status.includes('翻译完成')||state.status.includes('已停止')||state.status.includes('没有找到')){
    const prose=translated.filter(text=>text.length>80);state.samples=JSON.stringify([prose[0],prose[Math.floor(prose.length/2)],prose.at(-1)].filter(Boolean));
    state.finished=true;bodyObserver.disconnect();barObserver.disconnect();
   }
  };
  const bodyObserver=new MutationObserver(update);bodyObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-state']});
  const barObserver=new MutationObserver(update);barObserver.observe(bar.shadowRoot,{subtree:true,childList:true,characterData:true});
  bar.shadowRoot.querySelector('button[aria-label="翻译整个页面"]').click();
 }});
 await report({phase:'started',version,model:settings.model});
 const start=performance.now();let lastReport=0;
 while(true){
  await new Promise(resolve=>setTimeout(resolve,300));
  const [snapshot]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
   const state=window.__nearSpeed;if(!state)return null;
   return {...state,elapsedMs:state.finished?state.elapsedMs:performance.now()-state.started};
  }});
  const s=snapshot.result;if(!s)throw new Error('测试页面已离开。');
  const summary={version,model:settings.model,elapsedMs:Math.round(s.elapsedMs),firstMs:s.firstMs===null?undefined:Math.round(s.firstMs),completed:s.completed,failed:s.failed,total:s.total,translatedChars:s.translatedChars,samples:s.samples||undefined,status:s.status};
  if(s.finished){await report({phase:s.failed?'error':'complete',...summary});break;}
  if(performance.now()-start>deadlineMs){
   await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>document.querySelector('near-page-translate')?.shadowRoot?.querySelector('button[aria-label="停止翻译"]')?.click()});
   await report({phase:'timeout',...summary});break;
  }
  if(performance.now()-lastReport>10000){lastReport=performance.now();await report({phase:'progress',...summary});}
 }
 document.querySelector('#status').textContent='计时结束，可关闭此测试页。';
}
run().catch(async error=>{await report({phase:'error',message:String(error.message)});});
`);
  const open = query => {
    const child = spawn(browserExecutable, [`--profile-directory=${profileDirectory}`, `chrome-extension://${extensionId}/${basename}.html${query}`], { windowsHide: true, stdio: 'ignore' });
    child.unref();
  };
  if (reload) { open('?reload=1'); await new Promise(resolve => setTimeout(resolve, 1800)); }
  open('');
  timeout = setTimeout(() => finish({ phase: 'harness-timeout', message: 'No final response from installed extension.' }), deadlineMs + 45000);
  const result = await done;
  await writeFile(path.join(workspace, `.output/go-page-${label}.json`), JSON.stringify({ label, sourceUrl, expectedVersion: version, events, result }, null, 2) + '\n');
  if (result.phase !== 'complete') process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await new Promise(resolve => server.close(resolve));
  await Promise.all([unlink(html).catch(() => {}), unlink(script).catch(() => {})]);
}

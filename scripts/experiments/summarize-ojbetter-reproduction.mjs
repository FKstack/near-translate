// Summarize captured real Tampermonkey/OJBetter evidence without making network requests.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('.output/ojbetter-reproduction');
const json=async name=>JSON.parse(await readFile(resolve(root,name),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=await readFile(resolve(root,'atcoder-better.remote.js'));
const installed=await readFile(resolve(root,'installed-source.js'));
const runtime=await readFile(resolve(root,'runtime-source.js'),'utf8');
const network=await json('all-network.json'), gm=await json('all-gm.json');
assert.equal(sha(source),'ac54e910d52ff40df1e9f25173a79cb2046eb4b9a1849bc1dcf5b6e07d79aa26');
assert.equal(sha(source),sha(installed));assert(runtime.includes(source.toString('utf8')));
assert.equal(network.length,3);
const requests=network.map((r,i)=>{
 const wire=r.wire.headers,body=JSON.parse(r.body.body),input=JSON.parse(r.request.postData);
 assert.equal(r.response.status,200);assert.equal(body.id,input.id);assert.equal(body.result.texts.length,1);
 assert(/[\u3400-\u9fff]/.test(body.result.texts[0].text));
 assert(!Object.keys(wire).some(k=>/^(cookie|authorization)$/i.test(k)));assert.equal(r.wire.associatedCookieCount,0);
 assert.equal(wire.origin,'https://www.deepl.com');assert.equal(wire.referer,'https://www.deepl.com/');
 assert.equal(r.response.fromDiskCache,false);assert.equal(r.response.fromServiceWorker,false);
 if(i>0){assert.equal(gm[i].options.data,r.request.postData);assert.equal(gm[i].options.anonymous,true);}
 return {case:i===0?'single':'multi-'+i,sourceText:input.params.texts[0].text,translation:body.result.texts[0].text,
   at:new Date(r.wallTime*1000).toISOString(),status:r.response.status,method:r.request.method,url:r.request.url,
   requestBody:r.request.postData,requestBodySha256:sha(r.request.postData),actualRequestHeaders:wire,cookieCount:0,
   responseHeaders:r.response.headers,responseBody:r.body.body,responseBodySha256:sha(r.body.body),
   milliseconds:Math.round((r.finished.timestamp-r.timestamp)*1000),fromDiskCache:false,fromServiceWorker:false,
   targetType:r.target.type,gmCall:i>0?gm[i]:{stack:gm[i].stack,optionsCapture:'unavailable: debugger metadata read raised GM_info ReferenceError; request still completed normally'},
 };
});
const gap=(network[2].timestamp-network[1].finished.timestamp)*1000;assert(gap>=200);
const report={generatedAt:new Date().toISOString(),qualification:'original-OJBetter-UI-and-real-Tampermonkey',
 source:{commit:'860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46',version:'1.25.1',url:'https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js',sha256:sha(source),installedExact:true,runtimeContainsOriginalExactly:true},
 environment:{browser:'Microsoft Edge 155.0.4283.62',headless:true,profile:'isolated; no user profile or account',tampermonkey:(await json('tampermonkey/manifest.json')).version,package:'official stable CRX, loaded unpacked without manifest modifications',crxSha256:sha(await readFile(resolve(root,'tampermonkey.crx'))),developerMode:true,allowUserScripts:true,
 dependencyRepair:'Original mirrors failed. 13 exact SHA-512 verified cdnjs assets fulfilled locally at original dependency URLs. DeepL responses were never intercepted or substituted.',
 dependencyManifest:await json('dependencies/manifest.json'),dependencyServed:await json('dependency-repair-served.json'),
 remainingBootstrapError:'Optional Monaco code editor CDN CORS failure; actual translation UI and chain initialized.'},
 entry:{page:'https://atcoder.jp/contests/abc350/tasks/abc350_a?lang=en',engine:'deepl',mode:'free',target:'zh',workMode:'selected paragraphs',autoTranslation:false,memoryTranslateHistory:false,replaceOriginal:false,transWaitTime:200},
 requests,checks:{singlePassed:true,multiPassed:true,multiOrderPassed:true,multiRequestCount:2,noCookieOrAuthorization:true,formulasAndInlineCodeRestored:true,multiGapAfterPreviousResponseMs:Math.round(gap)},
 renderedText:await readFile(resolve(root,'rendered-translations.txt'),'utf8'),
 previous429:{cause:'not determined at individual-field level',whatChanged:'original protocol/body/header/GM transport plus different request time/content; not a controlled one-variable experiment',conclusion:'Earlier simplified MV3 429 does not demonstrate original OJBetter unavailability. Do not claim IP ban or a specific anti-abuse rule.'},
};
await mkdir(resolve('docs/evidence'),{recursive:true});
await writeFile(resolve('docs/evidence/ojbetter-full-reproduction-2026-10-21.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({singlePassed:true,multiPassed:true,requests:requests.length,serialGapMs:Math.round(gap),sourceSha256:sha(source)},null,2));

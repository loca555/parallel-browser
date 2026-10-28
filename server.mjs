import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startPublicProxy, createPublicUrlPolicy, PublicUrlError } from './egress.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 10000);
const hosts = new Set(['augur-web-lab.vercel.app', 'augur.net', 'www.augur.net']);
const publicBrowsing = process.env.PUBLIC_BROWSER !== '0';
const sandboxEnabled = process.env.CHROMIUM_SANDBOX !== '0';
const policy = createPublicUrlPolicy({blockedHostnames:[process.env.RENDER_EXTERNAL_HOSTNAME,'parallel-compare.onrender.com','parallel-browser.onrender.com'].filter(Boolean)});
const MAX_PAGES = 8;
const GLOBAL_PAGES = Math.min(8, Math.max(2, Number(process.env.MAX_BROWSER_PAGES || 4)));
const MAX_SESSIONS = 8;
const IDLE_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 60 * 60 * 1000;
const sessions = new Map();
let browserPromise;
let proxyPromise;
let browserState = 'idle';
let creating = 0;
let pendingSessions = 0;
let sessionCredits = 4;
let sessionRateAt = Date.now();

function fail(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function json(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(value)); }
function int(value, fallback, min, max) { const n=Number(value); return Number.isFinite(n)?Math.min(max,Math.max(min,Math.round(n))):fallback; }
function totalPages() { return creating + [...sessions.values()].reduce((sum,s)=>sum+s.pages.size,0); }
async function checkedUrl(value) {
 let url;
 try { url = await policy.validatePublicUrl(value); } catch(error) {if(error instanceof PublicUrlError)throw fail(400,error.code,error.message);throw error;}
 if (!publicBrowsing && !hosts.has(url.hostname.toLowerCase())) throw fail(400,'host_not_allowed','This browser preview currently supports the listed Augur websites only.');
 return url;
}
async function readJson(req) {
 let size=0;const chunks=[];
 for await(const chunk of req) { size+=chunk.length; if(size>32*1024) throw fail(413,'body_too_large','Request is too large.'); chunks.push(chunk); }
 try { return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{}; } catch { throw fail(400,'invalid_json','Invalid JSON body.'); }
}
async function browser() {
 if (!sandboxEnabled && (publicBrowsing || process.env.NODE_ENV === 'production')) throw fail(503,'sandbox_required','This host must support Chromium sandboxing for browser previews.');
 if (!browserPromise) {
  browserState='starting';
  proxyPromise ||= startPublicProxy({policy});
  browserPromise=proxyPromise.then(proxy=>chromium.launch({headless:true,chromiumSandbox:sandboxEnabled,proxy:{server:proxy.url,bypass:'<-loopback>'},args:['--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-default-apps','--no-first-run'],timeout:30_000})).then(instance=>{
   browserState='ready';
   instance.on('disconnected',()=>{browserPromise=null;browserState='idle';for(const s of sessions.values())s.pages.clear();sessions.clear();});
   return instance;
  }).catch(error=>{browserPromise=null;browserState='failed';console.error('browser_launch_failed');throw fail(503,'browser_unavailable','The browser could not start. This host may not support Chromium sandboxing.');});
 }
 return browserPromise;
}
async function createSession() {
 const now=Date.now();sessionCredits=Math.min(4,sessionCredits+(now-sessionRateAt)/15_000);sessionRateAt=now;
 if(sessionCredits<1)throw fail(429,'rate_limited','Please wait before starting another browser session.');
 if(sessions.size+pendingSessions>=MAX_SESSIONS)throw fail(503,'session_capacity','All browser sessions are in use. Please try again later.');
 sessionCredits--;pendingSessions++;
 try {
  const b=await browser();
  const context=await b.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,acceptDownloads:false,serviceWorkers:'block',permissions:[],reducedMotion:'reduce',ignoreHTTPSErrors:false});
  await context.addInitScript(()=>{for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport']){try{Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});}catch{}}});
  await context.route('**/*',async route=>{try{if(!['GET','HEAD'].includes(route.request().method()))throw fail(400,'read_only','Only read-only website requests are allowed.');await checkedUrl(route.request().url());await route.continue();}catch{await route.abort('blockedbyclient').catch(()=>{});}});
  await context.routeWebSocket('**/*',route=>route.close());
  const token=crypto.randomBytes(32).toString('base64url');
  const key=crypto.createHash('sha256').update(token).digest('hex');
  const created=Date.now(); const session={key,context,pages:new Map(),created,touched:created,rateAt:created,credits:40};
  sessions.set(key,session);
  return {token,session};
 } finally {pendingSessions--;}
}
function auth(req) {
 const value=req.headers.authorization || '';
 if(!value.startsWith('Bearer ') || value.length > 150)throw fail(401,'session_required','Start a new browser session.');
 const key=crypto.createHash('sha256').update(value.slice(7)).digest('hex');
 const session=sessions.get(key);
 if(!session)throw fail(401,'session_expired','Your browser session expired. Reload to start again.');
 const now=Date.now();
 if(now-session.created>MAX_AGE_MS || now-session.touched>IDLE_MS){void closeSession(session);throw fail(401,'session_expired','Your browser session expired. Reload to start again.');}
 session.credits=Math.min(40,session.credits+(now-session.rateAt)/1000*20);session.rateAt=now;
 if(session.credits<1)throw fail(429,'rate_limited','Please slow down and try again.');
 session.credits--;session.touched=now;
 return session;
}
async function closeSession(session) { sessions.delete(session.key);await session.context.close().catch(()=>{});session.pages.clear(); }
async function metadata(record) {
 const viewport=record.page.viewportSize();
 const title=await record.page.title().catch(()=>record.title||'Website');
 const scrollRatio=await record.page.evaluate(()=>scrollY/Math.max(1,Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)-innerHeight)).catch(()=>0);
 return {title,url:record.page.url(),viewport,scrollRatio};
}
function pageRecord(session,id) { const record=session.pages.get(id);if(!record)throw fail(404,'page_not_found','This browser panel is no longer available.');return record; }
function queued(record,operation) { const result=record.chain.catch(()=>{}).then(operation);record.chain=result.then(()=>{},()=>{});return result; }
async function navigate(record,url) {
 const target=await checkedUrl(url);
 try { const response=await record.page.goto(target.href,{waitUntil:'domcontentloaded',timeout:25_000});if(response && response.status()>=400)throw fail(502,'website_error','The website returned an error.'); }
 catch(error){if(error.status)throw error;throw fail(502,'navigation_failed','The website could not be opened in this browser preview.');}
 record.image=null;return metadata(record);
}
async function makePage(session,body) {
 await checkedUrl(body.url);
 if(session.pages.size>=MAX_PAGES)throw fail(409,'panel_limit','You can open up to eight panels.');
 if(totalPages()>=GLOBAL_PAGES)throw fail(503,'browser_capacity','All live browser slots are in use. Close a live website panel and try again.');
 creating++;
 let page;
 try {
  page=await session.context.newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(25_000);
  await page.setViewportSize({width:int(body.width,1440,280,1920),height:int(body.height,900,280,1200)});
  page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));page.on('download',download=>download.cancel().catch(()=>{}));page.on('popup',popup=>popup.close().catch(()=>{}));
  const id=crypto.randomBytes(12).toString('hex');const record={id,page,chain:Promise.resolve(),image:null,imageAt:0};
  const meta=await navigate(record,body.url);session.pages.set(id,record);
  page.on('close',()=>session.pages.delete(id));
  return {pageId:id,metadata:meta};
 } catch(error){if(page)await page.close().catch(()=>{});throw error;} finally {creating--;}
}
async function input(record,body) {
 const viewport=record.page.viewportSize();const x=int(body.x,viewport.width/2,0,viewport.width-1),y=int(body.y,viewport.height/2,0,viewport.height-1);
 switch(body.type) {
  case 'click': await record.page.mouse.click(x,y,{button:['left','right','middle'].includes(body.button)?body.button:'left'});break;
  case 'wheel': await record.page.mouse.move(x,y);await record.page.mouse.wheel(int(body.deltaX,0,-2000,2000),int(body.deltaY,0,-2000,2000));break;
  case 'key': if(typeof body.key!=='string'||body.key.length>50)throw fail(400,'invalid_key','Invalid key.');await record.page.keyboard.press(body.key);break;
  case 'text': if(typeof body.text!=='string'||body.text.length>4000)throw fail(400,'invalid_text','Text is too long.');await record.page.keyboard.insertText(body.text);break;
  case 'resize': await record.page.setViewportSize({width:int(body.width,1440,280,1920),height:int(body.height,900,280,1200)});break;
  case 'scroll': {const ratio=Math.max(0,Math.min(1,Number(body.ratio)||0));await record.page.evaluate(value=>scrollTo(0,value*Math.max(0,Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)-innerHeight)),ratio);break;}
  default:throw fail(400,'invalid_input','Unsupported browser input.');
 }
 record.image=null;return metadata(record);
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.ttf':'font/ttf','.png':'image/png','.jpg':'image/jpeg','.json':'application/json; charset=utf-8'};
async function serveStatic(req,res,url) {
 const publicRoot=path.join(root,'public');
 let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{throw fail(400,'invalid_path','Invalid path.');}
 const target=path.resolve(publicRoot,'.'+(decoded==='/'?'/index.html':decoded));
 if(target!==publicRoot&&!target.startsWith(publicRoot+path.sep))throw fail(404,'not_found','Not found.');
 try {const data=await fs.readFile(target);res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});res.end(data);}catch(error){if(error.code==='ENOENT')throw fail(404,'not_found','Not found.');throw error;}
}
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/') && req.headers.origin) {
   let origin;try{origin=new URL(req.headers.origin);}catch{throw fail(403,'invalid_origin','Invalid request origin.');}
   if(origin.host!==req.headers.host)throw fail(403,'invalid_origin','Open Parallel directly to use the browser preview.');
  }
  if(url.pathname==='/healthz')return json(res,200,{ok:true,service:'parallel-browser',browserState,sandbox:sandboxEnabled,mode:publicBrowsing?'public':'allowlist',pages:totalPages()});
  if(req.method==='POST'&&url.pathname==='/api/sessions'){const {token}=await createSession();return json(res,201,{token,limits:{maxPages:MAX_PAGES,globalPages:GLOBAL_PAGES,idleSeconds:IDLE_MS/1000},mode:publicBrowsing?'public':'allowlist',allowedHosts:publicBrowsing?null:[...hosts]});}
  if(!url.pathname.startsWith('/api/')) {if(!['GET','HEAD'].includes(req.method))throw fail(405,'method_not_allowed','Method not allowed.');return await serveStatic(req,res,url);}
  const session=auth(req);
  if(req.method==='DELETE'&&url.pathname==='/api/session'){await closeSession(session);return json(res,200,{closed:true});}
  if(req.method==='POST'&&url.pathname==='/api/pages')return json(res,201,await makePage(session,await readJson(req)));
  const match=/^\/api\/pages\/([a-f0-9]{24})(?:\/(frame|input|navigate))?$/.exec(url.pathname);
  if(!match)throw fail(404,'not_found','Not found.');
  const record=pageRecord(session,match[1]);
  if(req.method==='GET'&&match[2]==='frame') {
   const image=await queued(record,async()=>{if(record.image&&Date.now()-record.imageAt<350)return record.image;record.image=await record.page.screenshot({type:'jpeg',quality:65,timeout:7000});record.imageAt=Date.now();return record.image;});
   res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(image);
  }
  if(req.method==='GET'&&!match[2])return json(res,200,{pageId:record.id,metadata:await queued(record,()=>metadata(record))});
  if(req.method==='DELETE'&&!match[2]){await queued(record,()=>record.page.close());session.pages.delete(record.id);return json(res,200,{closed:true});}
  if(req.method==='POST'&&match[2]==='navigate'){const body=await readJson(req);return json(res,200,{pageId:record.id,metadata:await queued(record,()=>navigate(record,body.url))});}
  if(req.method==='POST'&&match[2]==='input'){const body=await readJson(req);return json(res,200,{pageId:record.id,metadata:await queued(record,()=>input(record,body))});}
  throw fail(405,'method_not_allowed','Method not allowed.');
 } catch(error) {if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'The browser request failed. Please try again.',code:error.code||'internal_error'});else res.end();}
});
server.requestTimeout=30_000;server.headersTimeout=15_000;server.maxHeadersCount=30;
setInterval(()=>{const now=Date.now();for(const session of sessions.values())if(now-session.touched>IDLE_MS||now-session.created>MAX_AGE_MS)void closeSession(session);},30_000).unref();
async function shutdown(){server.close();await Promise.allSettled([...sessions.values()].map(closeSession));const b=await browserPromise?.catch(()=>null);await b?.close();const proxy=await proxyPromise?.catch(()=>null);await proxy?.close();process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
server.listen(port,'0.0.0.0',()=>console.log(`parallel_browser_ready port=${port} sandbox=${sandboxEnabled}`));

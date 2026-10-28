'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const browserView = window.ParallelBrowser;
const grid = $('#compare-grid');
const syncButton = $('#sync-button');
const positionRange = $('#scroll-position');
const ownedBlobs = new Set();
let syncEnabled = true;
let toastTimer;
let lastRatio = 0;
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 4300); }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join(''); }
const MAX_PANES = 8;
const paneTemplate = $('#pane-a').cloneNode(true);
let nextPaneId = 2;
function makePane(el, key) {
 return { key, label: '', el, stage: $('.pane-viewport', el), shell: $('.content-shell', el), input: $('.source-form input[type=text]', el), widthInput: $('.viewport-width input', el), zoom: $('.zoom-select', el), fileInput: $('.file-input', el), source: null, width: 1440, scale: 1, ratio: 0, ignoreUntil: 0, generation: 0, frame: null, channel: '', image: null, dragDepth: 0, weight: 1, removed: false, observer: null };
}
const panes = ['a', 'b'].map(key => makePane($('#pane-' + key), key));
function compatiblePanes() { return panes.filter(supported); }
function status(pane, message, kind = '') { const el = $('.source-status', pane.el); el.className = 'source-status' + (kind ? ' ' + kind : ''); $('span', el).textContent = message; }
function setProgress(pane, ratio) { pane.ratio = Math.max(0, Math.min(1, ratio || 0)); $('.pane-progress', pane.el).textContent = Math.round(pane.ratio * 100) + '%'; }
function supported(pane) { return pane.source && ['image', 'html', 'remote'].includes(pane.source.kind); }
function updateSyncUI() {
 const eligible = compatiblePanes();
 const available = eligible.length >= 2;
 syncButton.disabled = !available;
 syncButton.classList.toggle('unavailable', !available);
 syncButton.classList.toggle('active', available && syncEnabled);
 syncButton.setAttribute('aria-pressed', String(available && syncEnabled));
 syncButton.title = available ? 'Sync previews by scroll percentage' : 'Add at least two images, HTML files or browser views to sync scrolling';
 $('#sync-hint').textContent = available ? (syncEnabled ? `Scrolling synced across ${eligible.length} previews` : 'Previews scroll independently') : 'Add two previews to sync scrolling';
 positionRange.disabled = !panes.some(supported);
 $('#scroll-top').disabled = !panes.some(supported); $('#scroll-bottom').disabled = !panes.some(supported);
}
function updateGlobalProgress(ratio) { lastRatio = ratio; positionRange.value = String(Math.round(ratio * 1000)); $('#position-value').textContent = Math.round(ratio * 100) + '%'; }
function applyScroll(pane, ratio) {
 if (!supported(pane)) return;
 pane.ignoreUntil = performance.now() + 160;
 setProgress(pane, ratio);
 if (pane.source.kind === 'image') pane.stage.scrollTop = ratio * Math.max(0, pane.stage.scrollHeight - pane.stage.clientHeight);
 else if (pane.source.kind === 'remote') browserView.scroll(pane, ratio);
 else if (pane.frame) pane.frame.contentWindow.postMessage({ type: 'parallel-command', channel: pane.channel, action: 'scroll', ratio }, '*');
}
function userScrolled(pane, ratio) {
 setProgress(pane, ratio);
 if (performance.now() < pane.ignoreUntil) return;
 updateGlobalProgress(pane.ratio);
 if (syncEnabled && compatiblePanes().length >= 2) compatiblePanes().filter(p => p !== pane).forEach(p => applyScroll(p, pane.ratio));
}
function cleanupBlobs() { const active = new Set(panes.map(p => p.source?.uri)); for (const uri of ownedBlobs) if (!active.has(uri)) { URL.revokeObjectURL(uri); ownedBlobs.delete(uri); } }
function viewportPadding(pane) { const s = getComputedStyle(pane.stage); return { x: parseFloat(s.paddingLeft) + parseFloat(s.paddingRight), y: parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) }; }
function layout(pane, preserve = true) {
 if (pane.removed || !pane.source) return;
 if (pane.source.kind === 'remote') { browserView.layout(pane, preserve); return; }
 const previous = pane.ratio;
 const pad = viewportPadding(pane);
 const available = Math.max(70, pane.stage.clientWidth - pad.x);
 const baseWidth = pane.source.kind === 'image' ? (pane.image?.naturalWidth || pane.width) : pane.width;
 pane.scale = pane.zoom.value === 'fit' ? Math.min(1, available / baseWidth) : Number(pane.zoom.value);
 const displayWidth = Math.round(baseWidth * pane.scale);
 pane.shell.style.width = displayWidth + 'px';
 if (pane.source.kind === 'image') {
  pane.shell.style.height = pane.image?.naturalHeight ? Math.round(pane.image.naturalHeight * pane.scale) + 'px' : 'auto';
 } else if (pane.frame) {
  const innerHeight = Math.max(280, Math.floor((pane.stage.clientHeight - pad.y) / pane.scale));
  pane.frame.style.width = pane.width + 'px'; pane.frame.style.height = innerHeight + 'px'; pane.frame.style.transform = 'scale(' + pane.scale + ')';
  pane.shell.style.height = Math.round(innerHeight * pane.scale) + 'px';
 }
 const percent = Math.round(pane.scale * 100);
 pane.zoom.title = pane.zoom.value === 'fit' ? 'Fit to width: ' + percent + '%' : 'Zoom: ' + percent + '%';
 if (preserve) requestAnimationFrame(() => applyScroll(pane, previous));
}
function resetPane(pane) {
 browserView.detachPane(pane);
 pane.generation++; pane.source = null; pane.frame = null; pane.image = null; pane.shell.replaceChildren(); pane.shell.removeAttribute('style'); pane.shell.classList.remove('frame-shell'); pane.stage.scrollTop = 0; pane.stage.scrollLeft = 0;
 pane.el.classList.add('empty'); pane.input.value = ''; $('.open-source',pane.el).disabled=true; pane.widthInput.disabled = false; pane.widthInput.max = '3840'; pane.zoom.disabled = false; setProgress(pane, 0);
 $('.pane-heading h2', pane.el).textContent = 'Version ' + pane.label; $('.source-caption', pane.el).textContent = 'Website or mockup'; status(pane, 'Add a URL or file'); updateSyncUI(); browserView.cleanup();
}
function bridgeCode(channel) {
 return `(function(){const channel=${JSON.stringify(channel)};let suppressed=0,queued=false;function metrics(){const d=document.documentElement,b=document.body;const h=Math.max(d.scrollHeight,b?b.scrollHeight:0);return{height:h,viewport:innerHeight,ratio:scrollY/Math.max(1,h-innerHeight)}}function send(){queued=false;parent.postMessage(Object.assign({type:'parallel-metrics',channel:channel},metrics()),'*')}addEventListener('scroll',function(){if(performance.now()<suppressed)return;if(!queued){queued=true;requestAnimationFrame(send)}},{passive:true});addEventListener('message',function(e){if(e.source!==parent||!e.data||e.data.type!=='parallel-command'||e.data.channel!==channel)return;if(e.data.action==='scroll'){suppressed=performance.now()+180;const m=metrics();scrollTo(0,Math.max(0,Math.min(1,Number(e.data.ratio)||0))*Math.max(0,m.height-innerHeight))}if(e.data.action==='metrics')send()});addEventListener('load',send);addEventListener('resize',send);if(window.ResizeObserver&&document.body)new ResizeObserver(send).observe(document.body);document.addEventListener('click',function(e){const a=e.target.closest&&e.target.closest('a[href]');if(a&&!a.getAttribute('href').startsWith('#'))e.preventDefault()},true);send()})();`;
}
function hasSeparateResources(raw) {
 const doc = new DOMParser().parseFromString(raw, 'text/html');
 const embedded = value => !value.trim() || /^(data:|#)/i.test(value.trim());
 if ($$('script[src],link[rel="stylesheet"][href]', doc).some(el => (el.getAttribute('src') || el.getAttribute('href') || '').trim())) return true;
 if ($$('img[src],source[src],video[src],audio[src],video[poster]', doc).some(el => !embedded(el.getAttribute('src') || el.getAttribute('poster') || ''))) return true;
 const css = $$('style,[style]', doc).map(el => el.tagName === 'STYLE' ? el.textContent : el.getAttribute('style')).join('\n');
 if (/@import\b/i.test(css)) return true;
 return [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)].some(match => !embedded(match[1] ?? match[2] ?? match[3] ?? ''));
}
function prepareHtml(raw, pane) {
 const doc = new DOMParser().parseFromString(raw, 'text/html');
 pane.channel = uid();
 $$('base,meta[http-equiv],iframe,object,embed', doc).forEach(el => el.remove());
 $$('*', doc).forEach(el => { [...el.attributes].forEach(attr => { if (/^on/i.test(attr.name)) el.removeAttribute(attr.name); }); });
 $$('script[src]', doc).forEach(script => script.remove());
 $$('link[rel="stylesheet"],link[rel="preload"],link[rel="prefetch"],link[rel="icon"]', doc).forEach(el => el.remove());
 const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
 policy.content = "default-src 'none'; script-src 'unsafe-inline'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';";
 doc.head.prepend(policy);
 const style = doc.createElement('style'); style.textContent = 'html{scroll-behavior:auto!important}::-webkit-scrollbar{width:7px;height:7px}::-webkit-scrollbar-thumb{background:#89929e77;border-radius:4px}'; doc.head.append(style);
 const bridge = doc.createElement('script'); bridge.textContent = bridgeCode(pane.channel); doc.body.append(bridge);
 return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
async function renderSource(pane, source, preserveRatio = 0) {
 if (pane.removed) return;
 browserView.detachPane(pane);
 const generation = ++pane.generation; pane.source = source; pane.frame = null; pane.image = null; pane.shell.replaceChildren(); pane.shell.removeAttribute('style'); pane.shell.classList.remove('frame-shell'); pane.el.classList.remove('empty'); pane.stage.scrollTop = 0; pane.stage.scrollLeft = 0; setProgress(pane, preserveRatio);
 $('.pane-heading h2', pane.el).textContent = source.name;
 pane.input.value = source.url || '';
 pane.widthInput.disabled = source.kind === 'image'; pane.widthInput.max = source.kind === 'remote' ? '1920' : '3840';
 $('.open-source', pane.el).disabled = !source.url && source.kind !== 'image';
 if (source.kind === 'remote') {
  browserView.attach(pane, source);
 } else if (source.kind === 'image') {
  $('.source-caption', pane.el).textContent = source.isFile ? 'Image · local file' : 'Full-page image';
  const img = new Image(); pane.image = img; img.alt = source.name; img.draggable = false; pane.shell.append(img);
  img.onload = () => { if (generation !== pane.generation) return; layout(pane); status(pane, img.naturalWidth + ' × ' + img.naturalHeight + ' px · image'); applyScroll(pane, preserveRatio); };
  img.onerror = () => { if (generation === pane.generation) { status(pane, 'Could not open the image', 'error'); toast('Image unavailable. Please upload the file again.'); } };
  img.src = source.uri;
 } else {
  pane.shell.classList.add('frame-shell'); const frame = document.createElement('iframe'); pane.frame = frame; frame.title = source.name + ' — panel ' + pane.label; frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = prepareHtml(source.html, pane);
  $('.source-caption', pane.el).textContent = 'Interactive HTML · local preview';
  status(pane, 'HTML · embedded interactions enabled');
  frame.addEventListener('load', () => { if (generation !== pane.generation) return; layout(pane); if (supported(pane)) setTimeout(() => applyScroll(pane, preserveRatio), 80); });
  pane.shell.append(frame); layout(pane);
 }
 updateSyncUI(); browserView.cleanup();
}
function normalizeUrl(raw) {
 const value = raw.trim(); if (!value) throw new Error('Enter a website URL.');
 const prefixed = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : 'https://' + value;
 let url; try { url = new URL(prefixed); } catch { throw new Error('Please enter a valid website URL.'); }
 if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// URLs are supported.');
 if (url.username || url.password) throw new Error('Use a URL without an embedded username or password.');
 if (url.origin === location.origin && (url.pathname === location.pathname || url.pathname.endsWith('/index.html') || url.pathname === '/')) throw new Error('Parallel cannot be loaded inside itself.');
 return url;
}
function loadUrl(pane) {
 try { const url = normalizeUrl(pane.input.value); if (browserView.navigate(pane, url)) return; renderSource(pane, { kind:'remote', url:url.href, name:url.hostname }); cleanupBlobs(); } catch (error) { toast(error.message); }
}
async function loadFile(pane, file) {
 if (!file) return;
 if (file.size > 50 * 1024 * 1024) { toast('File exceeds 50 MB. Choose a smaller mockup.'); return; }
 
 if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(file.name)) {
  const uri = URL.createObjectURL(file); ownedBlobs.add(uri); await renderSource(pane, {kind:'image',uri,name:file.name,isFile:true}); cleanupBlobs();
 } else if (/\.html?$/i.test(file.name) || file.type === 'text/html') {
  const generation = ++pane.generation;
  const html = await file.text(); if (generation !== pane.generation) return;
  if (hasSeparateResources(html)) {
   if (!pane.source) status(pane, 'Missing assets · use a self-contained HTML', 'error');
   toast('This HTML needs separate CSS, scripts or images. Upload a self-contained HTML with all assets embedded, or open the published website URL.');
   return;
  }
  await renderSource(pane, {kind:'html',html,name:file.name,isFile:true}); cleanupBlobs();
  toast('HTML opened locally with embedded interactions. External resources are not loaded.');
 } else toast('Choose an image or HTML file. PDF, ZIP and Figma source files are not supported.');
}
function setupPane(pane) {
 $('.source-form', pane.el).addEventListener('submit', event => { event.preventDefault(); loadUrl(pane); });
 pane.fileInput.addEventListener('change', () => { loadFile(pane, pane.fileInput.files[0]); pane.fileInput.value = ''; });
 $('.file-button', pane.el).addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pane.fileInput.click(); } });
 $('.empty-upload', pane.el).addEventListener('click', () => pane.fileInput.click());
 $('.clear-source', pane.el).addEventListener('click', () => removePane(pane));
 $('.open-source', pane.el).addEventListener('click', () => { const url = pane.source?.url || pane.source?.uri; if (url) window.open(url, '_blank', 'noopener,noreferrer'); });
 $('.refresh-source', pane.el).addEventListener('click', () => { if (pane.source) { if (pane.source.kind === 'remote') browserView.reload(pane); else renderSource(pane, pane.source); updateGlobalProgress(0); } });
 pane.widthInput.addEventListener('change', () => { pane.width = Math.max(280, Math.min(3840, Number(pane.widthInput.value) || 1440)); pane.widthInput.value = String(pane.width); $$('[data-device]').forEach(button => button.setAttribute('aria-pressed', 'false')); layout(pane); });
 pane.zoom.addEventListener('change', () => layout(pane));
 function changeZoom(direction) { const stops = [.25,.5,.75,1,1.25,1.5,2]; const scale = pane.scale; const next = direction > 0 ? stops.find(s => s > scale + .02) : [...stops].reverse().find(s => s < scale - .02); if (next) { pane.zoom.value = String(next); layout(pane); } }
 $('.zoom-in', pane.el).addEventListener('click', () => changeZoom(1)); $('.zoom-out', pane.el).addEventListener('click', () => changeZoom(-1));
 pane.stage.addEventListener('scroll', () => { if (pane.source?.kind === 'image') userScrolled(pane, pane.stage.scrollTop / Math.max(1,pane.stage.scrollHeight-pane.stage.clientHeight)); }, { passive:true });
 pane.el.addEventListener('dragenter', event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); pane.dragDepth++; pane.el.classList.add('dragover'); });
 pane.el.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
 pane.el.addEventListener('dragleave', event => { event.preventDefault(); pane.dragDepth = Math.max(0,pane.dragDepth-1); if (!pane.dragDepth) pane.el.classList.remove('dragover'); });
 pane.el.addEventListener('drop', event => { event.preventDefault(); pane.dragDepth=0; pane.el.classList.remove('dragover'); const files=event.dataTransfer.files; if(files.length>1) toast('Opening the first file. Add other files to separate panels.'); loadFile(pane,files[0]); });
 pane.observer = new ResizeObserver(() => layout(pane)); pane.observer.observe(pane.stage);
}
window.addEventListener('message', event => {
 const pane = panes.find(p => p.frame && event.source === p.frame.contentWindow && p.channel === event.data?.channel);
 if (!pane || event.data?.type !== 'parallel-metrics' || !supported(pane)) return;
 const ratio = Number(event.data.ratio); if (Number.isFinite(ratio)) userScrolled(pane, ratio);
});
syncButton.addEventListener('click', () => { syncEnabled=!syncEnabled; updateSyncUI(); if(syncEnabled) panes.forEach(pane=>applyScroll(pane,lastRatio)); });
function commonScroll(ratio) { updateGlobalProgress(ratio); panes.forEach(pane=>applyScroll(pane,ratio)); }
positionRange.addEventListener('input', () => commonScroll(Number(positionRange.value)/1000)); $('#scroll-top').addEventListener('click',()=>commonScroll(0)); $('#scroll-bottom').addEventListener('click',()=>commonScroll(1));
$$('[data-device]').forEach(button=>button.addEventListener('click',()=>{const width=Number(button.dataset.device);panes.forEach(pane=>{pane.width=width;pane.widthInput.value=String(width);pane.zoom.value='fit';layout(pane)});$$('[data-device]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));if(panes.every(p=>p.source?.kind==='image'))toast('Images have a fixed layout. Viewport width changes the layout of websites and HTML only.');}));
$('#swap-button').addEventListener('click',()=>{const sources=panes.map(p=>p.source);const ratios=panes.map(p=>p.ratio);panes.forEach((pane,index)=>{const from=(index+1)%panes.length;renderSourceOrEmpty(pane,sources[from],ratios[from]);});toast(panes.length===2?'Versions swapped.':'Sources rotated by one panel.');});
function renderSourceOrEmpty(pane,source,ratio){if(source)renderSource(pane,source,ratio);else resetPane(pane)}
function updateGridColumns() {
 grid.style.gridTemplateColumns = panes.map(pane => `minmax(0,${pane.weight}fr)`).join(' var(--separator-width,16px) ');
 $$('.splitter', grid).forEach((splitter,index)=>splitter.setAttribute('aria-valuenow',String(Math.round(panes[index].weight/(panes[index].weight+panes[index+1].weight)*100))));
}
function equalizePanels() { panes.forEach(pane=>{pane.weight=1;}); updateGridColumns(); }
function makeSplitter(left,right) {
 const splitter=document.createElement('div'); splitter.className='splitter'; splitter.tabIndex=0; splitter.setAttribute('role','separator');splitter.setAttribute('aria-orientation','vertical');splitter.setAttribute('aria-valuemin','20');splitter.setAttribute('aria-valuemax','80');splitter.setAttribute('aria-label',`Resize panels ${left.label} and ${right.label}`);splitter.title='Drag to resize. Double-click for equal widths';
 for(let i=0;i<3;i++)splitter.append(document.createElement('span'));
 let drag=null;
 function setPair(fraction){const value=Math.max(.2,Math.min(.8,fraction));const total=left.weight+right.weight;left.weight=total*value;right.weight=total*(1-value);updateGridColumns();}
 splitter.addEventListener('pointerdown',event=>{event.preventDefault();const a=left.el.getBoundingClientRect(),b=right.el.getBoundingClientRect();drag={left:a.left,width:b.right-a.left};splitter.setPointerCapture(event.pointerId);document.body.classList.add('resizing');});
 splitter.addEventListener('pointermove',event=>{if(drag&&splitter.hasPointerCapture(event.pointerId))setPair((event.clientX-drag.left)/drag.width);});
 function stop(){drag=null;document.body.classList.remove('resizing');}
 ['pointerup','pointercancel','lostpointercapture'].forEach(name=>splitter.addEventListener(name,stop));splitter.addEventListener('dblclick',equalizePanels);
 splitter.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setPair(left.weight/(left.weight+right.weight)+(event.key==='ArrowRight'?.02:-.02));}if(event.key==='Home'){event.preventDefault();equalizePanels();}});
 return splitter;
}
function labelPane(pane,index) {
 const label=String.fromCharCode(65+index);pane.label=label;pane.el.setAttribute('aria-label','Panel '+label);$('.pane-letter',pane.el).textContent=label;
 $('.sr-only',pane.el).textContent='Website URL '+label;
 $('.load-url',pane.el).setAttribute('aria-label','Load website '+label);
 $('.file-button',pane.el).setAttribute('aria-label','Upload a file to panel '+label);
 $('.open-source',pane.el).setAttribute('aria-label','Open source '+label+' in a new tab');
 const remove=$('.clear-source',pane.el);remove.setAttribute('aria-label','Remove panel '+label);remove.title=panes.length===1?'Keep at least one panel':'Remove panel';remove.disabled=panes.length===1;
 pane.widthInput.setAttribute('aria-label','Viewport width for panel '+label+' in pixels');pane.zoom.setAttribute('aria-label','Zoom '+label);
 $('.zoom-out',pane.el).setAttribute('aria-label','Decrease zoom in panel '+label);$('.zoom-in',pane.el).setAttribute('aria-label','Increase zoom in panel '+label);$('.refresh-source',pane.el).setAttribute('aria-label','Reload panel '+label);
 pane.stage.setAttribute('aria-label','Preview area '+label);$('.empty-state h3',pane.el).textContent='Version '+label;
 if(!pane.source)$('.pane-heading h2',pane.el).textContent='Version '+label;
 if(pane.frame)pane.frame.title=pane.source.name+' — panel '+label;
}
function refreshPanelGrid() {
 $$('.splitter',grid).forEach(el=>el.remove());
 panes.forEach(labelPane);
 panes.forEach(pane=>{if(!pane.el.isConnected)grid.append(pane.el);});
 for(let i=0;i<panes.length-1;i++)grid.insertBefore(makeSplitter(panes[i],panes[i+1]),panes[i+1].el);
 $('.workspace-title h1 span').textContent=' / '+String(panes.length).padStart(2,'0');
 const add=$('#add-pane-button');add.disabled=panes.length>=MAX_PANES;add.title=panes.length>=MAX_PANES?'Up to 8 panels at once':'Add a website or mockup';
 const rotate=$('#swap-button');rotate.disabled=panes.length<2;rotate.setAttribute('aria-label',panes.length===2?'Swap sources':'Rotate sources');$('.button-label',rotate).textContent=panes.length===2?'Swap':'Rotate';
 $('#reset-split').textContent=panes.length===2?'50 / 50':panes.length===1?'Full width':'Equal widths';
 equalizePanels();updateSyncUI();
}
function addPane(announce=true) {
 if(panes.length>=MAX_PANES){if(announce)toast('You can open up to 8 panels at once.');return null;}
 const key='p'+(++nextPaneId);const el=paneTemplate.cloneNode(true);el.id='pane-'+key;el.dataset.side=key;
 $$('[id]',el).forEach(node=>{const old=node.id;node.id=old.replace(/-a$/,'-'+key);$$('label[for]',el).filter(label=>label.htmlFor===old).forEach(label=>label.htmlFor=node.id);});
 const pane=makePane(el,key);pane.width=panes[0]?.width||1440;pane.widthInput.value=String(pane.width);pane.input.value='';panes.push(pane);setupPane(pane);resetPane(pane);refreshPanelGrid();
 if(announce){pane.input.focus();toast('Panel '+pane.label+' added. Enter a URL or upload a mockup.');}
 return pane;
}
function removePane(pane,announce=true) {
 if(panes.length<=1||pane.removed)return;
 pane.generation++;pane.removed=true;pane.observer?.disconnect();browserView.detachPane(pane);pane.source=null;pane.frame=null;pane.channel='';pane.image=null;pane.el.remove();panes.splice(panes.indexOf(pane),1);cleanupBlobs();refreshPanelGrid();browserView.cleanup();
 if(announce)toast('Panel removed. The remaining panels fill the space.');
}
$('#add-pane-button').addEventListener('click',()=>addPane());$('#reset-split').addEventListener('click',equalizePanels);
$('#focus-button').addEventListener('click',()=>{const active=document.body.classList.toggle('focus-mode');$('#focus-button').setAttribute('aria-pressed',String(active));});
$('#help-button').addEventListener('click',()=>$('#help-dialog').showModal());$$('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close()}}));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('focus-mode')){document.body.classList.remove('focus-mode');$('#focus-button').setAttribute('aria-pressed','false')}});
window.addEventListener('pagehide',event=>{if(!event.persisted)ownedBlobs.forEach(uri=>URL.revokeObjectURL(uri));});
browserView.configure({ panes, status, setProgress, userScrolled, updateSyncUI, viewportPadding, toast });
panes.forEach(setupPane);refreshPanelGrid();panes.forEach(resetPane);

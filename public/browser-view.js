'use strict';

window.ParallelBrowser = (() => {
 const sources = new Set();
 let hooks;
 let sessionToken = '';
 let sessionPromise;
 let pollTimer;
 let polling = false;
 let pollAgain = false;
 let cleanupQueued = false;
 let stopping = false;
 let sessionVersion = 0;
 let pollEpoch = 0;
 const select = (selector, root) => root.querySelector(selector);
 const activePane = source => hooks.panes.find(pane => !pane.removed && pane.source === source);
 const stateOf = source => source.browser;
 const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
 const retryDelays = [1000, 2000, 4000, 8000, 15000];
 const sessionMissing = error => error.status === 401 || (error.status === 404 && error.code === 'page_not_found');
 const transientError = error => error.transient === true || [429,502,503,504].includes(error.status) ||
  ['frame_timeout','frame_timed_out','metadata_timeout','metadata_timed_out','browser_capacity_soft'].includes(error.code);

 async function fetchResponse(url, options = {}, token = sessionToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 35_000);
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, {once:true});
  const headers = {'Accept': options.image ? 'image/jpeg' : 'application/json'};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
   const response = await fetch(url, {
    method: options.method || 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: controller.signal, cache: 'no-store', credentials: 'same-origin', keepalive: options.keepalive === true,
   });
   if (!response.ok) {
    let payload;
    try { payload = await response.json(); } catch {}
    const error = new Error(payload?.error || 'The browser preview could not respond. Please reload this panel.');
    error.code = payload?.code || 'request_failed'; error.status = response.status;
    error.transient = [429,502,503,504].includes(response.status) || (!payload && response.status >= 500);
    if (response.status === 401 && token && token === sessionToken) { sessionVersion++; sessionToken = ''; sessionPromise = null; }
    throw error;
   }
   return response;
  } catch (error) {
   if (error.name === 'AbortError' && !options.signal?.aborted) {
    const timeoutError = new Error('The browser took too long to respond. Please reload this panel.');
    timeoutError.code = 'request_timeout'; timeoutError.transient = true; throw timeoutError;
   }
   if (error instanceof TypeError && !error.status) { error.code = 'network_error'; error.transient = true; }
   throw error;
  } finally {
   clearTimeout(timeout);
   options.signal?.removeEventListener('abort', abort);
  }
 }
 async function request(url, options, token) {
  const response = await fetchResponse(url, options, token);
  try { return await response.json(); }
  catch (cause) {
   const error = new Error('The browser returned an incomplete response.');
   error.code = 'invalid_response'; error.status = response.status; error.transient = true; throw error;
  }
 }
 async function ensureSession() {
  if (sessionToken) return sessionToken;
  if (!sessionPromise) {
   const version = sessionVersion;
   sessionPromise = request('/api/sessions', {method:'POST',timeoutMs:75_000}, '').then(result => {
    if (!result.token) throw new Error('Browser view is unavailable on this host.');
    if (stopping || version !== sessionVersion) {
     void fetch('/api/session', {method:'DELETE',headers:{Authorization:'Bearer '+result.token},keepalive:true}).catch(() => {});
     throw new DOMException('Browser session request was cancelled.', 'AbortError');
    }
    sessionToken = result.token;
    const slots = Number(result.limits?.globalPages);
    const capacity = document.querySelector('#browser-capacity');
    if (capacity && Number.isFinite(slots)) capacity.textContent = 'Live-browser capacity: ' + slots + ' shared slots. Up to eight panels can hold websites, HTML files or images.';
    return sessionToken;
   }).catch(error => { if (version === sessionVersion) sessionPromise = null; throw error; });
  }
  return sessionPromise;
 }
 function message(pane, text, error = false, reconnecting = false) {
  let card = select('.browser-message', pane.shell);
  if (!card) {
   card = document.createElement('div'); card.className = 'browser-message'; card.setAttribute('role', 'status');
   const title = document.createElement('strong'); title.className = 'browser-message-title';
   const body = document.createElement('span'); body.className = 'browser-message-body';
   const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Reload browser view';
   retry.addEventListener('click', () => reload(pane)); card.append(title, body, retry); pane.shell.append(card);
  }
  select('strong', card).textContent = error ? 'Browser view unavailable' : reconnecting ? 'Reconnecting…' : 'Opening website';
  select('.browser-message-body', card).textContent = text;
  select('button', card).hidden = !error;
  card.classList.toggle('error', error); card.hidden = false;
 }
 function hideMessage(pane) { const card = select('.browser-message', pane.shell); if (card) card.hidden = true; }
 function prepareRecovery(source) {
  const state = stateOf(source); const pane = activePane(source);
  state.restoreRatio = clamp(pane?.ratio ?? state.metadata?.scrollRatio ?? 0, 0, 1);
  state.version++; cancelPending(state); state.frameController?.abort(); state.metadataController?.abort(); state.navigationController?.abort();
  clearTimeout(state.resizeTimer); clearTimeout(state.wheelTimer); clearTimeout(state.scrollTimer);
  state.id = null; state.token = ''; state.ready = null; state.chain = Promise.resolve();
  state.creating = false; state.navigating = false; state.pendingNavigation = '';
  state.requestId = ''; state.pendingSize = null; state.wheel = null; state.wheelTimer = null; state.scrollTimer = null;
  state.metadataPromise = null; state.metadataController = null;
 }
 function showError(source, error) {
  const state = stateOf(source); if (!state || state.closed || error.name === 'AbortError') return;
  const pane = activePane(source); if (!pane) return;
  const recover = sessionMissing(error);
  if (recover) prepareRecovery(source);
  if (recover || transientError(error)) {
   if (state.retrying && Date.now() < state.nextPoll) return;
   if (state.retryAttempts < retryDelays.length) {
    const delay = retryDelays[state.retryAttempts++];
    state.failed = false; state.retrying = true; state.forceFrame = true; state.nextPoll = Date.now() + delay;
    if (state.imageUri) hideMessage(pane);
    else message(pane, 'Waiting for the browser to respond. Your page will reconnect automatically.', false, true);
    hooks.status(pane, 'Reconnecting…', 'external'); schedulePoll(delay, true); return;
   }
  }
  state.failed = true; state.retrying = false;
  hooks.status(pane, error.message || 'Browser view unavailable', 'error');
  message(pane, error.message || 'Please reload this panel.', true);
 }
 function updateMetadata(source, metadata, userInput = false) {
  const state = stateOf(source); const pane = activePane(source);
  if (!state || state.closed || !pane || !metadata) return;
  state.metadata = metadata;
  state.lastMetaAt = Date.now();
  if (metadata.title) select('.pane-heading h2', pane.el).textContent = metadata.title;
  if (metadata.url && /^https?:\/\//i.test(metadata.url)) {
   source.url = metadata.url;
   if (document.activeElement !== pane.input) pane.input.value = metadata.url;
  }
  const ratio = Number(metadata.scrollRatio);
  if (Number.isFinite(ratio) && Math.abs(ratio - pane.ratio) > .0005) {
   if (!userInput && performance.now() < state.suppressUntil) hooks.setProgress(pane, ratio);
   else hooks.userScrolled(pane, ratio);
  }
 }
 function queue(source, input, userInput = false) {
  const state = stateOf(source);
  if (!state || state.closed || state.failed || state.retrying || state.navigating) return Promise.resolve();
  const version = state.version;
  const work = state.chain.catch(() => {}).then(async () => {
   await state.ready;
   if (state.closed || state.failed || state.retrying || state.navigating || state.version !== version || !state.id) return;
   const result = await request('/api/pages/' + encodeURIComponent(state.id) + '/input', {method:'POST', body:input}, state.token);
   if (state.closed || state.version !== version) return;
   updateMetadata(source, result.metadata, userInput);
   state.nextPoll = 0; state.forceFrame = true;
   schedulePoll(250, true);
  });
  state.chain = work.catch(error => { if (state.version === version) showError(source, error, true); });
  return work;
 }
 function requestedSize(pane) {
  const padding = hooks.viewportPadding(pane);
  const availableWidth = Math.max(70, pane.stage.clientWidth - padding.x);
  const width = clamp(Math.round(pane.width), 280, 1920);
  const scale = pane.zoom.value === 'fit' ? Math.min(1, availableWidth / width) : Number(pane.zoom.value);
  const height = clamp(Math.floor((pane.stage.clientHeight - padding.y) / scale), 280, 1200);
  return {width, height, scale};
 }
 function layout(pane, preserve = true) {
  const source = pane.source; const state = stateOf(source);
  if (!state || state.closed || pane.removed) return;
  const size = requestedSize(pane);
  pane.width = size.width; pane.widthInput.value = String(size.width); pane.scale = size.scale;
  pane.shell.style.width = Math.round(size.width * size.scale) + 'px';
  pane.shell.style.height = Math.round(size.height * size.scale) + 'px';
  pane.zoom.title = (pane.zoom.value === 'fit' ? 'Fit to width: ' : 'Zoom: ') + Math.round(size.scale * 100) + '%';
  const previous = state.pendingSize || state.metadata?.viewport || state.initialSize;
  if (!previous || previous.width !== size.width || previous.height !== size.height) {
   state.pendingSize = {width:size.width, height:size.height};
   clearTimeout(state.resizeTimer);
   state.resizeTimer = setTimeout(() => {
    const pending = state.pendingSize; state.pendingSize = null;
    if (state.closed || !pending || !state.id) return;
    state.suppressUntil = performance.now() + 2000;
    const previousRatio = pane.ratio;
    queue(source, {type:'resize', ...pending}).then(() => {
     if (preserve && activePane(source)) return queue(source, {type:'scroll', ratio:previousRatio});
    }).catch(() => {});
   }, 220);
  }
 }
 function point(pane, event) {
  const rect = pane.image.getBoundingClientRect();
  const viewport = stateOf(pane.source).metadata?.viewport || stateOf(pane.source).initialSize;
  return {
   x: clamp(Math.round((event.clientX - rect.left) / Math.max(1, rect.width) * viewport.width), 0, viewport.width - 1),
   y: clamp(Math.round((event.clientY - rect.top) / Math.max(1, rect.height) * viewport.height), 0, viewport.height - 1),
  };
 }
 function attachInput(pane, source, image) {
  image.addEventListener('click', event => {
   if (pane.source !== source || !stateOf(source).id || stateOf(source).failed) return;
   image.focus({preventScroll:true});
   queue(source, {type:'click', ...point(pane, event), button:'left'}, true).catch(() => {});
  });
  image.addEventListener('wheel', event => {
   if (pane.source !== source || !stateOf(source).id || stateOf(source).failed) return;
   event.preventDefault();
   const state = stateOf(source); const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pane.stage.clientHeight : 1;
   if (!state.wheel) state.wheel = {deltaX:0,deltaY:0,...point(pane,event)};
   state.wheel.deltaX += event.deltaX * multiplier / pane.scale;
   state.wheel.deltaY += event.deltaY * multiplier / pane.scale;
   Object.assign(state.wheel, point(pane,event));
   if (!state.wheelTimer) state.wheelTimer = setTimeout(() => {
    state.wheelTimer = null; const wheel = state.wheel; state.wheel = null;
    if (wheel) queue(source, {type:'wheel',...wheel}, true).catch(() => {});
   }, 160);
  }, {passive:false});
  image.addEventListener('keydown', event => {
   if (pane.source !== source || !stateOf(source).id || stateOf(source).failed) return;
   if (['Control','Shift','Meta','Alt'].includes(event.key)) return;
   if (event.metaKey || (event.ctrlKey && ['w','t','l','r','n','v'].includes(event.key.toLowerCase()))) return;
   event.preventDefault();
   if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey) {
    queue(source, {type:'text',text:event.key}, true).catch(() => {});
   } else {
    const key = event.key === ' ' ? 'Space' : event.key;
    const modifiers = [event.ctrlKey && 'Control',event.altKey && 'Alt',event.shiftKey && 'Shift'].filter(Boolean);
    queue(source, {type:'key',key:[...modifiers,key].join('+')}, true).catch(() => {});
   }
  });
  image.addEventListener('paste', event => {
   if (pane.source !== source || !stateOf(source).id || stateOf(source).failed) return;
   const text = event.clipboardData?.getData('text/plain'); if (!text) return;
   event.preventDefault(); queue(source, {type:'text',text:text.slice(0,4000)}, true).catch(() => {});
  });
 }
 function newState() {
  return {id:null, token:'', metadata:null, imageUri:'', closed:false, failed:false, version:1,
   ready:null, chain:Promise.resolve(), initialSize:null, pendingSize:null, resizeTimer:null,
   wheel:null,wheelTimer:null,scrollRatio:null,scrollTimer:null, frameController:null,
   creating:false,requestId:'',creationController:null,restoreRatio:0,
   retryAttempts:0,retrying:false,navigating:false,pendingNavigation:'',navigationController:null,
   metadataPromise:null,metadataController:null,lastMetaAttempt:0,
   lastFrameAt:0,lastMetaAt:0,forceFrame:true,nextPoll:0,suppressUntil:0};
 }
 async function create(source) {
  const state = stateOf(source); const version = state.version;
  const token = await ensureSession();
  if (state.closed || version !== state.version || !activePane(source)) return;
  state.token = token;
  const pane = activePane(source); const size = requestedSize(pane); state.initialSize = {width:size.width,height:size.height};
  const requestId = crypto.randomUUID(); const controller = new AbortController();
  state.requestId = requestId; state.creationController = controller; state.creating = true;
  try {
   let result = await request('/api/pages', {method:'POST', body:{url:source.url,requestId,...state.initialSize},signal:controller.signal,timeoutMs:75_000}, token);
   if (state.closed || version !== state.version || !activePane(source)) {
    void request('/api/pages/cancel', {method:'POST',body:{requestId}}, token).catch(() => {});
    await request('/api/pages/' + encodeURIComponent(result.pageId), {method:'DELETE'}, token).catch(() => {}); return;
   }
   state.id = result.pageId;
   if (state.restoreRatio > 0) {
    state.suppressUntil = performance.now() + 2000;
    result = await request('/api/pages/' + encodeURIComponent(state.id) + '/input', {method:'POST',body:{type:'scroll',ratio:state.restoreRatio}}, token);
   }
   if (state.closed || state.version !== version) return;
   updateMetadata(source, result.metadata);
   layout(activePane(source), false);
   if (!state.retrying) hooks.status(activePane(source), 'Browser view · click, scroll or type');
   schedulePoll(0, true);
  } catch (error) {
   if (!state.id || state.closed || state.version !== version) void request('/api/pages/cancel', {method:'POST',body:{requestId},keepalive:state.closed}, token).catch(() => {});
   throw error;
  } finally {
   if (state.requestId === requestId) { state.requestId = ''; state.creating = false; }
   if (state.creationController === controller) state.creationController = null;
  }
 }
 function startCreation(source) {
  const state = stateOf(source); const version = state.version;
  if (state.creating) return state.ready;
  state.creating = true; state.chain = Promise.resolve();
  const ready = create(source); state.ready = ready;
  ready.then(() => {
   if (state.version === version && state.ready === ready) state.creating = false;
  }, error => {
   if (state.version !== version || state.ready !== ready) return;
   state.creating = false; showError(source,error);
  });
  return ready;
 }
 function cancelPending(state, keepalive = false) {
  state.creationController?.abort();
  if (state.requestId && state.token) void request('/api/pages/cancel', {method:'POST',body:{requestId:state.requestId},keepalive}, state.token).catch(() => {});
 }
 function attach(pane, source) {
  if (!source.browser || source.browser.closed) source.browser = newState();
  const state = stateOf(source); sources.add(source);
  pane.shell.classList.add('browser-shell'); pane.stage.classList.add('browser-stage');
  const image = document.createElement('img'); image.className = 'browser-image'; image.alt = 'Browser preview of ' + source.name;
  image.tabIndex = 0; image.draggable = false; image.setAttribute('role','application');
  image.setAttribute('aria-label','Interactive browser preview of ' + source.name + '. Click to interact, scroll or type.');
  pane.image = image; pane.shell.append(image); attachInput(pane, source, image);
  select('.source-caption', pane.el).textContent = 'Browser view · Chromium';
  if (state.imageUri) image.src = state.imageUri;
  else { image.hidden = true; message(pane, 'Starting a browser and loading the page. The first start can take about a minute.'); }
  layout(pane, false);
  if (state.failed) message(pane, 'Please reload this browser panel.', true);
  else if (state.retrying) {
   if (state.imageUri) hideMessage(pane);
   hooks.status(pane, 'Reconnecting…', 'external'); schedulePoll();
  } else if (!state.ready) {
   hooks.status(pane, 'Opening browser view…');
   startCreation(source);
  } else { hooks.status(pane, 'Browser view · click, scroll or type'); schedulePoll(); }
 }
 function detachPane(pane) {
  pane.shell.classList.remove('browser-shell'); pane.stage.classList.remove('browser-stage');
  for (const notice of pane.stage.querySelectorAll('.embedding-notice')) notice.remove();
 }
 async function closeSource(source) {
  const state = stateOf(source); if (!state || state.closed) return;
  state.closed = true; state.version++;
  clearTimeout(state.resizeTimer); clearTimeout(state.wheelTimer); clearTimeout(state.scrollTimer);
  cancelPending(state);
  state.frameController?.abort(); state.metadataController?.abort(); state.navigationController?.abort();
  if (state.imageUri) { URL.revokeObjectURL(state.imageUri); state.imageUri = ''; }
  sources.delete(source);
  if (state.id && state.token) await request('/api/pages/' + encodeURIComponent(state.id), {method:'DELETE'}, state.token).catch(() => {});
 }
 function cleanup() {
  if (cleanupQueued || !hooks) return;
  cleanupQueued = true;
  queueMicrotask(() => {
   cleanupQueued = false;
   for (const source of sources) if (!activePane(source)) void closeSource(source);
  });
 }
 function scroll(pane, ratio) {
  const source = pane.source; const state = stateOf(source); if (!state || state.closed || state.failed) return;
  if (state.retrying || state.navigating) { state.restoreRatio = clamp(ratio,0,1); return; }
  state.scrollRatio = clamp(ratio,0,1); state.suppressUntil = performance.now() + 2000;
  if (state.scrollTimer) return;
  state.scrollTimer = setTimeout(() => {
   state.scrollTimer = null; const target = state.scrollRatio; state.scrollRatio = null;
   queue(source, {type:'scroll',ratio:target}).catch(() => {});
  }, 100);
 }
 function refreshMetadata(source) {
  const state = stateOf(source); const version = state.version;
  if (!state.id || state.closed || state.failed || state.retrying || state.metadataPromise || Date.now() - Math.max(state.lastMetaAt,state.lastMetaAttempt) < 5000) return;
  const controller = new AbortController(); state.metadataController = controller; state.lastMetaAttempt = Date.now();
  const pending = request('/api/pages/' + encodeURIComponent(state.id), {signal:controller.signal,timeoutMs:8000}, state.token).then(result => {
   if (!state.closed && state.version === version && !result.metadata?.stale) updateMetadata(source, result.metadata);
  }).catch(error => {
   if (!state.closed && state.version === version && sessionMissing(error)) showError(source,error);
  }).finally(() => {
   if (state.metadataPromise === pending) state.metadataPromise = null;
   if (state.metadataController === controller) state.metadataController = null;
  });
  state.metadataPromise = pending;
 }
 async function refreshSource(source) {
  const state = stateOf(source); const version = state.version;
  if (state.closed || state.failed || !activePane(source) || Date.now() < state.nextPoll || state.creating || state.navigating) return;
  if (!state.id) { void startCreation(source); return; }
  if (state.pendingNavigation) { void reload(activePane(source),true); return; }
  if (!state.forceFrame && Date.now() - state.lastFrameAt < 1900) return;
  state.forceFrame = false;
  const controller = new AbortController(); state.frameController = controller;
  try {
   const response = await fetchResponse('/api/pages/' + encodeURIComponent(state.id) + '/frame', {image:true,signal:controller.signal}, state.token);
   const blob = await response.blob();
   if (state.closed || state.version !== version || !activePane(source)) return;
   const uri = URL.createObjectURL(blob); const old = state.imageUri; state.imageUri = uri;
   const pane = activePane(source); pane.image.src = uri; pane.image.hidden = false; hideMessage(pane);
   state.lastFrameAt = Date.now();
   if (old) URL.revokeObjectURL(old);
   if (response.headers.get('X-Preview-Stale') === '1') {
    showError(source, Object.assign(new Error('The browser is still reconnecting. Please reload this panel.'), {code:'frame_stale',transient:true}));
   } else {
    const reconnected = state.retrying;
    state.retrying = false; state.retryAttempts = 0; state.nextPoll = 0;
    hooks.status(pane, 'Browser view · click, scroll or type');
    if (reconnected) layout(pane);
    refreshMetadata(source);
   }
  } catch (error) { if (state.version === version) showError(source, error); }
  finally { if (state.frameController === controller) state.frameController = null; }
 }
 function schedulePoll(delay = 2000, urgent = false) {
  if (stopping || document.hidden || !hooks) return;
  if (polling) { if (urgent) pollAgain = true; return; }
  if (pollTimer && urgent) { clearTimeout(pollTimer); pollTimer = null; }
  if (pollTimer) return;
  const epoch = pollEpoch;
  pollTimer = setTimeout(async () => {
   pollTimer = null;
   if (stopping || document.hidden || epoch !== pollEpoch) return;
   polling = true;
   try { for (const source of sources) { if (stopping || epoch !== pollEpoch) break; if (activePane(source)) await refreshSource(source); } }
   finally { if (epoch === pollEpoch) { polling = false; const urgentNext = pollAgain; pollAgain = false; if ([...sources].some(source => !stateOf(source).failed && !stateOf(source).closed)) schedulePoll(urgentNext ? 250 : 2000); } }
  }, delay);
 }
 async function reload(pane, retrying = false) {
  const source = pane.source; const state = stateOf(source); if (!state || state.closed) return;
  cancelPending(state);
  const version = ++state.version;
  state.failed = false; state.nextPoll = 0; state.frameController?.abort(); state.metadataController?.abort(); state.navigationController?.abort();
  state.metadataPromise = null; state.metadataController = null; state.creating = false; state.requestId = '';
  state.restoreRatio = clamp(pane.ratio,0,1); state.retrying = retrying;
  if (!retrying) state.retryAttempts = 0;
  clearTimeout(state.resizeTimer); clearTimeout(state.wheelTimer); clearTimeout(state.scrollTimer);
  state.pendingSize = null; state.wheel = null; state.wheelTimer = null; state.scrollTimer = null;
  if (state.imageUri) hideMessage(pane);
  else message(pane, 'Reloading this browser page.', false, retrying);
  hooks.status(pane, retrying ? 'Reconnecting…' : 'Reloading browser view…', retrying ? 'external' : undefined);
  const controller = new AbortController(); state.navigationController = controller; state.navigating = true;
  try {
   if (state.id && state.token && state.token === sessionToken) {
    state.pendingNavigation = state.pendingNavigation || source.url;
    const result = await request('/api/pages/' + encodeURIComponent(state.id) + '/navigate', {method:'POST',body:{url:state.pendingNavigation},signal:controller.signal,timeoutMs:75_000}, state.token);
    if (state.version !== version || state.closed) return;
    state.pendingNavigation = '';
    state.ready = Promise.resolve(); state.chain = Promise.resolve(); updateMetadata(source, result.metadata); state.lastFrameAt = 0; state.forceFrame = true; schedulePoll(0, true);
   } else {
    state.id = null; state.pendingNavigation = ''; state.chain = Promise.resolve();
    await startCreation(source).catch(() => {});
   }
  } catch (error) {
   if (state.closed || state.version !== version) return;
   showError(source,error);
  } finally {
   if (state.navigationController === controller) state.navigationController = null;
   if (state.version === version) state.navigating = false;
  }
 }
 function navigate(pane, url) {
  if (pane.source?.kind !== 'remote') return false;
  const source = pane.source; const state = stateOf(source);
  if (!state || !state.id || state.closed || state.failed || state.token !== sessionToken) return false;
  source.url = url.href; source.name = url.hostname; pane.input.value = url.href;
  select('.pane-heading h2', pane.el).textContent = url.hostname;
  if (pane.image) {
   pane.image.alt = 'Browser preview of ' + source.name;
   pane.image.setAttribute('aria-label', 'Interactive browser preview of ' + source.name + '. Click to interact, scroll or type.');
  }
  hooks.setProgress(pane, 0);
  void reload(pane);
  return true;
 }
 document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(pollTimer); pollTimer = null; }
  else schedulePoll(0);
 });
 window.addEventListener('pagehide', () => {
  stopping = true; sessionVersion++; pollEpoch++; clearTimeout(pollTimer); pollTimer = null; pollAgain = false; polling = false;
  const token = sessionToken; sessionToken = ''; sessionPromise = null;
  for (const source of sources) {
   const state = stateOf(source); state.closed = true; state.version++;
   clearTimeout(state.resizeTimer); clearTimeout(state.wheelTimer); clearTimeout(state.scrollTimer);
   state.frameController?.abort(); state.metadataController?.abort(); state.navigationController?.abort(); cancelPending(state, true);
   if (state.imageUri) { URL.revokeObjectURL(state.imageUri); state.imageUri = ''; }
  }
  sources.clear();
  if (token) void fetch('/api/session',{method:'DELETE',headers:{Authorization:'Bearer '+token},keepalive:true}).catch(()=>{});
 });
 window.addEventListener('pageshow', event => {
  if (!event.persisted || !stopping || !hooks) return;
  stopping = false; pollEpoch++; polling = false; pollAgain = false;
  for (const pane of hooks.panes) {
   if (pane.removed || pane.source?.kind !== 'remote') continue;
   const source = pane.source; source.browser = newState(); source.browser.restoreRatio = pane.ratio;
   source.browser.suppressUntil = performance.now() + 2000;
   pane.shell.replaceChildren(); pane.image = null; pane.frame = null;
   attach(pane,source);
  }
  hooks.updateSyncUI();
 });
 return {configure(value){hooks=value;},attach,detachPane,layout,scroll,cleanup,reload,navigate};
})();

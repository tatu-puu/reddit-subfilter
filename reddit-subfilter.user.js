// ==UserScript==
// @name         Reddit Subfilter
// @namespace    tatu.reddit-subfilter
// @version      1.8.0
// @description  Piilota subredditit yhdellä napautuksella. Estolista synkronoituu laitteiden välillä oman yksityisen subredditin wikisivun kautta.
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @match        https://old.reddit.com/*
// @match        https://new.reddit.com/*
// @match        https://*.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      old.reddit.com
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/tatu-puu/reddit-subfilter/main/reddit-subfilter.user.js
// @downloadURL  https://raw.githubusercontent.com/tatu-puu/reddit-subfilter/main/reddit-subfilter.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Estolista ----------
  const KEY = 'blockedSubs';
  const norm = (s) => String(s || '').trim().replace(/^\/?r\//i, '').toLowerCase();
  // Kelpaa joko subin nimi (drama) tai jokerimerkkisuodatin (*india*, india*, *india).
  // Suodattimessa pitää olla vähintään 2 oikeaa merkkiä, ettei yksinäinen * piilota kaikkea.
  const VALID = (s) => /^[a-z0-9_*]{2,40}$/.test(s) && s.replace(/\*/g, '').length >= 2;
  const isPattern = (s) => s.includes('*');
  const parseList = (text) =>
    String(text || '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join(' ')
      .split(/[\s,;]+/)
      .map(norm)
      .filter(VALID);

  let blocked = new Set(parseList((GM_getValue(KEY, []) || []).join('\n')));
  let patterns = [];
  function rebuildMatcher() {
    patterns = [...blocked].filter(isPattern).map((p) => ({
      text: p,
      re: new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'),
    }));
  }
  rebuildMatcher();
  // Palauttaa syyn piilotukselle: subin nimen tai osuneen suodattimen, muuten null
  const matchBlock = (sub) => (blocked.has(sub) ? sub : patterns.find((p) => p.re.test(sub))?.text || null);
  const save = () => { rebuildMatcher(); GM_setValue(KEY, [...blocked].sort()); };

  // ---------- Synkkaus: yksityisen subredditin wikisivu ----------
  // Lista on wikisivulla r/<syncSub>/wiki/estolista, yksi subi per rivi.
  // Muutokset jonotetaan (pendingAdd/pendingRemove), jotta mikään ei katoa, vaikka yhteys pätkisi.
  const SYNC_SUB_KEY = 'syncSub';
  const WIKI_PAGE = 'estolista';
  const ORIGIN = 'https://old.reddit.com';
  let syncSub = GM_getValue(SYNC_SUB_KEY, '') || '';
  let pendingAdd = new Set(GM_getValue('pendingAdd', []) || []);
  let pendingRemove = new Set(GM_getValue('pendingRemove', []) || []);
  const savePending = () => {
    GM_setValue('pendingAdd', [...pendingAdd]);
    GM_setValue('pendingRemove', [...pendingRemove]);
  };

  function queueChange(sub, add) {
    (add ? pendingAdd : pendingRemove).add(sub);
    (add ? pendingRemove : pendingAdd).delete(sub);
    savePending();
    requestSync();
  }

  // Kaksi tapaa tehdä pyyntö:
  //  1) 'fetch': suoraan samalta sivulta, jolla olet (käyttää varmasti selaimen kirjautumista)
  //  2) 'gm':    Violentmonkeyn GM_xmlhttpRequest old.reddit.comiin (toimii myös jos 1 estyy)
  // Kokeillaan ensin sitä, joka viimeksi toimi.
  const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const pageFetch = (typeof content !== 'undefined' && content && content.fetch) ? content.fetch.bind(content) : fetch.bind(window);

  async function viaFetch(method, path, body) {
    const r = await pageFetch(location.origin + path, {
      method, body, credentials: 'include', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
    });
    return { status: r.status, json: parseJson(await r.text()), via: 'fetch' };
  }

  function viaGM(method, path, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest puuttuu'));
      GM_xmlhttpRequest({
        method,
        url: ORIGIN + path,
        data: body,
        anonymous: false,
        headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
        onload: (r) => resolve({ status: r.status, json: parseJson(r.responseText), via: 'gm' }),
        onerror: () => reject(new Error('Verkkovirhe')),
        ontimeout: () => reject(new Error('Aikakatkaisu')),
        timeout: 15000,
      });
    });
  }

  let preferred = GM_getValue('transport', 'fetch');
  async function http(method, path, body) {
    const order = preferred === 'gm' ? [viaGM, viaFetch] : [viaFetch, viaGM];
    let lastErr, lastResp;
    for (const fn of order) {
      try {
        const r = await fn(method, path, body);
        if (r.json === null) { lastErr = new Error(`Vastaus ei ollut JSONia (${r.via} ${r.status})`); continue; }
        // 401/403 voi johtua siitä, ettei kirjautuminen välittynyt tällä tavalla, ja 404 siitä,
        // ettei www.reddit.com tunne vanhaa wiki-rajapintaa -> kokeillaan toista tapaa
        if (r.status === 401 || r.status === 403 || r.status === 404) { lastResp = r; continue; }
        if (r.via !== preferred) { preferred = r.via; GM_setValue('transport', r.via); }
        return r;
      } catch (e) { lastErr = e; }
    }
    if (lastResp) return lastResp;
    throw lastErr;
  }

  let modhash = null;
  async function getModhash() {
    if (modhash) return modhash;
    // Kokeillaan molemmat tavat: kirjautuminen voi välittyä vain toisella
    for (const fn of preferred === 'gm' ? [viaGM, viaFetch] : [viaFetch, viaGM]) {
      try {
        const r = await fn('GET', `/api/me.json?t=${Date.now()}`);
        if (r.json?.data?.modhash) {
          modhash = r.json.data.modhash;
          if (r.via !== preferred) { preferred = r.via; GM_setValue('transport', r.via); }
          return modhash;
        }
      } catch {}
    }
    throw new Error('Et ole kirjautunut Redditiin (tai kirjautuminen ei välity skriptille)');
  }

  async function wikiRead() {
    const r = await http('GET', `/r/${syncSub}/wiki/${WIKI_PAGE}.json?raw_json=1&t=${Date.now()}`);
    if (r.status === 404) return { list: [], revision: null, missing: true };
    if (r.status === 403) throw new Error(`Ei pääsyä r/${syncSub}:n wikiin`);
    if (r.status !== 200 || !r.json?.data) throw new Error(`Wikin luku epäonnistui (${r.status}, ${r.via})`);
    return { list: parseList(r.json.data.content_md), revision: r.json.data.revision_id || null, missing: false };
  }

  async function wikiWrite(list, previous) {
    const content =
      '# Reddit Subfilter -estolista. Yksi subi per rivi, #-rivit ohitetaan.\n\n' +
      [...list].sort().join('\n\n') + '\n';
    const params = new URLSearchParams({
      page: WIKI_PAGE, content, reason: 'Reddit Subfilter', api_type: 'json', uh: await getModhash(),
    });
    if (previous) params.set('previous', previous);
    const r = await http('POST', `/r/${syncSub}/api/wiki/edit`, params.toString());
    if (r.status === 409) return false; // joku muu laite ehti väliin -> yritetään uudelleen
    if (r.status === 403) throw new Error(`Ei muokkausoikeutta r/${syncSub}:n wikiin (${r.via}) – lisää tili wikin muokkaajaksi`);
    if (r.status !== 200) throw new Error(`Wikiin kirjoitus epäonnistui (${r.status}, ${r.via})`);
    const errs = r.json?.json?.errors;
    if (errs && errs.length) throw new Error(`Wikiin kirjoitus epäonnistui: ${errs.map((e) => e.join(' ')).join('; ')}`);
    return true;
  }

  async function syncNow() {
    if (!syncSub) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await wikiRead();
      // Jos wikisivu puuttuu (ei vielä luotu tai poistettu), ei tyhjennetä paikallista listaa vaan viedään se wikiin
      if (remote.missing) { blocked.forEach((s) => { if (!pendingRemove.has(s)) pendingAdd.add(s); }); savePending(); }
      // Otetaan jonosta kopio: kesken synkkauksen tulevat muutokset jäävät seuraavalle kierrokselle
      const adds = [...pendingAdd];
      const removes = [...pendingRemove];
      const merged = new Set(remote.list);
      adds.forEach((s) => merged.add(s));
      removes.forEach((s) => merged.delete(s));
      const changed = remote.missing || merged.size !== remote.list.length || remote.list.some((s) => !merged.has(s));
      if (changed && !(await wikiWrite(merged, remote.revision))) continue;
      adds.forEach((s) => pendingAdd.delete(s));
      removes.forEach((s) => pendingRemove.delete(s));
      savePending();
      // Paikallisesti näytetään wikin lista + vielä synkkaamattomat muutokset
      const local = new Set(merged);
      pendingAdd.forEach((s) => local.add(s));
      pendingRemove.forEach((s) => local.delete(s));
      applyList(local);
      return merged.size;
    }
    throw new Error('Wikisivu muuttui kesken kaiken, yritä uudelleen');
  }

  function applyList(set) {
    const same = set.size === blocked.size && [...set].every((s) => blocked.has(s));
    blocked = new Set(set);
    save();
    if (!same && document.body) {
      document.querySelectorAll('.rsf-hidden').forEach(unhide);
      process();
    }
  }

  let syncChain = Promise.resolve();
  let lastSyncError = '';
  let lastSyncOk = null; // Date
  function requestSync() {
    if (!syncSub) return syncChain;
    syncChain = syncChain.then(syncNow).then(
      (n) => { lastSyncError = ''; lastSyncOk = new Date(); renderPanel(); return n; },
      (err) => {
        console.warn('[Reddit Subfilter]', err);
        if (err.message !== lastSyncError) toast(`Synkkaus epäonnistui: ${err.message}`);
        lastSyncError = err.message;
        renderPanel();
      }
    );
    return syncChain;
  }

  // ---------- Vianetsintä ----------
  async function diagnose() {
    const lines = [];
    const add = (s) => { lines.push(s); showDiag(lines); };
    add(`Versio: ${typeof GM_info !== 'undefined' ? GM_info.script.version : '?'} · ${typeof GM_info !== 'undefined' ? GM_info.scriptHandler + ' ' + GM_info.version : ''}`);
    add(`Sivu: ${location.origin}`);
    add(`Synkkaus-subreddit: ${syncSub ? 'r/' + syncSub : 'EI ASETETTU – Asetukset → Synkkaus-subreddit'}`);
    add(`Paikallisesti estettyjä: ${blocked.size} · jonossa +${pendingAdd.size} / −${pendingRemove.size}`);
    add(`Käytössä oleva tapa: ${preferred}`);
    for (const [name, fn] of [['fetch', viaFetch], ['gm', viaGM]]) {
      try {
        const me = await fn('GET', `/api/me.json?t=${Date.now()}`);
        add(`[${name}] me.json: ${me.status}, käyttäjä: ${me.json?.data?.name || '–'}, modhash: ${me.json?.data?.modhash ? 'kyllä' : 'EI'}`);
        if (syncSub) {
          const w = await fn('GET', `/r/${syncSub}/wiki/${WIKI_PAGE}.json?raw_json=1&t=${Date.now()}`);
          const n = w.json?.data ? parseList(w.json.data.content_md).length : null;
          add(`[${name}] wiki: ${w.status}${n !== null ? `, ${n} riviä` : w.json ? `, ${JSON.stringify(w.json).slice(0, 80)}` : ', ei JSONia'}`);
        }
      } catch (e) {
        add(`[${name}] VIRHE: ${e.message}`);
      }
    }
    if (syncSub) {
      add('Synkataan…');
      await requestSync();
      add(lastSyncError ? `Synkkaus: VIRHE – ${lastSyncError}` : `Synkkaus OK, estolistalla ${blocked.size}`);
    }
  }

  function showDiag(lines) {
    let box = document.querySelector('.rsf-diag');
    if (!box) {
      box = document.createElement('div');
      box.className = 'rsf-diag';
      const pre = document.createElement('pre');
      const row = document.createElement('div');
      const copy = document.createElement('button');
      copy.textContent = 'Kopioi';
      copy.onclick = async () => {
        const t = box.querySelector('pre').textContent;
        try { await navigator.clipboard.writeText(t); copy.textContent = 'Kopioitu'; } catch { prompt('Kopioi:', t); }
      };
      const close = document.createElement('button');
      close.textContent = 'Sulje';
      close.onclick = () => box.remove();
      row.append(copy, close);
      box.append(pre, row);
      document.body.appendChild(box);
    }
    box.querySelector('pre').textContent = lines.join('\n');
  }

  // ---------- Tyylit ----------
  const css = `
    /* Piilotettu postaus litistetään 0 pikselin korkuiseksi eikä poisteta näkyvistä display:nonella.
       Reddit lataa lisää postauksia, kun syötteen loppupään postaus tulee näkyviin; display:none-postaus
       ei tule koskaan näkyviin, jolloin lataus pysähtyi. */
    .rsf-hidden {
      display: block !important; height: 0 !important; min-height: 0 !important; max-height: 0 !important;
      margin: 0 !important; padding: 0 !important; border: 0 !important;
      overflow: hidden !important; visibility: hidden !important; pointer-events: none !important;
    }
    hr.rsf-hidden { display: none !important; }
    .rsf-btn {
      position: absolute; top: 6px; right: 6px; z-index: 50;
      width: 26px; height: 26px; border-radius: 50%;
      border: none; cursor: pointer; font: 700 14px/26px sans-serif;
      background: rgba(128,128,128,.25); color: inherit; opacity: .55;
      padding: 0; text-align: center;
    }
    .rsf-btn:hover { opacity: 1; background: #e5484d; color: #fff; }
    .rsf-toast {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 99999; background: #222; color: #fff; border-radius: 8px;
      padding: 10px 14px; font: 14px sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.4);
      display: flex; gap: 12px; align-items: center; max-width: 90vw;
    }
    .rsf-panel {
      position: fixed; right: 12px; bottom: 12px; z-index: 99998;
      background: rgba(24,24,27,.92); color: #f4f4f5; border-radius: 12px;
      font: 13px/1.3 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35);
      max-width: min(300px, calc(100vw - 24px));
    }
    .rsf-panel button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
    .rsf-head { padding: 8px 12px; font-weight: 600 !important; white-space: nowrap; }
    .rsf-panel.open .rsf-head { width: 100%; text-align: left; border-bottom: 1px solid rgba(255,255,255,.1); }
    .rsf-tabs { display: flex; gap: 4px; padding: 6px 8px 2px; }
    .rsf-tabs button { padding: 3px 8px; border-radius: 6px; opacity: .6; }
    .rsf-tabs button.on { background: rgba(255,255,255,.12); opacity: 1; }
    .rsf-list { max-height: 40vh; overflow-y: auto; padding: 4px 12px 10px; min-width: 220px; }
    .rsf-row { display: grid; grid-template-columns: minmax(0,1fr) 60px 28px; gap: 8px; align-items: center; padding: 3px 0; }
    .rsf-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rsf-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.1); position: relative; }
    .rsf-bar::after { content: ''; position: absolute; inset: 0 auto 0 0; width: var(--w); border-radius: 3px; background: #e5484d; }
    .rsf-num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
    .rsf-empty { opacity: .6; padding: 6px 0; }
    .rsf-gear { margin-left: auto; }
    .rsf-check { display: flex; gap: 8px; align-items: center; font-size: 13px; }
    .rsf-check input { width: 18px; height: 18px; accent-color: #e5484d; }
    .rsf-settings { padding: 8px 12px 12px; border-top: 1px solid rgba(255,255,255,.1); display: grid; gap: 10px; max-height: 50vh; overflow-y: auto; }
    .rsf-settings[hidden] { display: none; }
    .rsf-field { display: grid; gap: 4px; font-size: 12px; }
    .rsf-field > span { opacity: .75; }
    .rsf-frow { display: flex; gap: 6px; align-items: flex-start; }
    .rsf-frow input, .rsf-frow textarea {
      flex: 1; min-width: 0; background: #2a2a2e; color: #f4f4f5; border: 1px solid #444; border-radius: 6px;
      padding: 6px 8px; font: 14px system-ui, sans-serif;
    }
    .rsf-frow textarea { height: 110px; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
    .rsf-panel .rsf-frow button { background: #e5484d; color: #fff; border-radius: 6px; padding: 6px 10px; font-weight: 600; white-space: nowrap; }
    .rsf-panel .rsf-frow button:disabled { opacity: .5; }
    .rsf-panel .rsf-link { justify-self: start; color: #7ab8ff; padding: 0; font-size: 12px; }
    .rsf-sync { padding: 0 12px 8px; font-size: 11px; opacity: .7; }
    .rsf-sync.err { color: #ff8a8a; opacity: 1; }
    .rsf-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #ff6b6b; margin-left: 6px; vertical-align: middle; }
    .rsf-diag {
      position: fixed; inset: 10px 10px auto 10px; z-index: 100000; max-height: 80vh; overflow: auto;
      background: #111; color: #eee; border-radius: 10px; padding: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.5);
      font: 12px/1.45 ui-monospace, monospace;
    }
    .rsf-diag pre { white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; font: inherit; }
    .rsf-diag button { background: #333; color: #fff; border: none; border-radius: 6px; padding: 6px 12px; margin-right: 8px; font: 600 13px sans-serif; }
    .rsf-toast { top: 16px; bottom: auto !important; }
    .rsf-toast button { background: none; border: none; color: #7ab8ff; font: 700 14px sans-serif; cursor: pointer; }

    /* "Avaa sovelluksessa" -popup: Reddit lukitsee scrollauksen sen alla, siksi overflow pakotetaan auki */
    #xpromo-bottom-sheet, [id^="xpromo-"], .rpl-bottom-sheet { display: none !important; }
    body.rpl-scroll-lock, body.scroll-disabled, html.rpl-scroll-lock, html.scroll-disabled { overflow: auto !important; }
  `;
  const addStyle = () => {
    if (document.getElementById('rsf-style')) return;
    const s = document.createElement('style');
    s.id = 'rsf-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };

  // ---------- Postausten tunnistus ----------
  // Palauttaa [{ el: piilotettava elementti, anchor: napin paikka, sub }]
  function findPosts(root) {
    const out = [];

    // Uusi Reddit ja mobiiliselain (shreddit)
    root.querySelectorAll('shreddit-post').forEach((p) => {
      let sub = p.getAttribute('subreddit-prefixed-name') || p.getAttribute('subreddit-name');
      if (!sub) {
        const m = (p.getAttribute('permalink') || '').match(/\/r\/([^/]+)/);
        sub = m && m[1];
      }
      if (!sub) return;
      const container = p.closest('article') || p;
      const id = p.getAttribute('id') || p.getAttribute('permalink') || null;
      out.push({ el: container, anchor: container, sub: norm(sub), id });
    });

    // Old Reddit
    root.querySelectorAll('.thing[data-subreddit]').forEach((t) => {
      if (!t.classList.contains('link')) return; // vain postaukset, ei kommentit
      const id = t.getAttribute('data-fullname') || t.getAttribute('data-permalink') || null;
      out.push({ el: t, anchor: t, sub: norm(t.getAttribute('data-subreddit')), id });
    });

    return out;
  }

  function hide(el) {
    el.classList.add('rsf-hidden');
    // Uuden Redditin syötteessä postausten välissä on <hr>
    const next = el.nextElementSibling;
    if (next && next.tagName === 'HR') next.classList.add('rsf-hidden');
  }

  function unhide(el) {
    el.classList.remove('rsf-hidden');
    const next = el.nextElementSibling;
    if (next && next.tagName === 'HR') next.classList.remove('rsf-hidden');
  }

  function addButton(post) {
    if (post.anchor.querySelector(':scope > .rsf-btn')) return;
    if (getComputedStyle(post.anchor).position === 'static') post.anchor.style.position = 'relative';
    const b = document.createElement('button');
    b.className = 'rsf-btn';
    b.type = 'button';
    b.textContent = '✕';
    b.title = `Piilota r/${post.sub}`;
    b.setAttribute('aria-label', `Piilota r/${post.sub}`);
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    b.addEventListener('pointerdown', stop, true);
    b.addEventListener('click', (e) => { stop(e); blockSub(post.sub); }, true);
    post.anchor.appendChild(b);
  }

  // ---------- Laskuri ----------
  // session = tämän sivulatauksen aikana piilotetut, totals = kaikkien aikojen määrät (tallennetaan)
  const TOTALS_KEY = 'hiddenTotals';
  const session = new Map();
  const totals = Object.assign({}, GM_getValue(TOTALS_KEY, {}) || {});
  const seenIds = new Set();
  const seenEls = new WeakSet();
  let saveTimer;

  function countHidden(post) {
    if (post.id ? seenIds.has(post.id) : seenEls.has(post.el)) return;
    if (post.id) seenIds.add(post.id); else seenEls.add(post.el);
    session.set(post.sub, (session.get(post.sub) || 0) + 1);
    totals[post.sub] = (totals[post.sub] || 0) + 1;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => GM_setValue(TOTALS_KEY, totals), 1000);
    renderPanel();
  }

  // ---------- Paneeli ----------
  const PANEL_OPEN_KEY = 'panelOpen';
  const PANEL_MODE_KEY = 'panelMode'; // 'session' | 'total'
  let panelOpen = GM_getValue(PANEL_OPEN_KEY, false);
  let panelMode = GM_getValue(PANEL_MODE_KEY, 'session');
  let panel, dyn, settingsEl;
  let settingsOpen = false;

  // Asetuslomake rakennetaan kerran, jotta kirjoittaminen ei keskeydy, kun laskuri päivittyy
  function buildSettings() {
    const box = document.createElement('div');
    box.className = 'rsf-settings';
    const field = (label, name, placeholder, btnText, onSubmit, multiline) => {
      // <form> + submit toimii myös Android-näppäimistön "Siirry/Enter"-napilla,
      // ja napin painallus kuunnellaan sekä click- että pointerup-tapahtumasta (Redditin mobiilisivu voi niellä clickin).
      const wrap = document.createElement('form');
      wrap.className = 'rsf-field';
      wrap.noValidate = true;
      wrap.setAttribute('action', 'javascript:void 0');
      const l = document.createElement('span');
      l.textContent = label;
      const input = document.createElement(multiline ? 'textarea' : 'input');
      input.dataset.field = name;
      input.name = name;
      input.placeholder = placeholder;
      if (!multiline) {
        input.type = 'text'; input.enterKeyHint = 'done';
        input.setAttribute('autocapitalize', 'none'); input.setAttribute('autocorrect', 'off');
        input.autocomplete = 'off'; input.spellcheck = false;
      }
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.textContent = btnText;
      let busy = false;
      const submit = async (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (busy) return;
        busy = true; btn.disabled = true;
        try { input.blur(); await onSubmit(input); }
        catch (err) { toast(`Virhe: ${err.message}`); }
        finally { setTimeout(() => { busy = false; btn.disabled = false; }, 400); }
      };
      wrap.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
      btn.addEventListener('pointerup', submit);
      for (const ev of ['keydown', 'keyup', 'keypress']) input.addEventListener(ev, (e) => e.stopPropagation()); // ettei Redditin pikanäppäimet reagoi
      const row = document.createElement('div');
      row.className = 'rsf-frow';
      row.append(input, btn);
      wrap.append(l, row);
      return wrap;
    };
    box.append(
      field('Synkkaus-subreddit (tyhjä = pois)', 'sync', 'esim. estotestitatu', 'Tallenna', (i) => setSyncSub(i.value)),
      field('Lisää subi tai suodatin', 'add', '*india*', 'Lisää', (i) => { if (addFilters(i.value)) i.value = ''; }),
      field('Koko estolista', 'list', '', 'Tallenna lista', (i) => replaceList(i.value), true),
    );
    const diag = document.createElement('button');
    diag.type = 'button';
    diag.className = 'rsf-link';
    diag.textContent = 'Synkkauksen vianetsintä';
    diag.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); diagnose(); });
    const adsRow = document.createElement('label');
    adsRow.className = 'rsf-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.field = 'ads';
    cb.checked = hideAds;
    cb.addEventListener('change', () => setHideAds(cb.checked));
    const cbText = document.createElement('span');
    cbText.textContent = 'Piilota mainokset';
    adsRow.append(cb, cbText);
    box.append(adsRow, diag);
    return box;
  }

  function fillSettings() {
    const s = settingsEl.querySelector('[data-field="sync"]');
    const l = settingsEl.querySelector('[data-field="list"]');
    if (document.activeElement !== s) s.value = syncSub;
    if (document.activeElement !== l) l.value = [...blocked].sort().join('\n');
  }

  function renderPanel() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'rsf-panel';
      dyn = document.createElement('div');
      settingsEl = buildSettings();
      panel.append(dyn, settingsEl);
      dyn.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        e.preventDefault(); e.stopPropagation();
        if (act === 'toggle') { panelOpen = !panelOpen; GM_setValue(PANEL_OPEN_KEY, panelOpen); }
        if (act === 'session' || act === 'total') { panelMode = act; GM_setValue(PANEL_MODE_KEY, act); }
        if (act === 'settings') { settingsOpen = !settingsOpen; if (settingsOpen) fillSettings(); }
        renderPanel();
      });
      document.body.appendChild(panel);
    }
    if (!panel.isConnected) document.body.appendChild(panel);
    const sessionSum = [...session.values()].reduce((a, b) => a + b, 0);
    const source = panelMode === 'session' ? [...session.entries()] : Object.entries(totals);
    const rows = source.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const max = rows[0]?.[1] || 1;

    panel.classList.toggle('open', panelOpen);
    settingsEl.hidden = !(panelOpen && settingsOpen);
    if (!settingsEl.hidden) fillSettings();
    dyn.replaceChildren();

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'rsf-head';
    head.dataset.act = 'toggle';
    head.textContent = panelOpen ? `Piilotettu ${sessionSum}  ▾` : `Piilotettu ${sessionSum}`;
    head.title = panelOpen ? 'Pienennä' : 'Näytä erittely';
    if (syncSub && lastSyncError) {
      const dot = document.createElement('span');
      dot.className = 'rsf-dot';
      head.appendChild(dot);
    }
    dyn.appendChild(head);
    if (!panelOpen) return;

    const status = document.createElement('div');
    status.className = 'rsf-sync';
    if (!syncSub) status.textContent = 'Synkkaus pois päältä';
    else if (lastSyncError) { status.className += ' err'; status.textContent = `Synkkausvirhe: ${lastSyncError}`; }
    else if (lastSyncOk) status.textContent = `Synkattu r/${syncSub} klo ${lastSyncOk.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' })}`;
    else status.textContent = `Synkataan r/${syncSub}…`;
    if (hideAds) status.textContent += ` · mainoksia piilotettu ${adCount}`;
    dyn.appendChild(status);

    const tabs = document.createElement('div');
    tabs.className = 'rsf-tabs';
    for (const [act, label] of [['session', 'Tällä kertaa'], ['total', 'Kaikkiaan']]) {
      const t = document.createElement('button');
      t.type = 'button';
      t.dataset.act = act;
      t.textContent = label;
      if (panelMode === act) t.className = 'on';
      tabs.appendChild(t);
    }
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.dataset.act = 'settings';
    gear.textContent = settingsOpen ? 'Asetukset ▴' : 'Asetukset';
    gear.className = 'rsf-gear' + (settingsOpen ? ' on' : '');
    tabs.appendChild(gear);
    dyn.appendChild(tabs);

    const list = document.createElement('div');
    list.className = 'rsf-list';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'rsf-empty';
      empty.textContent = panelMode === 'session' ? 'Ei vielä piilotettuja tällä sivulla.' : 'Ei vielä tilastoja.';
      list.appendChild(empty);
    }
    for (const [sub, n] of rows) {
      const r = document.createElement('div');
      r.className = 'rsf-row';
      const name = document.createElement('span');
      name.className = 'rsf-name';
      name.textContent = `r/${sub}`;
      const bar = document.createElement('span');
      bar.className = 'rsf-bar';
      bar.style.setProperty('--w', `${Math.max(4, (n / max) * 100)}%`);
      const num = document.createElement('span');
      num.className = 'rsf-num';
      num.textContent = n;
      r.append(name, bar, num);
      list.appendChild(r);
    }
    dyn.appendChild(list);
  }

  // ---------- Pääsilmukka ----------
  // ---------- Mainokset ----------
  const AD_SELECTORS = [
    'shreddit-ad-post',            // mainospostaus syötteessä (uusi Reddit + mobiili)
    'shreddit-comments-page-ad',   // mainos keskustelusivulla
    'shreddit-comment-tree-ad',    // mainos kommenttien välissä
    'shreddit-sidebar-ad',         // sivupalkin mainos
    '.thing.promoted', '.promotedlink', '.ad-container', '#ad_main', // old.reddit
  ].join(',');
  let hideAds = GM_getValue('hideAds', true);
  let adCount = 0;
  const seenAds = new WeakSet();

  function processAds(root) {
    if (!hideAds) return;
    root.querySelectorAll(AD_SELECTORS).forEach((ad) => {
      const el = ad.closest('article') || ad;
      hide(el);
      if (!seenAds.has(el)) { seenAds.add(el); adCount++; renderPanel(); }
    });
  }

  function setHideAds(on) {
    hideAds = on;
    GM_setValue('hideAds', on);
    if (!on) document.querySelectorAll(AD_SELECTORS).forEach((ad) => unhide(ad.closest('article') || ad));
    process();
    renderPanel();
  }

  // ---------- "Avaa sovelluksessa" -popup ----------
  // Reddit näyttää ajoittain koko ruudun popupin, joka kehottaa avaamaan sovelluksen, ja lukitsee
  // samalla scrollauksen luokalla bodyssa/htmlissa. Popup itse piilotetaan CSS:llä (yllä), mutta
  // lukitusluokat pitää myös poistaa, koska Reddit tarkistaa ja lisää niitä JS:llä uudelleen.
  const SCROLL_LOCK_CLASSES = ['rpl-scroll-lock', 'scroll-disabled', 'm-blurred'];
  function removeAppPromo(root = document) {
    root.querySelectorAll('#xpromo-bottom-sheet, [id^="xpromo-"], .rpl-bottom-sheet').forEach((el) => el.remove());
    document.body?.classList.remove(...SCROLL_LOCK_CLASSES);
    document.documentElement?.classList.remove(...SCROLL_LOCK_CLASSES);
  }

  function process(root = document) {
    removeAppPromo(root);
    processAds(root);
    // Sivukohtainen poikkeus: jos avaat suoraan estetyn subin, sitä ei piiloteta
    const here = location.pathname.match(/^\/r\/([^/]+)/);
    const currentSub = here ? norm(here[1]) : null;

    for (const post of findPosts(root)) {
      if (matchBlock(post.sub) && post.sub !== currentSub) {
        hide(post.el);
        countHidden(post);
      } else {
        addButton(post);
      }
    }
  }

  function blockSub(sub) {
    const before = session.get(sub) || 0;
    blocked.add(sub);
    save();
    queueChange(sub, true);
    process();
    toast(`r/${sub} piilotettu`, () => {
      blocked.delete(sub);
      save();
      queueChange(sub, false);
      // Perutaan myös laskurista tämän eston aiheuttamat piilotukset
      const added = (session.get(sub) || 0) - before;
      if (added > 0) {
        session.set(sub, before);
        totals[sub] = Math.max(0, (totals[sub] || 0) - added);
        GM_setValue(TOTALS_KEY, totals);
      }
      renderPanel();
      document.querySelectorAll('.rsf-hidden').forEach(unhide);
      process();
    });
  }

  let toastTimer;
  function toast(msg, undo) {
    if (!document.body) return;
    document.querySelector('.rsf-toast')?.remove();
    clearTimeout(toastTimer);
    const t = document.createElement('div');
    t.className = 'rsf-toast';
    const span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    if (undo) {
      const u = document.createElement('button');
      u.textContent = 'Peru';
      u.onclick = () => { t.remove(); undo(); };
      t.appendChild(u);
    }
    document.body.appendChild(t);
    toastTimer = setTimeout(() => t.remove(), 5000);
  }

  // ---------- Valikko (Violentmonkey / Tampermonkey) ----------
  // ---------- Toiminnot (käytetään sekä paneelin asetuksista että valikosta) ----------
  function replaceList(input) {
    const old = new Set(blocked);
    const next = new Set(parseList(input));
    next.forEach((s) => { if (!old.has(s)) queueChange(s, true); });
    old.forEach((s) => { if (!next.has(s)) queueChange(s, false); });
    applyList(next);
    toast(`Estolistalla nyt ${next.size} subia`);
  }

  function addFilters(input) {
    const items = parseList(input);
    if (!items.length) { toast('Virheellinen subi tai suodatin'); return false; }
    const next = new Set(blocked);
    items.forEach((s) => { next.add(s); queueChange(s, true); });
    applyList(next);
    // Näytetään, mihin subeihin suodatin osui tällä sivulla
    const hits = new Set(findPosts(document).map((p) => p.sub).filter((s) => items.some((i) => i === s || (isPattern(i) && patterns.find((p) => p.text === i)?.re.test(s)))));
    toast(`${items.join(', ')} lisätty` + (hits.size ? ` – piilotti: ${[...hits].slice(0, 5).map((s) => 'r/' + s).join(', ')}` : ''));
    return true;
  }

  async function setSyncSub(input) {
    const sub = norm(input).replace(/\s+/g, '').replace(/\/+$/, '');
    if (sub && !/^[a-z0-9_]{3,21}$/.test(sub)) { toast(`Virheellinen subredditin nimi: "${input}"`); return; }
    toast(sub ? `Tallennetaan r/${sub}…` : 'Poistetaan synkkaus…');
    syncSub = sub;
    GM_setValue(SYNC_SUB_KEY, sub);
    lastSyncError = ''; lastSyncOk = null; modhash = null;
    renderPanel();
    if (!sub) { toast('Synkkaus pois päältä'); return; }
    // Yhdistetään tämän laitteen lista wikin listaan
    blocked.forEach((s) => pendingAdd.add(s));
    savePending();
    const n = await requestSync();
    if (typeof n === 'number') toast(`Synkkaus käytössä: ${n} riviä r/${sub}:n wikissä`);
  }

  // Valikon komennot avaavat asetukset sivulle (prompt-ikkunat eivät toimi luotettavasti Android-Firefoxissa)
  const openSettings = (focus) => {
    panelOpen = true; settingsOpen = true;
    GM_setValue(PANEL_OPEN_KEY, true);
    renderPanel();
    panel?.querySelector(`[data-field="${focus}"]`)?.focus();
  };
  GM_registerMenuCommand('Asetukset ja synkkaus', () => openSettings('sync'));
  GM_registerMenuCommand('Lisää suodatin (esim. *india*)', () => openSettings('add'));
  GM_registerMenuCommand('Muokkaa estolistaa', async () => { await requestSync(); openSettings('list'); });
  GM_registerMenuCommand('Synkkauksen vianetsintä', () => { diagnose(); });

  GM_registerMenuCommand('Kopioi estolista leikepöydälle', async () => {
    const text = [...blocked].sort().join('\n');
    try { await navigator.clipboard.writeText(text); toast(`${blocked.size} subia kopioitu`); }
    catch { prompt('Kopioi lista:', text.replace(/\n/g, ', ')); }
  });

  // ---------- Käynnistys ----------
  addStyle();
  const start = () => {
    addStyle();
    process();
    renderPanel();
    // Haetaan lista wikistä käynnistyessä ja aina kun välilehti tulee taas näkyviin
    requestSync();
    let lastVisibleSync = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastVisibleSync > 30000) {
        lastVisibleSync = Date.now();
        requestSync();
      }
    });
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; process(); });
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();

// ==UserScript==
// @name         Splash pick'em reskin
// @namespace    john.pickem
// @version      5.0
// @description  Live league view of a Splash Sports team pick'em contest
// @match        https://contests.app.splashsports.com/team-pickem/contests/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  // run once per page: tapping the bookmarklet again just refreshes
  if (window.__tpx) { window.__tpx(); return; }

  const BASE = 'https://api.splashsports.com/contests-service-v2/api/';
  const S = {
    contest: null, headers: null, myIds: new Set(), slates: null,
    week: null,                    // weekly standings + everyone's picks (Picks by Week)
    sheet: null,                   // your own picksheet
    view: 'week', on: true, openRest: false, updated: null, busy: false
  };
  const contestId = () => (location.pathname.match(/contests\/(contest_[A-Z0-9]+)/) || [])[1];

  // ---------- capture what the page already loads ----------
  const API = /api\.splashsports\.com\/contests-service-v2\/api\/(team-pickem\/picksheets|leaderboards|my-entries|contests\/slates|contests\/contest_[A-Z0-9]+)(\?|$)/;
  const isMine = id => S.myIds.size ? S.myIds.has(id) : id === new URLSearchParams(location.search).get('entryId');

  // which week to show: the one you switched to in Splash view, else the current one.
  // A week in the page URL is ignored on load, so any saved link opens this week.
  function slateId() {
    if (S.pick) return S.pick;
    const cur = S.slates && S.slates.find(s => s.isCurrentSlate);
    return cur ? cur.id : (S.sheet && S.sheet.slateId) || null;
  }

  function takeWeek(j, url) {
    if (!j || !Array.isArray(j.data) || !j.included) return;
    const slate = new URL(url).searchParams.get('picksSlateId');
    S.week = { slate, data: j.data, games: j.included.games || [], teams: Object.fromEntries((j.included.teams || []).map(t => [t.id, t])) };
    S.updated = new Date();
  }

  function ingest(url, text) {
    const m = url && String(url).match(API);
    if (!m) return;
    let j;
    try { j = JSON.parse(text); } catch (e) { return; }
    const kind = m[1];
    if (kind.startsWith('team-pickem')) {
      const d = j && j.data;
      if (d && d.games && d.entryId && isMine(d.entryId)) S.sheet = d;
    } else if (kind === 'leaderboards') {
      if (/picksSlateId=/.test(url)) takeWeek(j, String(url));
    } else if (kind === 'my-entries') { (j.data || []).forEach(e => { if (e.contestId === contestId()) S.myIds.add(e.id); }); }
    else if (kind === 'contests/slates') S.slates = j.data || null;
    else S.contest = j && j.data && (j.data.contest || j.data);
    schedule();
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  const XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__tpxU = String(u); this.__tpxH = {}; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__tpxH) this.__tpxH[k] = v; return XH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (/api\.splashsports\.com/.test(this.__tpxU) && this.__tpxH && this.__tpxH.Authorization) S.headers = Object.assign({}, this.__tpxH);
    this.addEventListener('load', () => {
      try {
        const t = (this.responseType === '' || this.responseType === 'text') ? this.responseText : JSON.stringify(this.response);
        ingest(this.responseURL || this.__tpxU, t);
      } catch (e) {}
    });
    return XS.apply(this, arguments);
  };
  const F = window.fetch;
  window.fetch = function () {
    const p = F.apply(this, arguments);
    p.then(r => { if (API.test(r.url)) r.clone().text().then(t => ingest(r.url, t)).catch(() => {}); }).catch(() => {});
    return p;
  };

  // ---------- our own requests, using the page's session ----------
  // Splash keeps its login token in a readable cookie (renewed by the app), so a late start
  // (bookmarklet) can call the API without having seen one of the app's own requests
  const cookieToken = () => decodeURIComponent((document.cookie.match(/(?:^|; )accessToken=([^;]+)/) || [])[1] || '');
  function headers() {
    const t = cookieToken();
    if (!S.headers && !t) return null;
    const h = Object.assign({ Accept: 'application/json' }, S.headers);
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }
  async function api(url) {
    const r = await F.call(window, url, { headers: headers() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const weekUrl = slate => `${BASE}leaderboards?contestId=${contestId()}&slateId=${slate}&picksSlateId=${slate}&includeOwnLivePicks=true&limit=100`;
  const sheetUrl = (entryId, slate) => `${BASE}team-pickem/picksheets?contestId=${contestId()}&slateId=${slate}&entryId=${entryId}`;

  // what the app normally loads on its own; fetch it ourselves if we started too late to see it
  let booting = null, booted = false;
  function boot() {
    if (booting || booted) return booting;
    booting = Promise.allSettled([
      S.slates ? null : api(`${BASE}contests/slates?contestId=${contestId()}&limit=50&offset=0`).then(j => { S.slates = j.data || null; }),
      S.myIds.size ? null : api(`${BASE}my-entries?contestId=${contestId()}&limit=50&offset=0`)
        .then(j => (j.data || []).forEach(e => { if (e.contestId === contestId()) S.myIds.add(e.id); }))
    ]).then(r => { booting = null; booted = r.every(x => x.status === 'fulfilled'); });
    return booting;
  }

  async function load(force) {
    if (!S.busy && !booted && headers() && (!S.slates || !S.myIds.size)) await boot();
    const slate = slateId();
    if (S.busy || !headers() || !slate) return;
    const needWeek = force || !S.week || S.week.slate !== slate;
    const myId = [...S.myIds][0];
    const needSheet = myId && (force || !S.sheet || S.sheet.slateId !== slate);
    if (!needWeek && !needSheet) return;
    S.busy = true;
    schedule();
    const jobs = [];
    if (needWeek) { const u = weekUrl(slate); jobs.push(api(u).then(j => takeWeek(j, u))); }
    if (needSheet) jobs.push(api(sheetUrl(myId, slate)).then(j => { if (j.data) S.sheet = j.data; }));
    const res = await Promise.allSettled(jobs);
    S.busy = false;
    if (force && res.every(r => r.status === 'rejected')) { location.reload(); return; }
    schedule();
  }

  const ensure = () => load(false);

  // ---------- helpers ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const spread = n => n == null ? '' : (n > 0 ? '+' + n : String(n));
  const time = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = iso => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const byTime = (a, b) => new Date(a.startsAt) - new Date(b.startsAt);
  // 'finished' = game over, 'finalized' = graded by Splash
  const isOver = st => st === 'finished' || st === 'finalized';
  const teamPick = g => (g.picks || []).find(p => p.pickType === 'team');
  // nicknames for handles in the league
  const NICK = { 'gambler-787': 'Gambler Wes' };
  const rawName = r => (r.entry && r.entry.displayName) || r.user.handle;
  const nameOf = r => NICK[String(rawName(r)).toLowerCase()] || NICK[String(r.user && r.user.handle).toLowerCase()] || rawName(r);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function grade(pick, status) {
    const g = String((pick && (pick.grade || pick.liveGrade)) || '').toLowerCase();
    const final = isOver(status);
    if (/incorrect|los/.test(g)) return { k: 'loss', t: final ? 'Lost' : 'Losing' };
    if (/win|won|correct/.test(g)) return { k: 'win', t: final ? 'Won' : 'Winning' };
    if (/push|tie/.test(g)) return { k: 'push', t: 'Push' };
    return { k: 'pending', t: 'Picked' };
  }

  function clock(g) {
    if (isOver(g.status)) return { live: false, t: 'Final' };
    if (g.status === 'in_progress') {
      const s = g.state || {};
      if (s.quarter === 2 && /^0?0:00$/.test(s.clock || '')) return { live: true, t: 'Half' };
      const q = s.quarter > 4 ? 'OT' : s.quarter ? 'Q' + s.quarter : '';
      return { live: true, t: [q, String(s.clock || '').replace(/^0(?=\d)/, '')].filter(Boolean).join(' ') || 'Live' };
    }
    return { live: false, t: time(new Date(g.startsAt)) };
  }

  // games for the week, in one shape, from the weekly board (or your picksheet)
  function weekGames() {
    if (S.week && S.week.games.length) {
      const T = S.week.teams;
      return S.week.games.map(g => ({
        gameId: g.id, status: g.status, state: g.state, startsAt: g.startsAt,
        home: Object.assign({}, T[g.homeTeamId], { score: g.homeScore, spread: g.spread }),
        away: Object.assign({}, T[g.awayTeamId], { score: g.awayScore, spread: g.spread == null ? null : -g.spread })
      })).sort(byTime);
    }
    return S.sheet ? S.sheet.games.slice().sort(byTime) : [];
  }
  const picksRequired = () => {
    const s = S.slates && S.slates.find(x => x.id === slateId());
    return (s && s.picksRequiredCount) || 3;
  };
  const myEntry = () => (S.sheet && S.sheet.entryId) || [...S.myIds][0];

  // ---------- week view: weekly standings with everyone's picks ----------
  // alive = no pick lost yet; a live losing pick is "at risk"; all picks won = cashed
  const LIFE = { cashed: 0, alive: 1, risk: 1, out: 2 };
  function weekRows() {
    if (!S.week) return [];
    const games = Object.fromEntries(weekGames().map(g => [g.gameId, g]));
    const need = picksRequired();
    const rows = S.week.data.map((r, i) => {
      const picks = ((r.picks && r.picks.data) || []).filter(p => p.pickType === 'team')
        .sort((a, b) => byTime(games[a.gameId] || {}, games[b.gameId] || {}));
      const ks = picks.map(p => grade(p, (games[p.gameId] || {}).status));
      const won = ks.filter(g => g.t === 'Won').length;
      const life = ks.some(g => g.t === 'Lost') ? 'out'
        : won >= need ? 'cashed'
        : ks.some(g => g.k === 'loss') ? 'risk' : 'alive';
      return { r, i, picks, life };
    });
    // cashed, then alive, then out; Splash's order (by points) within each group
    // while still in it, you go first and Gambler Wes second; once out, they sort like everyone else
    const me = myEntry();
    const pin = x => x.life === 'out' ? 2 : x.r.entry.id === me ? 0 : nameOf(x.r) === 'Gambler Wes' ? 1 : 2;
    rows.sort((a, b) => pin(a) - pin(b) || LIFE[a.life] - LIFE[b.life] || a.i - b.i);
    return rows;
  }

  const LIFE_ICON = {
    cashed: '<span class="life cashed" title="Hit all picks">$</span>',
    alive: '<span class="life alive" title="Still alive">?</span>',
    risk: '<span class="life risk" title="Alive, but a pick is losing">?</span>',
    out: '<span class="life out" title="Out">✕</span>'
  };

  function weekView() {
    if (!S.week) return '<p class="empty">Loading this week</p>';
    const games = Object.fromEntries(weekGames().map(g => [g.gameId, g]));
    const need = picksRequired();
    const me = myEntry();
    let prevOut = null;
    return `<div class="board">${weekRows().map(({ r, picks, life }) => {
      const split = prevOut === false && life === 'out';
      prevOut = life === 'out';
      let chips = picks.map(p => {
        const g = games[p.gameId] || {};
        const gr = grade(p, g.status);
        const live = g.status === 'in_progress';
        const started = live || isOver(g.status);
        // stacked: visitor on top, home below; the pick is bold and carries its spread; scores on the right
        if (!g.home) return `<span class="chip ${gr.k}"><span class="pk">${esc(p.team.alias)}</span></span>`;
        const us = g.home.id === p.team.id ? g.home : g.away, them = us === g.home ? g.away : g.home;
        const sp = p.spread != null ? p.spread : us.spread;
        const line = t => {
          const mine = t === us, cls = mine ? 'pk' : 'op';
          return `<span class="${cls}">${esc(t.alias)}${mine && sp != null ? ` ${esc(spread(sp))}` : ''}</span><u class="${cls}">${started ? (t.score == null ? 0 : t.score) : ''}</u>`;
        };
        return `<span class="chip stk ${gr.k}${live ? ' live' : ''}">
          ${line(g.away)}${line(g.home)}
          ${live ? `<em>${esc(clock(g).t)}</em>` : ''}
        </span>`;
      }).join('');
      if (picks.length < need) chips += `<span class="chip wait" style="grid-column:span ${need - picks.length}">${need - picks.length} hidden</span>`;
      return `<div class="row ${life}${split ? ' split' : ''}${r.entry.id === me ? ' me' : ''}">
        <span class="who"><b>${LIFE_ICON[life]}${esc(nameOf(r))}</b><span class="chips">${chips}</span></span>
      </div>`;
    }).join('')}</div>`;
  }

  // ---------- games view: every game, who's on each side ----------
  function gamesView() {
    const list = weekGames();
    if (!list.length) return '<p class="empty">Loading games</p>';
    const me = myEntry();
    const who = {};
    const status = Object.fromEntries(list.map(g => [g.gameId, g.status]));
    if (S.week) S.week.data.forEach(r => ((r.picks && r.picks.data) || []).forEach(p => {
      if (p.pickType !== 'team') return;
      (who[p.team.id] = who[p.team.id] || []).push({ id: r.entry.id, name: nameOf(r), k: grade(p, status[p.gameId]).k });
    }));
    let last = '', html = '';
    list.forEach(g => {
      const d = day(g.startsAt);
      if (d !== last) { html += `<h3>${esc(d)}</h3>`; last = d; }
      const c = clock(g);
      const started = g.status !== 'scheduled';
      const side = t => {
        const other = t === g.home ? g.away : g.home;
        const ahead = started && t.score > other.score;
        const ids = who[t.id] || [];
        return `<div class="tm${ahead ? ' ahead' : ''}">
          <img src="${esc(t.iconUrl)}" alt="">
          <div class="nm"><b>${esc(t.name)} <i>${esc(spread(t.spread))}</i></b>
            ${ids.length ? `<span class="pickers">${ids.map(x => `<span class="${x.k}${x.id === me ? ' you' : ''}">${esc(x.id === me ? 'You' : x.name)}</span>`).join('')}</span>` : ''}
          </div>
          <span class="sc">${started && t.score != null ? t.score : ''}</span>
        </div>`;
      };
      const count = (who[g.home.id] || []).length + (who[g.away.id] || []).length;
      html += `<div class="gm ${g.status}${count ? '' : ' nopick'}">
        <div class="st">${c.live ? '<span class="dot"></span>' : ''}${esc(c.t)}<span class="np">${count ? plural(count, 'pick') : 'No picks'}</span></div>
        ${side(g.away)}${side(g.home)}
      </div>`;
    });
    return html;
  }

  // ---------- my picks view ----------
  function teamRow(t, g, pickedId, gr) {
    const mine = pickedId === t.id;
    const other = t === g.home ? g.away : g.home;
    const started = g.status !== 'scheduled';
    const ahead = started && t.score != null && other.score != null && t.score > other.score;
    return `<div class="tm${mine ? ' mine ' + gr.k : ''}${ahead ? ' ahead' : ''}">
      <img src="${esc(t.iconUrl)}" alt="">
      <div class="nm"><b>${esc(t.name)}</b><small>${t.record ? `${t.record.wins}-${t.record.losses}${t.record.ties ? '-' + t.record.ties : ''}` : ''} <i>${esc(spread(t.spread))}</i></small></div>
      ${mine ? `<span class="tag">${gr.t}</span>` : ''}
      <span class="sc">${started && t.score != null ? t.score : ''}</span>
    </div>`;
  }
  function gameCard(g) {
    const pick = teamPick(g);
    const pickedId = pick ? pick.value : null;
    const gr = grade(pick, g.status);
    const c = clock(g);
    return `<div class="gm ${g.status}${pickedId ? '' : ' nopick'}">
      <div class="st">${c.live ? '<span class="dot"></span>' : ''}${esc(c.t)}${pickedId ? '' : '<span class="np">No pick</span>'}</div>
      ${teamRow(g.away, g, pickedId, gr)}
      ${teamRow(g.home, g, pickedId, gr)}
    </div>`;
  }
  function picksView() {
    const sh = S.sheet;
    if (!sh) return '<p class="empty">Loading your picks</p>';
    const games = sh.games.slice().sort(byTime);
    const tally = { win: 0, loss: 0, push: 0, pending: 0 };
    games.forEach(g => { const p = teamPick(g); if (p) tally[grade(p, g.status).k]++; });
    const byDay = list => { let last = '', out = ''; list.forEach(g => { const d = day(g.startsAt); if (d !== last) { out += `<h3>${esc(d)}</h3>`; last = d; } out += gameCard(g); }); return out; };
    const mine = games.filter(teamPick), rest = games.filter(g => !teamPick(g));
    let html = `<div class="tally">
      <div><b>${tally.win}</b><span>Winning or won</span></div>
      <div><b>${tally.loss}</b><span>Losing or lost</span></div>
      <div><b>${tally.pending}</b><span>Not started</span></div>
    </div>`;
    html += mine.length ? byDay(mine) : '<p class="empty">No picks made yet</p>';
    if (rest.length) html += `<details class="rest"${S.openRest ? ' open' : ''}><summary>Other games (${rest.length})</summary>${byDay(rest)}</details>`;
    return html;
  }

  // ---------- shell ----------
  function header() {
    const slate = S.slates && S.slates.find(x => x.id === slateId());
    const sub = [slate && slate.name, S.updated && time(S.updated)].filter(Boolean).join(' · ');
    const me = myEntry();
    const rows = weekRows();
    const isWes = x => nameOf(x.r) === 'Gambler Wes';
    const mine = rows.find(x => x.r.entry.id === me);
    const wes = rows.find(isWes);
    const others = rows.filter(x => x !== mine && x !== wes);
    const wins = others.filter(x => x.life === 'cashed').length;
    const alive = others.filter(x => x.life === 'alive' || x.life === 'risk').length;
    const word = { cashed: 'WIN', alive: 'ALIVE', risk: 'ALIVE', out: 'OUT' };
    const tile = (label, x) => x ? `<div class="tile ${x.life}"><span>${label}:</span><b>${word[x.life]}</b></div>` : '';
    const tiles = rows.length ? `<div class="tiles">${tile('JR', mine)}${tile('WB', wes)}
      <div class="tile others"><span>OTHERS:</span><b><em class="w">${wins}</em> ${wins === 1 ? 'WIN' : 'WINS'}, <em class="a">${alive}</em> ALIVE</b></div></div>` : '';
    const tab = (v, label) => `<button data-v="${v}" class="${S.view === v ? 'sel' : ''}">${label}</button>`;
    return `<header>
      <h1>Parlay League</h1><p>${esc(sub)}</p>
      ${tiles}
    </header>
    <nav>${tab('week', 'ALL PICKS')}${tab('games', 'ALL GAMES')}${tab('picks', 'MY PICKS')}
      <button data-a="refresh" aria-label="Refresh" class="${S.busy ? 'spin' : ''}">↻</button>
    </nav>`;
  }

  let root, toggle, queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; render(); ensure(); }, 50);
  }

  function render() {
    if (!document.body) return;
    if (!root) mount();
    document.documentElement.classList.toggle('tpx-on', S.on);
    toggle.textContent = S.on ? 'Splash' : 'My view';
    const d = root.querySelector('details.rest');
    if (d) S.openRest = d.open;
    const y = window.scrollY;
    const v = { week: weekView, games: gamesView, picks: picksView }[S.view];
    root.innerHTML = header() + `<main>${v()}</main>`;
    window.scrollTo(0, y);
  }

  function mount() {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    root = document.createElement('div');
    root.id = 'tpx';
    document.body.appendChild(root);
    toggle = document.createElement('button');
    toggle.id = 'tpx-toggle';
    document.body.appendChild(toggle);
    toggle.addEventListener('click', () => {
      // coming back from Splash view: show whichever week was open there
      if (!S.on) { const u = (location.pathname.match(/picks\/(slate_[A-Z0-9]+)/) || [])[1]; if (u) S.pick = u; }
      S.on = !S.on; render(); window.scrollTo(0, 0); load(false);
    });
    root.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.a === 'refresh') { load(true); return; }
      if (b.dataset.v) { S.view = b.dataset.v; render(); window.scrollTo(0, 0); }
    });
  }

  // auto-refresh every 60s while games are live and the page is on screen
  setInterval(() => {
    const live = weekGames().some(g => g.status === 'in_progress');
    if (live && S.on && document.visibilityState === 'visible' && !S.busy) load(true);
  }, 60000);

  const CSS = `
  html.tpx-on body > :not(#tpx):not(#tpx-toggle){display:none!important}
  html.tpx-on, html.tpx-on body{background:#101a2b!important}
  #tpx{display:none}
  html.tpx-on #tpx{display:block}
  #tpx{--bg:#101a2b;--card:#182538;--line:#24344d;--ink:#f1efe8;--mute:#8d9bb1;--win:#3fbf74;--loss:#ef5b45;--live:#ffc23d;
    color:var(--ink);font:15px/1.35 -apple-system,system-ui,sans-serif;min-height:100vh;
    padding:env(safe-area-inset-top,0) 0 calc(80px + env(safe-area-inset-bottom,0));max-width:560px;margin:0 auto;-webkit-font-smoothing:antialiased}
  #tpx *{box-sizing:border-box}
  #tpx .sc,#tpx .tally b{font-family:ui-rounded,-apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums}
  #tpx header{padding:22px 16px 14px}
  #tpx h1{margin:0;font-size:28px;line-height:1.05;font-weight:800;letter-spacing:-.02em}
  #tpx header p{margin:5px 0 0;color:var(--mute);font-size:13px}
  #tpx .tiles{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,2fr);gap:5px;margin-top:12px;font-size:clamp(11px,3.3vw,14px)}
  #tpx .tile{background:var(--card);border-radius:9px;padding:7px 8px 7px 10px;display:flex;align-items:baseline;gap:.35em;min-width:0;white-space:nowrap;
    font-weight:800;letter-spacing:.02em;box-shadow:inset 3px 0 0 var(--line)}
  #tpx .tile span{color:var(--mute);font-weight:700}
  #tpx .tile.cashed{box-shadow:inset 3px 0 0 var(--win)} #tpx .tile.cashed b{color:var(--win)}
  #tpx .tile.alive,#tpx .tile.risk{box-shadow:inset 3px 0 0 var(--live)} #tpx .tile.alive b,#tpx .tile.risk b{color:var(--live)}
  #tpx .tile.out{box-shadow:inset 3px 0 0 var(--loss)} #tpx .tile.out b{color:var(--loss)}
  #tpx .tile.others{align-items:center;padding-left:8px;font-size:.75em;box-shadow:none}
  #tpx .tile.others b{color:var(--mute);font-weight:700}
  #tpx .tile.others em{font-style:normal;font-weight:800;font-family:ui-rounded,-apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums}
  #tpx .tile em.w{color:var(--win)} #tpx .tile em.a{color:var(--live)}
  #tpx nav{position:sticky;top:0;z-index:5;display:flex;gap:4px;padding:10px 14px;background:var(--bg);border-bottom:1px solid var(--line)}
  #tpx nav button{appearance:none;border:0;border-radius:999px;padding:8px 11px;font:700 12.5px -apple-system,system-ui,sans-serif;background:transparent;color:var(--mute);letter-spacing:.03em;white-space:nowrap}
  #tpx nav button.sel{background:var(--ink);color:var(--bg)}
  #tpx nav button[data-a]{margin-left:auto;color:var(--ink);background:var(--card);font-size:17px;padding:6px 12px}
  #tpx nav button.spin{animation:tpxs 1s linear infinite}
  @keyframes tpxs{to{transform:rotate(360deg)}}
  #tpx main{padding:4px 12px}
  #tpx h3{margin:22px 6px 8px;font-size:13px;font-weight:600;color:var(--mute)}
  #tpx .rest{margin-top:22px}
  #tpx .rest summary{list-style:none;cursor:pointer;padding:12px 14px;border-radius:14px;background:var(--card);font-weight:600;color:var(--mute)}
  #tpx .rest summary::-webkit-details-marker{display:none}
  #tpx .rest[open] summary{margin-bottom:4px}
  #tpx .empty{color:var(--mute);text-align:center;padding:60px 0}
  #tpx .tally{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0 4px}
  #tpx .tally div{background:var(--card);border-radius:14px;padding:12px}
  #tpx .tally b{display:block;font-size:30px;font-weight:800;line-height:1}
  #tpx .tally div:nth-child(1) b{color:var(--win)}
  #tpx .tally div:nth-child(2) b{color:var(--loss)}
  #tpx .tally span{font-size:12px;color:var(--mute)}
  #tpx .gm{background:var(--card);border-radius:16px;padding:10px 12px 6px;margin-bottom:8px}
  #tpx .gm.nopick{opacity:.55}
  #tpx .st{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--mute);margin-bottom:4px}
  #tpx .gm.in_progress .st{color:var(--live)}
  #tpx .dot{width:7px;height:7px;border-radius:50%;background:var(--live);animation:tpxp 1.6s ease-in-out infinite}
  @keyframes tpxp{50%{opacity:.25}}
  @media (prefers-reduced-motion:reduce){#tpx .dot,#tpx nav button.spin{animation:none}}
  #tpx .np{margin-left:auto;font-weight:500;color:var(--mute)}
  #tpx .tm{display:flex;align-items:center;gap:10px;padding:7px 8px;margin:0 -8px;border-radius:10px;border-left:4px solid transparent}
  #tpx .tm img{width:30px;height:30px;object-fit:contain;flex:none}
  #tpx .nm{flex:1;min-width:0;display:flex;flex-direction:column}
  #tpx .nm b{font-weight:650;font-size:16px}
  #tpx .nm small{color:var(--mute);font-size:12px}
  #tpx .nm i{font-style:normal;margin-left:6px;font-weight:500;font-size:12px;color:var(--mute)}
  #tpx .sc{font-size:24px;font-weight:700;color:var(--mute);min-width:32px;text-align:right}
  #tpx .tm.ahead .sc{color:var(--ink)}
  #tpx .tm.mine{background:rgba(255,255,255,.05);border-left-color:var(--mute)}
  #tpx .tm.mine.win{border-left-color:var(--win)}
  #tpx .tm.mine.loss{border-left-color:var(--loss)}
  #tpx .tag{font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:var(--line);color:var(--ink)}
  #tpx .tm.win .tag{background:var(--win);color:#08210f}
  #tpx .tm.loss .tag{background:var(--loss);color:#2a0903}
  #tpx .pickers{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:3px;font-size:12px;color:var(--mute)}
  #tpx .pickers .you{color:var(--live);font-weight:700}
  #tpx .pickers .win{color:#7fe0a6}
  #tpx .pickers .loss{color:#ff9585;text-decoration:line-through;text-decoration-color:rgba(239,91,69,.6)}
  #tpx .board{margin-top:12px;background:var(--card);border-radius:16px;overflow:hidden}
  #tpx .row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-top:1px solid var(--line)}
  #tpx .row:first-child{border-top:0}
  #tpx .row.me{background:#1f2f47;box-shadow:inset 4px 0 0 var(--win)}
  #tpx .row.me.risk{box-shadow:inset 4px 0 0 var(--live)}
  #tpx .row.me.out{box-shadow:inset 4px 0 0 var(--loss)}
  #tpx .who{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
  #tpx .who b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #tpx .who b{display:flex;align-items:center}
  #tpx .life{flex:none;display:inline-grid;place-items:center;width:16px;height:16px;margin-right:7px;border-radius:50%;
    font:800 11px/1 ui-rounded,-apple-system,system-ui,sans-serif}
  #tpx .life.alive{background:rgba(63,191,116,.18);box-shadow:inset 0 0 0 1.5px var(--win);color:rgba(63,191,116,.45)}
  #tpx .life.risk{background:rgba(255,194,61,.18);box-shadow:inset 0 0 0 1.5px var(--live);color:rgba(255,194,61,.45)}
  #tpx .life.cashed{background:var(--win);color:#08210f}
  #tpx .life.out{background:rgba(239,91,69,.18);color:var(--loss);font-size:10px;box-shadow:inset 0 0 0 1.5px var(--loss)}
  #tpx .row.split{border-top:2px solid #3a4c69}
  #tpx .row.out .who b{color:var(--mute)}
  #tpx .chips{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start;gap:5px}
  #tpx .chip{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:8px;font-size:12px;font-weight:700;
    background:var(--line);color:var(--ink)}
  #tpx .chip img{width:18px;height:18px;object-fit:contain}
  #tpx .chip.win{background:rgba(63,191,116,.32);color:var(--ink)}
  #tpx .chip.loss{background:rgba(239,91,69,.32);color:var(--ink)}
  #tpx .chip{font-variant-numeric:tabular-nums}
  #tpx .chip.stk{display:grid;grid-template-columns:1fr auto;gap:1px 6px;align-items:baseline;padding:5px 7px;white-space:nowrap;min-width:0;line-height:1.25}
  #tpx .chip .op{font-weight:500}
  #tpx .chip u{text-decoration:none;text-align:right;font-family:ui-rounded,-apple-system,system-ui,sans-serif}
  #tpx .chip em{grid-column:1 / -1;font-style:normal;font-weight:600;font-size:11px;color:var(--live)}
  #tpx .chip.live{box-shadow:inset 0 -2.5px 0 var(--live)}
  #tpx .chip.wait{padding-left:8px;background:transparent;color:var(--mute);font-weight:500;box-shadow:inset 0 0 0 1px var(--line)}
  #tpx-toggle{position:fixed;z-index:2147483647;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0));
    appearance:none;border:0;border-radius:999px;padding:5px 10px;font:600 11px -apple-system,system-ui,sans-serif;
    background:#000;color:#8d9bb1;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
  `;

  window.__tpx = () => { S.on = true; render(); load(true); };
  function init() { render(); ensure(); setTimeout(ensure, 2000); setTimeout(ensure, 5000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

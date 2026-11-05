// ==UserScript==
// @name         Claude.ai - Auto-Continue After Limit Reset
// @namespace    https://github.com/papelblume/claude-limit-auto-continue
// @version      1.4.0
// @description  Waits for the "returns at…" time on claude.ai, clicks Continue / Try again, and keeps going across repeated limit resets.
// @author       papelblume
// @license      GPL-3.0
// @homepageURL  https://github.com/papelblume/claude-limit-auto-continue
// @supportURL   https://github.com/papelblume/claude-limit-auto-continue/issues
// @downloadURL  https://raw.githubusercontent.com/papelblume/claude-limit-auto-continue/main/claude-limit-auto-continue.user.js
// @updateURL    https://raw.githubusercontent.com/papelblume/claude-limit-auto-continue/main/claude-limit-auto-continue.user.js
// @match        https://claude.ai/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// ==/UserScript==
/*
 * Claude.ai - Auto-Continue After Limit Reset
 * Copyright (C) 2026 papelblume
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

(() => {
  'use strict';

  // ───────────────────────── Settings ─────────────────────────
  const CONFIG = {
    // A block of page text counts as "the limit notice" only if it contains one of these
    // words AND a reset time ("... return at 8:50 AM", "... returns at 6:40 AM", "resets in 2 hours").
    noticeWords: /free\s+(?:messages?|usage)|usage|limit|paused|quota|ran out|out of messages/i,

    // Never read text inside these (our own pill, what you type, code blocks, your own messages).
    ignoreSelector:
      '#cac-pill, [contenteditable]:not([contenteditable="false"]), textarea, pre, code, [data-testid="user-message"]',

    // Button labels that count as "continue" when the button sits next to the notice.
    buttonText: /^(continue|try again|retry|resume)\b/i,
    // Fallback when no such button is near the notice: look page-wide, strict labels only
    // (so a message's own "Retry" action is never clicked by accident).
    strictButtonText: /^(continue|try again)$/i,
    pageWideButton: true,

    // Click this long AFTER the parsed time (covers small clock differences with the server).
    bufferMs: 3_000,

    // No button this long after the parsed time -> reload the page to check.
    reloadIfNoButtonMs: 60_000,
    // Reload attempts are spaced 1, 2, 4, 5, 5 ... minutes apart and stop after this many.
    maxReloads: 10,

    // Stop clicking after this many clicks that did not make the button go away.
    maxAttempts: 8,

    // Refresh the page this long after every Continue / Try again click. The fresh page shows the
    // next limit notice (if the task hit the limit again), so the script can click again and chain
    // as many continues as the task needs. The timer restarts on every click and survives manual
    // reloads of the tab. Set to 0 to turn this off.
    refreshAfterClickMs: 30 * 60_000,

    // Status pill (always visible while the script runs). Click it to toggle on/off.
    showPill: true,
    pillSide: 'right', // 'left' | 'right'

    // Prefix the browser-tab title with a countdown, so you can see it from another tab.
    titleIndicator: true,

    // Desktop notification when a click / reload happens.
    notify: false,

    // Desktop notification when the limit reset time is reached (once per session).
    // Includes simplified browser name and the clean tab title (countdown prefix removed).
    notifyOnReset: true,

    // Log what the script sees to the console (prefix: [auto-continue]).
    debug: false,
  };

  // ───────────────────────── Constants & state ─────────────────────────
  const START = Date.now();
  const TICK_MS = 1000;
  const SETTLE_MS = 15_000; // after a click, wait this long before judging the result
  const GRACE_MS = 60 * 60_000; // a time of day up to 1 h in the past counts as "just passed", not "tomorrow"
  const ANCHOR_MAX_MS = 12 * 3600_000; // reuse a remembered reset time (across reloads) for up to 12 h
  const SCAN_IDLE_MS = 2_000; // look for the notice this often when none is known
  const SCAN_ARMED_MS = 5_000; // ...and this often while waiting (to notice a changed time)
  const CLEAR_AFTER_MS = 45_000; // no notice for this long -> forget the remembered state
  const PAGE_GRACE_MS = 20_000; // never reload within this long of a page load (let the UI render)
  const SS_KEY = 'cac:state';
  const SS_REFRESH = 'cac:refreshAt'; // separate key: clearState() must never wipe the refresh timer

  const store = {
    get: (k, d) => (typeof GM_getValue === 'function' ? GM_getValue(k, d) : d),
    set: (k, v) => { if (typeof GM_setValue === 'function') GM_setValue(k, v); },
  };

  let enabled = store.get('enabled', true);
  // Runtime override of CONFIG.notifyOnReset (persisted). Falls back to the CONFIG default.
  let notifyOnReset = store.get('notifyOnReset', CONFIG.notifyOnReset);
  let session = null; // { key, at, el, url } - the limit we are currently waiting out
  let lastClick = 0; // time of a click we are still verifying (0 = none)
  let lastClickEver = 0;
  let nextClickAt = 0;
  let totalClicks = 0;
  let fails = 0; // clicks that did not make the button go away
  let scanAt = 0;
  let absentSince = 0;
  let stateCleared = false;
  let reloading = false;
  let status = 'watching';
  let resetNotified = false; // one-shot notification when the buffered reset time is first reached
  const relSeen = new Map(); // "resets in 2 hours" -> absolute timestamp (computed once)

  const log = (...a) => CONFIG.debug && console.log('[auto-continue]', ...a);

  // ───────────────────────── Remembered state (survives page reloads) ─────────────────────────
  // sessionStorage is per tab, so several tabs never share reload counters.
  let canPersist = true;
  try { sessionStorage.setItem('cac:probe', '1'); sessionStorage.removeItem('cac:probe'); } catch (_) { canPersist = false; }
  const loadState = () => { try { return JSON.parse(sessionStorage.getItem(SS_KEY)) || {}; } catch (_) { return {}; } };
  const saveState = (o) => { try { sessionStorage.setItem(SS_KEY, JSON.stringify(o)); } catch (_) { canPersist = false; } };
  const clearState = () => { try { sessionStorage.removeItem(SS_KEY); } catch (_) { /* ignore */ } };
  const reloadWait = (n) => (n ? Math.min(60_000 * 2 ** (n - 1), 300_000) : 0);
  const reloadPage = () => location.reload();

  // ───────────────────────── Refresh timer (survives page reloads) ─────────────────────────
  const loadRefresh = () => { try { return +sessionStorage.getItem(SS_REFRESH) || 0; } catch (_) { return 0; } };
  const saveRefresh = (t) => {
    try { if (t) sessionStorage.setItem(SS_REFRESH, String(t)); else sessionStorage.removeItem(SS_REFRESH); } catch (_) { /* ignore */ }
  };
  let refreshAt = loadRefresh(); // when to refresh the page (0 = nothing scheduled)
  const setRefresh = (t) => { refreshAt = t; saveRefresh(t); };
  // A timer that is already overdue when the page loads belongs to a page that has been replaced
  // since: this page is fresh, so drop it instead of reloading again.
  if (refreshAt && refreshAt <= START) setRefresh(0);

  // ───────────────────────── Reset-time parsing ─────────────────────────
  const DAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const MON_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  // Returns { at: <ms timestamp>, key: <stable id of what the page said> } or null.
  function parseResetText(rawText, now) {
    // "3:00 p.m." -> "3:00 pm" so the dots can't truncate or confuse the matching below.
    const text = rawText.replace(/\b([ap])\.\s?m\b\.?/gi, '$1m');

    // 1) Relative: "resets in 2 hours 15 minutes", "try again in 45 min"
    const rel = text.match(
      /\b(?:resets?|returns?|try again|available again|come back)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+)/i
    );
    if (rel) {
      const key = rel[0].toLowerCase();
      if (!relSeen.has(key)) {
        let ms = 0;
        for (const m of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
          const u = m[2][0].toLowerCase();
          ms += +m[1] * (u === 'd' ? 864e5 : u === 'h' ? 36e5 : 6e4);
        }
        if (ms) relSeen.set(key, now + ms);
      }
      if (relSeen.has(key)) return { at: relSeen.get(key), key: 'rel:' + key };
    }

    // 2) Absolute: "return at 8:50 AM", "returns at 6:40 AM", "resets Fri 9:00 AM",
    //    "resets tomorrow at 3 AM", "resets Oct. 15 at 9am", "until 15:30"
    const kwRe = /\b(?:resets?|returns?|until|available again|try again)\b(?:\s+(?:at|on))?\s*([^\n]{0,60})/gi;
    for (const k of text.matchAll(kwRe)) {
      // Stop at the end of the sentence ("... 6:40 AM. Continue then."), but keep "Oct. 15".
      const tail = k[1].split(/\.\s+(?=[A-Z])/)[0];
      let h, min;
      const tm = tail.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])m\b/i);
      if (tm) {
        if (+tm[1] < 1 || +tm[1] > 12) continue;
        h = (+tm[1] % 12) + (tm[3].toLowerCase() === 'p' ? 12 : 0);
        min = +(tm[2] || 0);
      } else {
        const t24 = tail.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
        if (!t24) continue;
        h = +t24[1];
        min = +t24[2];
      }

      const d = new Date(now);
      d.setHours(h, min, 0, 0);

      const dm = tail.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
      const wd = tail.match(/\b(sun|mon|tue|wed|thu|fri|sat)(?:s|rs|day|sday|nesday|rsday|urday)?\b/i);
      let when = '';

      if (dm) {
        when = dm[0].toLowerCase();
        d.setMonth(MON_IDX[dm[1].toLowerCase()], +dm[2]);
        if (d - now < -GRACE_MS) d.setFullYear(d.getFullYear() + 1);
      } else if (wd) {
        when = wd[0].toLowerCase();
        d.setDate(d.getDate() + ((DAY_IDX[wd[1].toLowerCase()] - d.getDay() + 7) % 7));
        if (d - now < -GRACE_MS) d.setDate(d.getDate() + 7);
      } else if (/\btomorrow\b/i.test(tail)) {
        when = 'tomorrow';
        d.setDate(d.getDate() + 1);
      } else if (d - now < -GRACE_MS) {
        d.setDate(d.getDate() + 1);
      }
      return { at: d.getTime(), key: `abs:${h}:${min}:${when}` };
    }
    return null;
  }

  // ───────────────────────── Finding the notice and the button ─────────────────────────
  const RESET_WORD = /\b(?:returns?|resets?|until|available again)\b/i;
  const isVisible = (el) => el.getClientRects().length > 0;
  // claude.ai's disabled "Continue" button has aria-disabled="true" (no `disabled` attribute).
  const isDisabled = (b) =>
    b.disabled || b.getAttribute('aria-disabled') === 'true' || b.hasAttribute('data-disabled');

  // Walk the page's text; a text node mentioning "return(s)/reset(s)" is expanded to the nearest
  // small container that also holds a limit word and a parseable time.
  function scanNotice(now) {
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const data = node.data;
      if (data.length > 400 || !RESET_WORD.test(data)) continue;
      let el = node.parentElement;
      for (let up = 0; el && up < 4; up++, el = el.parentElement) {
        if (el.closest(CONFIG.ignoreSelector)) break;
        const text = el.textContent.replace(/\s+/g, ' ').trim();
        if (text.length > 300) break;
        if (CONFIG.noticeWords.test(text)) {
          const parsed = parseResetText(text, now);
          if (parsed) return { el, text, parsed };
        }
      }
    }
    return null;
  }

  function findButton(near) {
    const pick = (root, re) => {
      const all = [...root.querySelectorAll('button, [role="button"]')].filter(
        (b) => isVisible(b) && !b.closest('#cac-pill') && re.test(b.textContent.trim())
      );
      return all.find((b) => !isDisabled(b)) || all[0] || null; // enabled first, else the disabled one
    };

    // 1) Inside the notice, or a few levels up while the container is still small.
    let el = near && near.isConnected ? near : null;
    for (let up = 0; el && up < 4 && el.textContent.length < 600; up++, el = el.parentElement) {
      const b = pick(el, CONFIG.buttonText);
      if (b) return b;
    }
    // 2) Page-wide fallback, strict labels only.
    return CONFIG.pageWideButton && document.body ? pick(document.body, CONFIG.strictButtonText) : null;
  }

  const fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), x = s % 60;
    if (d) return `${d}d ${h}h`;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(x).padStart(2, '0')}s`;
  };
  const fmtTime = (t) =>
    new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const fmtClock = (t) =>
    new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // True while a post-click page refresh is scheduled and the feature is on.
  const refreshPending = () => CONFIG.refreshAfterClickMs > 0 && refreshAt > 0;

  // Simplified browser name for notifications.
  function getBrowserName() {
    const ua = navigator.userAgent || '';
    if (/Firefox\//i.test(ua)) return 'Firefox';
    // Prefer User-Agent Client Hints when available (more reliable for Chromium forks).
    if (navigator.userAgentData && Array.isArray(navigator.userAgentData.brands)) {
      const brands = navigator.userAgentData.brands.map((b) => (b.brand || '').toLowerCase());
      if (brands.some((b) => b.includes('google chrome'))) return 'Chrome';
      if (brands.some((b) => b.includes('chromium') || b.includes('ungoogled'))) return 'Ungoogled Chromium';
    }
    // Fallback UA-string heuristics.
    if (/Chromium\//i.test(ua) || /Ungoogled/i.test(ua)) return 'Ungoogled Chromium';
    if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
    return 'Browser';
  }

  // Tab title with the script's own countdown prefix removed.
  function getCleanTitle() {
    const cur = document.title || '';
    if (titleTag && cur.startsWith(titleTag)) return cur.slice(titleTag.length).trim() || cur;
    return cur;
  }

  // ───────────────────────── Status UI ─────────────────────────
  // Everything here uses CSSOM / Web Animations only (no <style> tag), so a strict CSP can't break it.
  const COLORS = {
    off: '#8b949e', watching: '#3fb950', waiting: '#d29922',
    clicked: '#58a6ff', gaveup: '#f85149', error: '#f85149',
  };
  let pill = null, dot = null, labelEl = null, beat = null;
  let titleTag = '';

  function ensurePill() {
    if (pill && pill.isConnected) return pill;
    pill = document.createElement('div');
    pill.id = 'cac-pill';
    Object.assign(pill.style, {
      position: 'fixed', bottom: '12px', [CONFIG.pillSide]: '12px', zIndex: '2147483647',
      display: 'flex', alignItems: 'center', gap: '7px',
      padding: '5px 11px', borderRadius: '999px',
      font: '12px/1.2 system-ui, sans-serif', color: '#fff',
      background: 'rgba(20,20,20,.85)', boxShadow: '0 1px 4px rgba(0,0,0,.35)',
      maxWidth: 'min(90vw, 460px)', cursor: 'pointer', userSelect: 'none',
    });
    dot = document.createElement('span');
    Object.assign(dot.style, { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' });
    labelEl = document.createElement('span');
    Object.assign(labelEl.style, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    pill.append(dot, labelEl);
    pill.addEventListener('click', onPillClick);
    document.body.appendChild(pill);
    beat = null;
    return pill;
  }

  function setTitleTag(tag) {
    if (!CONFIG.titleIndicator) return;
    const next = tag ? tag + ' ' : '';
    const cur = document.title;
    const base = titleTag && cur.startsWith(titleTag) ? cur.slice(titleTag.length) : cur;
    titleTag = next;
    if (cur !== next + base) document.title = next + base;
  }

  function show(state, text, tip = '', tag = '') {
    status = state;
    if (CONFIG.showPill && document.body) {
      const p = ensurePill();
      if (labelEl.textContent !== text) labelEl.textContent = text;
      if (p.title !== tip) p.title = tip;
      dot.style.background = COLORS[state];
      p.style.opacity = state === 'watching' || state === 'off' ? '0.72' : '1';
      // A slow pulse = "the script is alive". Frozen dot + stale text = something is wrong.
      const pulse = state === 'watching' || state === 'waiting';
      if (pulse && !beat && typeof dot.animate === 'function') {
        beat = dot.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 2000, iterations: Infinity });
      } else if (!pulse && beat) {
        beat.cancel();
        beat = null;
      }
    }
    setTitleTag(tag);
  }

  function notify(text) {
    if (CONFIG.notify && typeof GM_notification === 'function') {
      GM_notification({ title: 'Claude auto-continue', text, timeout: 8000 });
    }
  }

  // One-shot system notification when the limit reset time is reached.
  function notifyResetReached(now) {
    if (!notifyOnReset || resetNotified || typeof GM_notification !== 'function') return;
    resetNotified = true;
    const browser = getBrowserName();
    const tab = getCleanTitle() || '(untitled tab)';
    const when = fmtClock(now);
    GM_notification({
      title: `Claude limit reset · ${browser}`,
      text: `Reset time reached at ${when}.\nTab: ${tab}`,
      timeout: 10_000,
    });
    log('notifyOnReset:', browser, tab);
  }

  // ───────────────────────── Main loop ─────────────────────────
  const retryDelay = () => Math.min(30_000 * 2 ** Math.max(0, fails - 1), 300_000);

  function startSession(n, now) {
    const st = loadState();
    const same = st.key === n.parsed.key;
    let at = n.parsed.at;
    // After a reload the page may still show "8:50 AM" long after 8:50: keep the original moment
    // instead of rolling the time of day forward to tomorrow.
    if (same && n.parsed.key.startsWith('abs:') && typeof st.at === 'number' && now - st.at < ANCHOR_MAX_MS) at = st.at;
    session = { key: n.parsed.key, at, el: n.el, url: location.href };
    stateCleared = false;
    resetNotified = false; // allow a fresh notification for this session
    saveState({
      key: session.key, at,
      reloads: same ? st.reloads || 0 : 0,
      lastReloadAt: same ? st.lastReloadAt || 0 : 0,
    });
    log('limit notice:', n.text, '->', new Date(at).toString());
  }

  // Look for the notice; (re)start the session when it's new. Returns true if a notice is on the page.
  function discover(now) {
    scanAt = now;
    const n = scanNotice(now);
    if (!n) return false;
    if (!session || session.key !== n.parsed.key) startSession(n, now);
    else session.el = n.el;
    return true;
  }

  function doClick(btn, now) {
    btn.click();
    lastClick = lastClickEver = now;
    totalClicks++;
    absentSince = 0;
    // Every click (re)starts the refresh timer: the page is reloaded this long after the LAST click.
    if (CONFIG.refreshAfterClickMs > 0) {
      setRefresh(now + CONFIG.refreshAfterClickMs);
      log('page refresh scheduled for', new Date(refreshAt).toString());
    }
    notify(`Clicked "${btn.textContent.trim()}" at ${fmtClock(now)}`);
  }

  function doReload(now) {
    const st = loadState();
    saveState({
      key: session.key, at: session.at,
      reloads: (st.reloads || 0) + 1, lastReloadAt: now,
    });
    reloading = true;
    notify('No button yet - reloading the page to check.');
    show('waiting', 'Auto-continue: no button yet, reloading…', '', '🔄');
    reloadPage();
  }

  // The scheduled refresh after a click. The timer is cleared BEFORE reloading, so it can only
  // fire once per click and can never turn into a reload loop.
  function doRefresh() {
    setRefresh(0);
    reloading = true;
    notify('Refreshing the page (scheduled after the last click).');
    show('waiting', 'Auto-continue: refreshing the page…', '', '🔄');
    reloadPage();
  }

  function resetCounters() {
    fails = 0; nextClickAt = 0;
    const st = loadState();
    if (st.key) saveState({ ...st, reloads: 0, lastReloadAt: 0 });
  }

  function tick() {
    const now = Date.now();
    if (reloading) return;

    if (!enabled) {
      session = null;
      return show('off', 'Auto-continue: off', 'Auto-continue is off. Click to turn it on.');
    }

    if (session && session.url !== location.href) session = null; // navigated elsewhere: look again

    // Scheduled refresh after a click (see CONFIG.refreshAfterClickMs).
    if (refreshPending() && now >= refreshAt) return doRefresh();

    // Judge our last click only after the page has had time to react.
    if (lastClick) {
      if (now - lastClick < SETTLE_MS) {
        return show('clicked', `Auto-continue: clicked ${fmtClock(lastClick)}, checking…`,
          'Clicked the button; waiting to see whether it goes away.', '▶');
      }
      lastClick = 0;
      const left = findButton(session && session.el);
      const buttonLeft = !!left && !isDisabled(left); // a disabled leftover is not a failed click
      const noticeLeft = discover(now);
      if (buttonLeft) {
        fails++;
        nextClickAt = now + retryDelay();
        log('button still there after click; fails =', fails);
      } else if (!noticeLeft) {
        session = null; fails = 0; nextClickAt = 0; // all gone: it worked
        relSeen.clear(); // forget "resets in 2 hours" targets so the NEXT limit gets a fresh countdown
        clearState();
      }
    } else if (now - scanAt >= (session ? SCAN_ARMED_MS : SCAN_IDLE_MS)) {
      discover(now);
    }

    // ── Nothing to wait for ──
    if (!session) {
      if (!absentSince) absentSince = now;
      if (!stateCleared && now - absentSince > CLEAR_AFTER_MS) { clearState(); stateCleared = true; fails = 0; }
      const last = lastClickEver ? ` · last click ${fmtClock(lastClickEver)}` : '';
      const rf = refreshPending() ? ` · refresh ${fmtClock(refreshAt)}` : '';
      const rfTip = refreshPending() ? `\nPage refresh scheduled for ${fmtClock(refreshAt)}.` : '';
      return show('watching', `Auto-continue: watching${last}${rf}`,
        `Looking for a "your free messages return at …" notice.\nClicks since page load: ${totalClicks}.${rfTip}\nClick this pill to turn off.`);
    }
    absentSince = 0;

    // ── Before the reset time ──
    const goAt = session.at + CONFIG.bufferMs;
    if (now < goAt) {
      const left = fmtDur(goAt - now);
      const rfTip = refreshPending() ? `\nPage refresh scheduled for ${fmtClock(refreshAt)}.` : '';
      return show('waiting', `Auto-continue in ${left} (limit ends ${fmtTime(session.at)})`,
        `Will look for the Continue / Try again button at about ${fmtTime(goAt)}.${rfTip}\nClick this pill to turn off.`,
        `⏳ ${left}`);
    }

    // ── Reset time reached ──
    notifyResetReached(now);

    // Find the button
    const btn = findButton(session.el);
    if (btn && !isDisabled(btn)) {
      if (fails >= CONFIG.maxAttempts) {
        return show('gaveup', `Auto-continue: gave up after ${fails} clicks (click to retry)`,
          'The button did not go away after repeated clicks. Click this pill to try again.', '⚠');
      }
      if (now >= nextClickAt) {
        log('clicking', btn);
        doClick(btn, now);
        return show('clicked', `Auto-continue: clicked ${fmtClock(now)}, checking…`,
          'Clicked the button; waiting to see whether it goes away.', '▶');
      }
      return show('waiting', `Auto-continue: click didn't take, retrying in ${fmtDur(nextClickAt - now)}`,
        `Clicks that did not clear the button: ${fails}/${CONFIG.maxAttempts}.`, '⏳');
    }

    // No usable button (missing, or still disabled): reload the page to check, with spacing so it
    // can never loop quickly. The button is re-checked every second, so if it enables in the
    // meantime it is clicked and no reload happens.
    const why = btn ? 'button still disabled' : 'no button yet';
    const st = loadState();
    const reloads = st.reloads || 0;
    if (reloads >= CONFIG.maxReloads) {
      return show('gaveup', `Auto-continue: no button after ${reloads} reloads (click to retry)`,
        'Click this pill to start over.', '⚠');
    }
    if (!canPersist) {
      return show('waiting', `Auto-continue: ${why} (reload disabled: no storage)`,
        'sessionStorage is unavailable, so automatic reloads are switched off to avoid a reload loop.', '🔎');
    }
    const reloadAt = Math.max(
      session.at + CONFIG.reloadIfNoButtonMs,
      (st.lastReloadAt || 0) + reloadWait(reloads),
      START + PAGE_GRACE_MS
    );
    if (now >= reloadAt) return doReload(now);
    const left = fmtDur(reloadAt - now);
    return show('waiting', `Auto-continue: ${why} · reload in ${left}`,
      `Reloads so far: ${reloads}/${CONFIG.maxReloads}.\nClick this pill to turn off.`, `🔎 ${left}`);
  }

  function safeTick() {
    try {
      tick();
    } catch (err) {
      console.error('[auto-continue]', err);
      try { show('error', 'Auto-continue: error (see console)', String(err), '⚠'); } catch (_) { /* ignore */ }
    }
  }

  // ───────────────────────── Controls ─────────────────────────
  function setEnabled(value, persist = true) {
    enabled = !!value;
    if (persist) store.set('enabled', enabled);
    session = null; lastClick = 0; absentSince = 0; scanAt = 0;
    clearState();
    setRefresh(0); // toggling on/off also cancels any pending post-click refresh
    fails = 0; nextClickAt = 0;
    resetNotified = false;
    safeTick();
  }

  function setNotifyOnReset(value, persist = true) {
    notifyOnReset = !!value;
    if (persist) store.set('notifyOnReset', notifyOnReset);
    // Allow a notification again if the feature is turned back on while already past the reset time.
    if (notifyOnReset) resetNotified = false;
    log('notifyOnReset set to', notifyOnReset);
  }

  function onPillClick() {
    if (status === 'gaveup') { resetCounters(); safeTick(); } // "click to retry"
    else setEnabled(!enabled);
  }

  function diagnostics() {
    const now = Date.now();
    console.group('[auto-continue] diagnostics');
    console.log({
      enabled, notifyOnReset, status, fails, totalClicks, canPersist,
      refreshAfterClickMs: CONFIG.refreshAfterClickMs,
      refreshAt: refreshAt ? new Date(refreshAt).toString() : null,
      persisted: loadState(),
      session: session && { key: session.key, at: new Date(session.at).toString(), url: session.url },
      browser: getBrowserName(), cleanTitle: getCleanTitle(),
    });
    const n = scanNotice(now);
    console.log('notice found:', n);
    const b = findButton((n && n.el) || (session && session.el));
    console.log('button found:', b, b ? `(disabled: ${isDisabled(b)})` : '');
    console.groupEnd();
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Toggle auto-continue on/off', () => setEnabled(!enabled));
    GM_registerMenuCommand('Toggle notify on limit reset', () => {
      setNotifyOnReset(!notifyOnReset);
      console.info('[auto-continue] notify on limit reset:', notifyOnReset ? 'on' : 'off');
    });
    GM_registerMenuCommand('Click Continue / Try again now', () => {
      const b = findButton(session && session.el);
      if (b && !isDisabled(b)) doClick(b, Date.now());
      else console.info('[auto-continue] no clickable button right now');
      safeTick();
    });
    GM_registerMenuCommand('Print diagnostics to console', diagnostics);
  }

  // Keep several claude.ai tabs in sync when settings are flipped.
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener('enabled', (_k, _old, val, remote) => { if (remote) setEnabled(val, false); });
    GM_addValueChangeListener('notifyOnReset', (_k, _old, val, remote) => { if (remote) setNotifyOnReset(val, false); });
  }

  // Background tabs get throttled timers; re-check the moment you come back to the tab.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) safeTick(); });

  setInterval(safeTick, TICK_MS);
  safeTick();
  log('loaded');
})();

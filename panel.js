import { t } from './text.js';
import { createRelayUI } from './panel-api.js';

const PREFS_KEY = 'com.fly6969321.director.panel.v1';

let panel = null, ball = null, relayUI = null;
let cleanups = [], disposed = false, refreshId = 0, currentChat = null, snap = null;
const dirty = new Set(), inputRevision = new Map();
let pending = 0, poll = null, pollCount = 0;
let deliveryIntent = null, resetConfirmationChat = null, repairArmed = false;
let poolPage = 0, poolInventoryVisible = false, poolCategory = 'plot';
let prefs = {}, theme = 'day';

function $(id) { return document.getElementById(id); }
function app() { return window.__baobaodaiApp; }

function on(target, name, fn, options) {
    target.addEventListener(name, fn, options);
    cleanups.push(() => target.removeEventListener(name, fn, options));
}

function msg(id, text, kind) {
    const e = $(id); if (!e) return;
    e.textContent = text || '';
    e.className = 'dr-msg' + (kind ? ' ' + kind : '');
}

function keyOf(e) { return e.dataset.config || e.id; }
function value(e) { return e.type === 'checkbox' ? e.checked : e.type === 'number' ? Number(e.value) : e.value; }
function recordEdit(e) { const key = keyOf(e); dirty.add(key); inputRevision.set(key, (inputRevision.get(key) || 0) + 1); }
function remember() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {} }

function localize() {
    panel.querySelectorAll('[data-dr-i18n]').forEach(e => { e.textContent = t(e.dataset.drI18n); });
    [ball, panel].forEach(root => {
        [root].concat(Array.from(root.querySelectorAll('*'))).forEach(e => {
            ['title', 'placeholder', 'aria-label'].forEach(a => {
                const key = e.getAttribute('data-dr-i18n-' + a);
                if (key) e.setAttribute(a, t(key));
            });
        });
    });
    applyTheme(); renderPoolVisibility();
    if (snap) render(snap);
}

function applyTheme() {
    ball.dataset.theme = panel.dataset.theme = theme;
    $('dr-theme').textContent = theme === 'day' ? '🌙' : '☀️';
    prefs.theme = theme;
}

function applyBallHidden(hidden) {
    ball.classList.toggle('hide', !!hidden);
    const btn = $('dr-ball-toggle');
    if (btn) btn.textContent = hidden ? '📍' : '📌';
}

function insets() {
    const form = document.getElementById('send_form');
    const bottom = form && form.offsetHeight ? form.offsetHeight : 0;
    return { topBar: 0, bottomInput: bottom };
}

function clampPosition(e, x, y) {
    const i = insets(), r = e.getBoundingClientRect();
    const top = Math.max(0, Number(i.topBar) || 0) + 8;
    const right = Math.max(4, innerWidth - r.width - 4);
    const bottom = Math.max(top, innerHeight - (Number(i.bottomInput) || 0) - r.height - 8);
    e.style.left = Math.max(4, Math.min(right, x)) + 'px';
    e.style.top = Math.max(top, Math.min(bottom, y)) + 'px';
}

function clampAll() {
    let r = ball.getBoundingClientRect();
    clampPosition(ball, r.left, r.top);
    if (panel.classList.contains('show') && innerWidth > 720 && panel.style.top) {
        r = panel.getBoundingClientRect();
        clampPosition(panel, r.left, r.top);
    }
}

function openPanel() {
    poolInventoryVisible = false; renderPoolVisibility();
    panel.classList.add('show'); clampAll(); refresh();
}

function setupDrag(target, element, launcher) {
    let drag = null, suppressUntil = 0;
    on(target, 'pointerdown', e => {
        if (e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) return;
        if (!launcher && (innerWidth <= 720 || e.target.closest('button,input,textarea,select'))) return;
        const r = element.getBoundingClientRect();
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
        try { target.setPointerCapture(e.pointerId); } catch (_) {}
    });
    on(target, 'pointermove', e => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 7) drag.moved = true;
        if (drag.moved) { e.preventDefault(); clampPosition(element, drag.left + dx, drag.top + dy); }
    });
    on(target, 'pointerup', e => {
        if (!drag || drag.id !== e.pointerId) return;
        const moved = drag.moved; drag = null;
        if (launcher) {
            suppressUntil = moved ? Date.now() + 500 : 0;
            e.stopPropagation();
            if (moved) { e.preventDefault(); const r = ball.getBoundingClientRect(); prefs.ball = { x: r.left, y: r.top }; remember(); }
        }
    });
    const cancel = () => { if (drag) suppressUntil = Date.now() + 500; drag = null; };
    on(target, 'pointercancel', cancel);
    on(target, 'lostpointercapture', cancel);
    if (launcher) {
        on(target, 'click', e => {
            e.preventDefault(); e.stopPropagation();
            if (e.detail === 0 || Date.now() > suppressUntil) openPanel();
        });
    }
}

function slipRow(card) {
    const row = document.createElement('div'), body = document.createElement('p');
    row.className = 'dr-event'; row.dataset.category = card.category;
    body.textContent = card.hook || card.card || '';
    const title = card.title && card.title !== card.hook ? document.createElement('strong') : null;
    if (title) { title.textContent = card.title; row.appendChild(title); }
    row.appendChild(body);
    return row;
}

function cards(host, list, emptyKey) {
    host.replaceChildren();
    if (!list || !list.length) { host.textContent = t(emptyKey || 'repair.noCards'); return; }
    list.forEach(card => {
        const row = slipRow(card);
        if (card.anchor) { const anchor = document.createElement('small'); anchor.textContent = card.anchor; row.appendChild(anchor); }
        host.appendChild(row);
    });
}

function fill(e, val, chatChanged) {
    if (!chatChanged && (dirty.has(keyOf(e)) || document.activeElement === e)) return;
    if (e.type === 'checkbox') e.checked = !!val; else e.value = val == null ? '' : val;
}

function drawCategories(c) {
    return Array.isArray(c.poolDrawCategories) ? c.poolDrawCategories : [c.poolDrawCategory || 'auto'];
}

function renderDrawCategories(c) {
    const selected = drawCategories(c);
    panel.querySelectorAll('[data-draw-category]').forEach(e => {
        e.checked = selected.indexOf(e.dataset.drawCategory) >= 0;
        e.disabled = pending > 0;
    });
}

function renderPoolVisibility() {
    const visible = poolInventoryVisible;
    $('dr-pool-toggle').setAttribute('title', t(visible ? 'pool.hideInventory' : 'pool.showInventory'));
    $('dr-pool-toggle').setAttribute('aria-label', t('pool.inventory') + ' · ' + t(visible ? 'pool.hideInventory' : 'pool.showInventory'));
    $('dr-pool-toggle').setAttribute('aria-expanded', String(visible));
    $('dr-pool-inventory').classList.toggle('hide', !visible);
    $('dr-pool-visibility-note').textContent = '';
}

function renderPool(r) {
    const p = r.state.pool || { cards: [], targets: {}, status: 'empty' }, all = p.cards || [];
    const names = { plot: t('pool.plot'), emotion: t('pool.emotion'), nsfw: 'NSFW' };
    const summary = ['plot', 'emotion', 'nsfw'].map(k => {
        const a = all.filter(c => c.category === k);
        return names[k] + ': ' + a.length + '/' + ((p.targets || {})[k] || 0)
            + ' · ' + t('pool.countAvailable') + a.filter(c => c.status === 'available').length
            + ' · ' + t('pool.countUsed') + a.filter(c => c.status === 'used').length;
    }).join('\n');
    const state = p.status === 'building' && !r.busy ? 'paused' : p.status;
    $('dr-pool-summary').textContent = (state === 'ready' ? '' : t('pool.status.' + (state || 'empty')) + '\n')
        + summary + (p.pending ? '\n' + t('pool.pendingHint') : '') + (p.error ? '\n' + p.error : '');
    $('dr-pool-summary').style.whiteSpace = 'pre-line';
    ['dr-pool-build', 'dr-pool-refill', 'dr-pool-save', 'dr-pool-reset'].forEach(id => { $(id).disabled = !!r.busy || pending > 0; });
    const status = $('dr-pool-view').value;
    panel.querySelectorAll('[data-pool-category]').forEach(button => {
        const category = button.dataset.poolCategory;
        const count = all.filter(c => c.status === status && (category === 'all' || c.category === category)).length;
        button.setAttribute('aria-pressed', String(category === poolCategory));
        button.querySelector('.dr-category-count').textContent = count;
    });
    const order = ['plot', 'emotion', 'nsfw'];
    const filtered = all.filter(c => c.status === status && (poolCategory === 'all' || c.category === poolCategory))
        .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    const pages = Math.max(1, Math.ceil(filtered.length / 10));
    poolPage = Math.min(poolPage, pages - 1);
    $('dr-pool-page').textContent = (poolPage + 1) + '/' + pages + ' · ' + filtered.length;
    $('dr-pool-prev').disabled = poolPage <= 0;
    $('dr-pool-next').disabled = poolPage >= pages - 1;
    const host = $('dr-pool-cards');
    host.replaceChildren();
    let lastCategory = null;
    filtered.slice(poolPage * 10, poolPage * 10 + 10).forEach(card => {
        if (poolCategory === 'all' && lastCategory !== card.category) {
            const heading = document.createElement('h6');
            heading.className = 'dr-category-heading';
            heading.textContent = names[card.category] || card.category;
            host.appendChild(heading); lastCategory = card.category;
        }
        const row = slipRow(card), meta = document.createElement('small');
        meta.textContent = (card.when ? t('pool.when') + card.when : '') + (card.avoid ? (card.when ? '；' : '') + t('pool.avoid') + card.avoid : '');
        if (meta.textContent) row.appendChild(meta);
        if (card.status === 'available') {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'dr-delete';
            button.title = t('pool.delete'); button.setAttribute('aria-label', t('pool.delete'));
            button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
            button.disabled = !!r.busy || pending > 0;
            button.onclick = () => { act('dr-pool-msg', a => a.discardPoolCard(card.id)); };
            row.appendChild(button);
        }
        host.appendChild(row);
    });
    if (!filtered.length) host.textContent = t('pool.categoryEmpty');
}

function render(r) {
    const s = r.state, c = r.cfg, changed = currentChat !== r.chatId;
    if (changed) {
        relayUI.resetEditors();
        relayUI.invalidateModels('chime', false); relayUI.invalidateModels('coord', false);
        dirty.clear(); inputRevision.clear();
        $('dr-preview-box').hidden = true;
    }
    currentChat = r.chatId;
    if (changed) { poolPage = 0; $('dr-pool-consent').checked = false; deliveryIntent = null; closeResetDialog(); }
    renderPool(r);
    $('dr-channel').textContent = r.channels ? r.channels.reason : t('repair.channelPending');
    if (s.ngSuggested) $('dr-channel').textContent += ' · ' + t('repair.ng');
    $('dr-stage').textContent = s.floatStage === 'faded' ? t('repair.fade') : '';
    cards($('dr-face'), s.floatStage === 'done' ? [] : s.activeCards);
    $('dr-coord-text').textContent = s.coordText || t('ui.noCoord');
    const changingDelivery = deliveryIntent && deliveryIntent.chatId === r.chatId;
    $('dr-delivery-toggle').setAttribute('aria-checked', String(changingDelivery ? deliveryIntent.enabled : !!c.chimeEnabled && !s.paused));
    $('dr-delivery-toggle').setAttribute('aria-busy', String(!!changingDelivery));
    $('dr-delivery-toggle').disabled = pending > 0;
    fill($('dr-coord-on'), c.coordEnabled, changed);
    renderDrawCategories(c);
    fill($('dr-tone'), s.tone || '', changed);
    fill($('dr-extra'), s.coordExtra || '', changed);
    panel.querySelectorAll('[data-config]').forEach(e => {
        if (c.relaySchemaVersion === 1 && /^(eyeApi|coordApi|eyeModel|coordModel|coordUseEye)/.test(e.dataset.config)) return;
        fill(e, c[e.dataset.config], changed);
    });
    fill($('dr-pool-use-context'), c.poolUseContext !== false, changed);
    $('dr-pool-use-context').disabled = pending > 0;
    $('dr-pool-use-context').closest('label').hidden = c.chimeMode !== 'pool';
    panel.querySelectorAll('[data-pool-only]').forEach(e => { e.hidden = c.chimeMode !== 'pool'; });
    panel.querySelectorAll('[data-dynamic-only]').forEach(e => { e.hidden = c.chimeMode === 'pool'; });
    relayUI.renderRelays(c);
    ['chime', 'coord'].forEach(kind => {
        const sig = relayUI.signatureOf(kind);
        if (sig && sig !== relayUI.connectionSignature(kind)) relayUI.invalidateModels(kind, true);
    });
    const history = $('dr-hist');
    history.replaceChildren();
    if (!(s.history || []).length) history.textContent = t('repair.noHistory');
    (s.history || []).slice().reverse().forEach(h => {
        const row = document.createElement('div'), label = document.createElement('small'), list = document.createElement('div');
        label.textContent = String(h.round) + ' · ' + t('repair.history.' + h.status);
        cards(list, h.cards || (h.card ? [{ hook: h.card, title: h.pool }] : []));
        row.append(label, list); history.appendChild(row);
    });
    $('dr-cancel').disabled = false;
    ['dr-draw', 'dr-preview', 'dr-coord-run'].forEach(id => { $(id).disabled = !!r.busy || pending > 0; });
    const fault = r.configFault || '';
    $('dr-config-fault').hidden = !fault;
    $('dr-config-fault').textContent = fault;
    $('dr-config-repair-row').hidden = !fault;
    if (!fault) repairArmed = false;
    if (fault) msg('dr-msg1', t('relay.faultHint'), 'err');
    else if (r.diagnostic) msg('dr-msg1', r.diagnostic, 'warn');
}

async function refresh() {
    if (disposed) return;
    if (!app()) {
        $('dr-delivery-toggle').disabled = true;
        panel.querySelectorAll('[data-draw-category]').forEach(e => { e.disabled = true; });
        ['dr-draw', 'dr-preview', 'dr-cancel'].forEach(id => { $(id).disabled = true; });
        return;
    }
    const id = ++refreshId;
    try {
        const r = await app().snapshot();
        if (disposed || id !== refreshId) return;
        snap = r; render(r);
    } catch (e) { msg('dr-msg1', e.message || String(e), 'err'); }
}

async function act(id, fn) {
    if (!app()) { msg(id, t('ui.wait'), 'warn'); return; }
    const chatAtStart = currentChat;
    pending++; if (snap) render(snap);
    msg(id, t('ui.busy'));
    try {
        const result = await fn(app());
        if (disposed || currentChat !== chatAtStart) return;
        if (result && result.ok === false) throw Error(result.reason || t('repair.failed'));
        msg(id, (result && result.reason) || t('ui.saved'), 'ok');
        return result;
    } catch (e) {
        if (!disposed && currentChat === chatAtStart) msg(id, e.message || String(e), 'err');
    } finally {
        pending--; if (!disposed) await refresh();
    }
}

function click(id, messageId, fn) { on($(id), 'click', () => { act(messageId, fn); }); }

async function saveFields(api, selector) {
    const fields = Array.from(panel.querySelectorAll(selector)), patch = {}, revisions = {};
    fields.forEach(e => { patch[e.dataset.config] = value(e); revisions[keyOf(e)] = inputRevision.get(keyOf(e)); });
    const result = await api.saveCfg(patch);
    if (!result || result.ok !== false) {
        fields.forEach(e => { if (revisions[keyOf(e)] === inputRevision.get(keyOf(e))) dirty.delete(keyOf(e)); });
    }
    return result;
}

async function saveText(api, id, method) {
    const e = $(id), rev = inputRevision.get(id), result = await api[method](e.value);
    if ((!result || result.ok !== false) && rev === inputRevision.get(id)) dirty.delete(id);
    return result;
}

function closeResetDialog() {
    resetConfirmationChat = null;
    if ($('dr-reset-dialog').open) $('dr-reset-dialog').close();
}

function poolConsent() { if (!$('dr-pool-consent').checked) throw Error(t('pool.needConsent')); }

async function startPool(a, refill) {
    poolConsent();
    const chatId = currentChat;
    const saved = await saveFields(a, '#dr-pool-pane [data-config]');
    if (saved && saved.ok === false) throw Error(saved.reason || t('repair.failed'));
    if (currentChat !== chatId || disposed) throw Error(t('repair.chatChanged'));
    return a.buildPool({ confirmed: true, refill: !!refill, expectedChatId: chatId });
}

function bind() {
    setupDrag(ball, ball, true);
    setupDrag($('dr-panel-head'), panel, false);
    on($('dr-close'), 'click', () => { closeResetDialog(); panel.classList.remove('show'); });
    on($('dr-theme'), 'click', () => { theme = theme === 'day' ? 'night' : 'day'; applyTheme(); remember(); });
    on($('dr-ball-toggle'), 'click', () => {
        const hidden = !ball.classList.contains('hide');
        applyBallHidden(hidden);
        prefs.ballHidden = hidden; remember();
    });
    panel.querySelectorAll('.dr-tab').forEach(tab => {
        on(tab, 'click', () => {
            panel.querySelectorAll('.dr-tab').forEach(x => {
                x.classList.toggle('on', x === tab);
                x.setAttribute('aria-selected', x === tab ? 'true' : 'false');
            });
            panel.querySelectorAll('.dr-page').forEach(x => x.classList.toggle('on', x.id === 'dr-page-' + tab.dataset.page));
            $('dr-panel-body').scrollTop = 0;
        });
    });
    panel.querySelectorAll('h5[data-fold]').forEach(head => {
        head.tabIndex = 0;
        head.setAttribute('role', 'button');
        head.setAttribute('aria-expanded', String(!panel.querySelector('[data-foldbody="' + head.dataset.fold + '"]').classList.contains('hide')));
        const toggle = () => {
            const body = panel.querySelector('[data-foldbody="' + head.dataset.fold + '"]');
            body.classList.toggle('hide');
            head.setAttribute('aria-expanded', String(!body.classList.contains('hide')));
            const caret = head.querySelector('.dr-caret');
            if (caret) caret.textContent = body.classList.contains('hide') ? '▸' : '▾';
        };
        on(head, 'click', toggle);
        on(head, 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
    panel.querySelectorAll('input,select,textarea').forEach(e => { on(e, 'input', () => { recordEdit(e); }); });
    on(window, 'baobaodai:open', () => { openPanel(); });
    on(window, 'baobaodai:updated', refresh);
    on(window, 'resize', clampAll);
    on($('dr-delivery-toggle'), 'click', function () {
        if (deliveryIntent || pending || !app()) return;
        const intent = { enabled: this.getAttribute('aria-checked') !== 'true', chatId: currentChat };
        deliveryIntent = intent;
        this.setAttribute('aria-checked', String(intent.enabled));
        act('dr-msg1', async api => {
            try {
                const result = await api.saveCfg({ chimeEnabled: intent.enabled });
                if (result && result.ok === false) return result;
                const current = await api.snapshot();
                if (intent.enabled && current.chatId === intent.chatId && current.state.paused) return await api.setPaused(false);
                return result;
            } finally { if (deliveryIntent === intent) deliveryIntent = null; }
        });
    });
    on($('dr-coord-on'), 'change', function () {
        const enabled = this.checked;
        act('dr-msg3', async api => {
            try { return await api.saveCfg({ coordEnabled: enabled }); }
            finally { dirty.delete('dr-coord-on'); $('dr-coord-on').checked = (await api.snapshot()).cfg.coordEnabled; }
        });
    });
    panel.querySelectorAll('[data-draw-category]').forEach(e => {
        on(e, 'change', () => {
            const category = e.dataset.drawCategory, checked = e.checked;
            let selected = drawCategories(snap.cfg).filter(k => k !== 'auto' && k !== category);
            if (category === 'auto') selected = checked ? ['auto'] : [];
            else if (checked) selected.push(category);
            act('dr-category-msg', api => api.saveCfg({ poolDrawCategories: selected }));
        });
    });
    on($('dr-pool-use-context'), 'change', function () {
        const e = this, enabled = e.checked;
        act('dr-msg1', async api => {
            try { return await api.saveCfg({ poolUseContext: enabled }); }
            finally { dirty.delete(e.id); const current = await api.snapshot(); e.checked = current.cfg.poolUseContext !== false; }
        });
    });
    on($('dr-pool-toggle'), 'click', () => { poolInventoryVisible = !poolInventoryVisible; renderPoolVisibility(); });
    click('dr-pool-build', 'dr-pool-msg', a => startPool(a, false));
    click('dr-pool-refill', 'dr-pool-msg', a => startPool(a, true));
    click('dr-pool-stop', 'dr-pool-msg', a => { a.cancel(); return { ok: true, reason: t('pool.stopped') }; });
    click('dr-pool-save', 'dr-pool-msg', a => { if ($('dr-pool-auto').checked) poolConsent(); return saveFields(a, '#dr-pool-pane [data-config]'); });
    on($('dr-pool-reset'), 'click', () => {
        if (!snap || !app() || pending || snap.busy || $('dr-reset-dialog').open) return;
        resetConfirmationChat = currentChat;
        $('dr-reset-dialog').showModal();
        $('dr-reset-cancel').focus();
    });
    on($('dr-reset-cancel'), 'click', closeResetDialog);
    on($('dr-reset-dialog'), 'close', () => { if (!$('dr-reset-dialog').open) resetConfirmationChat = null; });
    on($('dr-reset-dialog'), 'cancel', () => { resetConfirmationChat = null; });
    on($('dr-reset-accept'), 'click', () => {
        const chatId = resetConfirmationChat;
        if (chatId == null || !$('dr-reset-dialog').open) return;
        closeResetDialog();
        act('dr-pool-msg', async a => {
            const current = await a.snapshot();
            if (disposed || currentChat !== chatId || current.chatId !== chatId) throw Error(t('repair.chatChanged'));
            if (current.busy) throw Error(t('ui.busy'));
            return a.resetPool(true, chatId);
        });
    });
    panel.querySelectorAll('[data-pool-category]').forEach(button => {
        on(button, 'click', () => {
            poolCategory = button.dataset.poolCategory;
            prefs.poolCategory = poolCategory; poolPage = 0;
            remember(); if (snap) renderPool(snap);
        });
    });
    on($('dr-pool-view'), 'change', () => { poolPage = 0; if (snap) renderPool(snap); });
    on($('dr-pool-prev'), 'click', () => { poolPage = Math.max(0, poolPage - 1); if (snap) renderPool(snap); });
    on($('dr-pool-next'), 'click', () => { poolPage++; if (snap) renderPool(snap); });
    ['dr-draw', 'dr-preview', 'dr-cancel'].forEach(id => {
        const e = $(id); let timer;
        on(e, 'click', () => {
            clearTimeout(timer); e.classList.add('dr-feedback');
            timer = setTimeout(() => { e.classList.remove('dr-feedback'); }, 350);
        });
    });
    click('dr-draw', 'dr-msg1', a => a.drawNow());
    click('dr-preview', 'dr-msg1', async a => {
        const chatId = currentChat, r = await a.previewDraw();
        if (r.ok && chatId === currentChat && !disposed) {
            $('dr-preview-box').hidden = false;
            cards($('dr-preview-cards'), r.cards, 'ui.noIntervention');
        }
        return r;
    });
    click('dr-close-card', 'dr-msg1', a => a.closeCard(false));
    click('dr-cancel', 'dr-msg1', a => { a.cancel(); return { ok: true, reason: t('repair.cancelled') }; });
    click('dr-check', 'dr-msg1', async a => {
        const r = await a.selfCheck();
        return { ok: r.ok, reason: r.reason + '\n' + t('ui.localOnly') };
    });
    click('dr-resync', 'dr-msg1', a => a.resync());
    click('dr-config-repair', 'dr-msg1', async a => {
        if (!a.repairRelays) throw Error(t('ui.wait'));
        const r = await a.repairRelays(repairArmed);
        repairArmed = r && r.ok === false;
        return r;
    });
    click('dr-pace-save', 'dr-pace-msg', a => saveFields(a, '[data-foldbody="pace"] [data-config]'));
    click('dr-patrol-save', 'dr-patrol-msg', a => saveFields(a, '[data-foldbody="patrol"] [data-config]'));
    click('dr-preset-save', 'dr-preset-msg', a => saveFields(a, '#dr-preset'));
    [['dr-pool-prompt-default', 'dr-chime-prompt', 'poolPrompt', 'dr-prompt-msg'],
        ['dr-coord-prompt-default', 'dr-preset', 'coordPreset', 'dr-preset-msg']].forEach(fields => {
        on($(fields[0]), 'click', () => {
            const runtime = app();
            if (!runtime || !runtime.getDefaultPrompts) { msg(fields[3], t('ui.wait'), 'warn'); return; }
            $(fields[1]).value = runtime.getDefaultPrompts()[fields[2]];
            recordEdit($(fields[1]));
            msg(fields[3], t('prompt.loaded'), 'ok');
        });
    });
    click('dr-chime-prompt-save', 'dr-prompt-msg', a => saveFields(a, '#dr-chime-prompt'));
    click('dr-tone-save', 'dr-msg3', a => saveText(a, 'dr-tone', 'setTone'));
    click('dr-extra-save', 'dr-msg3', a => saveText(a, 'dr-extra', 'setCoordExtra'));
    click('dr-coord-clear', 'dr-msg3', a => a.clearCoord());
    click('dr-coord-run', 'dr-msg3', async a => {
        const chatId = currentChat;
        await saveText(a, 'dr-tone', 'setTone');
        if (chatId !== currentChat || disposed) return { ok: false, reason: t('repair.chatChanged') };
        await saveText(a, 'dr-extra', 'setCoordExtra');
        if (chatId !== currentChat || disposed) return { ok: false, reason: t('repair.chatChanged') };
        const revision = inputRevision.get('dr-extra'), result = await a.runCoordinator();
        if (result.ok && chatId === currentChat && revision === inputRevision.get('dr-extra')) {
            $('dr-extra').value = ''; dirty.delete('dr-extra');
        }
        return result;
    });
    relayUI.bind();
}

function addEntry() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('dr-entry-open')) return;
    const box = document.createElement('div');
    box.className = 'inline-drawer dr-entry';
    // 外壳照酒馆其他扩展的标题栏写：同样的类名才跟随酒馆主题，不能省掉 inline-drawer-toggle 与图标。
    // 区别只是不留展开区，点标题行直接开面板。
    box.innerHTML = '<div class="inline-drawer-toggle inline-drawer-header" id="dr-entry-open" role="button" tabindex="0">'
        + '<b>👝 百宝袋</b>'
        + '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>';
    host.appendChild(box);
    const head = document.getElementById('dr-entry-open');
    // 阻止冒泡：酒馆的折叠处理器找不到展开区，没必要让它去翻图标状态
    head.addEventListener('click', e => { e.stopPropagation(); openPanel(); });
    head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); } });
}

export async function mountPanel() {
    if (document.getElementById('dr-panel')) return;
    const base = new URL('.', import.meta.url).href;
    const res = await fetch(base + 'panel.html');
    if (!res.ok) throw Error('panel.html 读取失败 HTTP ' + res.status);
    const holder = document.createElement('div');
    holder.id = 'dr-root';
    holder.innerHTML = await res.text();
    document.body.appendChild(holder);

    panel = $('dr-panel'); ball = $('dr-ball');
    if (!panel || !ball) throw Error('面板结构缺失');

    try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (_) { prefs = {}; }
    theme = prefs.theme === 'night' ? 'night' : 'day';
    poolCategory = ['plot', 'emotion', 'nsfw', 'all'].indexOf(prefs.poolCategory) >= 0 ? prefs.poolCategory : 'plot';

    relayUI = createRelayUI({
        $, t, panel, on, app, msg, act, click, dirty, inputRevision, recordEdit, value, saveFields, keyOf,
        getSnap: () => snap, setSnap: r => { snap = r; }, render,
        getCurrentChat: () => currentChat,
        isPending: () => pending > 0,
        isDisposed: () => disposed,
    });

    bind();
    addEntry();
    localize();
    applyBallHidden(prefs.ballHidden === true);
    const hv = $('dr-head-v');
    if (hv && app()) hv.textContent = 'v' + app().version;
    if (prefs.ball && Number.isFinite(prefs.ball.x) && Number.isFinite(prefs.ball.y)) clampPosition(ball, prefs.ball.x, prefs.ball.y);
    else clampAll();

    window.__baobaodaiPanelDispose = () => {
        closeResetDialog();
        disposed = true; clearInterval(poll);
        cleanups.forEach(f => { try { f(); } catch (_) {} });
        cleanups = [];
    };

    refresh();
    if (!app()) {
        poll = setInterval(() => {
            if (disposed || app() || ++pollCount >= 40) { clearInterval(poll); if (!disposed) refresh(); }
        }, 250);
    }
}

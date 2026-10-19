import * as H from './host.js';
import { config, apiConfig, savingCount } from './config.js';

export const CHIME_VAR = 'director_chime_context';
export const COORD_VAR = 'director_coord_context';

export let epoch = 0;
export const jobs = new Set();
let queue = Promise.resolve();
let diagnostic = '';
const repairedStates = new WeakSet();

export function bumpEpoch() { epoch++; }
export function setDiagnostic(text) { diagnostic = H.cut(text, 240); }
export function getDiagnostic() { return diagnostic; }

export function notify() {
    try { window.dispatchEvent(new CustomEvent('baobaodai:updated')); } catch (_) {}
}

export function serial(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

export function newPool() {
    return { schema: 1, owner: null, source: null, cards: [], targets: {}, nextId: 1, status: 'empty', error: '', pending: null, autoAttempted: false };
}

export function poolOf(s) {
    if (!s.pool || s.pool.schema !== 1) s.pool = newPool();
    if (!Array.isArray(s.pool.cards)) s.pool.cards = [];
    if (!s.pool.targets || typeof s.pool.targets !== 'object') s.pool.targets = {};
    return s.pool;
}

function cardIds(cards) {
    if (!Array.isArray(cards) || !cards.length) return null;
    const ids = cards.map(c => c && c.id);
    return ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length ? ids : null;
}

function sameIds(a, b) {
    return !!a && !!b && a.length === b.length && a.every(id => b.includes(id));
}

function poolHistory(s, ids) {
    return s.history.slice().reverse().find(h => h && h.mode === 'pool' && !h.previousPool
        && h.status === 'active' && sameIds(cardIds(h.cards), ids));
}

function reservation(s) {
    const p = poolOf(s), pending = p.pending;
    const ids = pending && Array.isArray(pending.ids) ? cardIds(pending.ids.map(id => ({ id }))) : null;
    if (!ids || s.floatStage === 'done' || !sameIds(ids, cardIds(s.activeCards))) return null;
    const cards = ids.map(id => p.cards.filter(c => c && c.id === id));
    if (cards.some(matches => matches.length !== 1 || matches[0].status !== 'reserved')) return null;
    return { ids, cards: cards.map(matches => matches[0]) };
}

// Recover reservations without inferring whether a suggestion reached the model.
// A complete pending/active/reserved group is retryable; detached reservations are released.
export function normalizePoolState(s) {
    const before = JSON.stringify([s.pool, s.activeCards, s.floatStage, s.history]);
    const p = poolOf(s), previousPending = p.pending, activeIds = cardIds(s.activeCards);
    const current = reservation(s);
    const activePool = !!activeIds && (s.history.some(h => h && h.mode === 'pool' && h.status === 'active'
        && sameIds(cardIds(h.cards), activeIds)) || activeIds.some(id => p.cards.some(c => c && c.id === id))
        || !!previousPending);
    let keepHistory;
    if (current) {
        if (typeof p.pending.key !== 'string') p.pending.key = '';
        // Old attempts have no reliable origin: a retry's empty key is not evidence of a manual draw.
        if (!['manual', 'automatic', 'legacy'].includes(p.pending.origin)) p.pending.origin = 'legacy';
        if (s.floatStage === 'faded') s.floatStage = 'active';
        keepHistory = poolHistory(s, current.ids);
        if (!keepHistory) {
            // The reservation itself proves only selection, so restore an active record, never a receipt.
            keepHistory = { cards: H.clone(s.activeCards), round: s.floatAt, status: 'active', mode: 'pool', recovered: true };
            s.history.push(keepHistory);
            s.history = s.history.slice(-20);
        }
        keepHistory.origin = p.pending.origin;
    } else {
        p.pending = null;
        if (activePool) { s.activeCards = []; s.floatStage = 'done'; s.floatCard = null; }
    }
    const keepIds = new Set(current ? current.ids : []);
    p.cards.forEach(c => { if (c && c.status === 'reserved' && !keepIds.has(c.id)) c.status = 'available'; });
    s.history.forEach(h => {
        if (h && h.mode === 'pool' && h.status === 'active' && h !== keepHistory) h.status = 'invalidated';
    });
    if (!s.activeCards.length) s.floatStage = 'done';
    return before !== JSON.stringify([s.pool, s.activeCards, s.floatStage, s.history]);
}

export function releasePool(s) {
    const p = poolOf(s); if (!p.pending) return;
    const ids = new Set(Array.isArray(p.pending.ids) ? p.pending.ids : []);
    p.cards.forEach(c => { if (c && ids.has(c.id) && c.status === 'reserved') c.status = 'available'; });
    p.pending = null;
}

export function consumePool(s, key, force, status = 'delivered') {
    const p = poolOf(s); if (!p.pending || (!force && p.pending.key !== key)) return false;
    const current = reservation(s), h = current && poolHistory(s, current.ids);
    if (!current || !h) return false;
    const at = Date.now();
    current.cards.forEach(c => { c.status = 'used'; c.usedAt = at; c.generationKey = key; });
    h.status = status; h.generationKey = key; h.deliveredAt = at;
    if (status === 'fulfilled') h.confirmedAt = at;
    p.pending = null; return true;
}

export function archiveActive(s, status) {
    const ids = cardIds(s.activeCards), p = poolOf(s);
    const isPool = !!p.pending || !!poolHistory(s, ids);
    if (status === 'fulfilled' && isPool) return consumePool(s, 'manual-confirmation', true, 'fulfilled');
    const signature = cards => JSON.stringify((cards || []).map(c => [c.title || '', c.hook || '', c.anchor || '', c.kind || '']));
    const h = ids ? poolHistory(s, ids) : s.history.slice().reverse().find(item => item && item.status === 'active'
        && item.mode !== 'pool' && signature(item.cards) === signature(s.activeCards));
    releasePool(s);
    if (h) h.status = status;
    return !!h;
}

export function readState() {
    let s = H.readRawState();
    s = Object.assign({
        schemaVersion: 3, revision: 0, lastDrawAt: -1, coordAt: -1, paused: false, tone: '', coordExtra: '', coordText: '',
        coordLog: [], history: [], candidates: [], activeCards: [], floatStage: 'done', floatAt: -1,
        lastDecision: '', lastPreparedAnchor: '', rerollAnchor: '', rerolls: 0, ngSuggested: false,
    }, s || {});
    ['history', 'coordLog', 'candidates', 'activeCards'].forEach(k => { if (!Array.isArray(s[k])) s[k] = []; });
    s.history = s.history.slice(-20); s.coordLog = s.coordLog.slice(-5);
    if (s.schemaVersion !== 3 || (!s.dynamicMigrated && s.floatCard && s.floatStage !== 'done')) {
        if (!s.activeCards.length && s.floatCard) s.activeCards = [{ title: '迁移的剧情条', hook: H.cut(s.floatCard.card, 600), anchor: '', kind: '迁移' }];
    }
    s.schemaVersion = 3; s.dynamicMigrated = true;
    if (normalizePoolState(s)) repairedStates.add(s);
    return s;
}

export function chimeText(s) {
    if (!config.chimeEnabled || s.paused || s.floatStage === 'done' || !s.activeCards.length) return '';
    let header = '【幕后创意空投机｜候选事件，尚未发生】\n以下是可选叙事建议，不是既定事实。不要展示幕后调度；不得替用户决定行动、发言或心理。尊重角色设定、已有事实及用户当轮选择。每轮至多择一自然承接，允许全部暂缓；不得强行把多个事件同时落实。';
    if (s.floatStage === 'faded') header += '\n这组建议已降为低优先级；是否发生只以聊天正文为准，未发生的不得当作回忆。';
    return header + '\n' + s.activeCards.map((c, i) => (i + 1) + '. ' + (c.title && c.title !== c.hook ? H.safeText(c.title, 50) + '：' : '') + H.safeText(c.hook, 600)).join('\n');
}

export function coordText(s) {
    if (!config.coordEnabled || !s.coordText) return '';
    return '【幕后场外小叮当｜执行建议而非已发生事实】\n不展示此调度，不替用户做决定；不得覆盖既有设定与用户选择。\n' + H.safeText(s.coordText, 1200);
}

// 值没变不写，免得每次刷新都触发一次聊天存盘
export function syncVars(s) {
    [[CHIME_VAR, chimeText(s)], [COORD_VAR, coordText(s)]].forEach(([name, text]) => {
        if (H.getChatVar(name) !== text) H.setChatVar(name, text);
    });
}

// revision 兼作抽卡的乐观锁；没有真实变化时不能 bump，否则会把正在跑的抽卡判成「状态已变化」白跳一轮
function sameState(a, b) {
    try {
        const ra = a.revision, rb = b.revision;
        a.revision = b.revision = 0;
        const equal = JSON.stringify(a) === JSON.stringify(b);
        a.revision = ra; b.revision = rb;
        return equal;
    } catch (_) { return false; }
}

export async function scope(job) {
    const key = H.chatKey();
    if (!key || (job && (job.epoch !== epoch || String(key) !== String(job.chatId)))) throw Error('聊天已切换，已丢弃旧任务');
    return key;
}

export async function guard(job) {
    if (job && (job.cancelled || Date.now() >= job.deadline)) throw Error('任务已取消或超时');
    return scope(job);
}

export async function writeState(next, old, job) {
    await guard(job);
    if (!repairedStates.has(old) && sameState(next, old)) {
        next.revision = old.revision || 0; syncVars(next); notify(); return next;
    }
    next.revision = (old.revision || 0) + 1;
    H.writeRawState(next);
    syncVars(next);
    notify();
    return next;
}

export function change(fn, job) {
    return serial(async () => {
        await guard(job);
        const old = readState();
        const next = H.clone(old);
        await fn(next);
        return writeState(next, old, job);
    });
}

export async function startJob(kind, generationId) {
    const key = H.chatKey(); if (!key) throw Error('当前没有可用聊天');
    if (savingCount()) throw Error('接口设置正在保存，请稍后再试');
    if (Array.from(jobs).some(j => !j.cancelled && String(j.chatId) === String(key))) throw Error('百宝袋正在处理，请稍后再试');
    const controller = new AbortController();
    const j = {
        connections: { chime: H.clone(apiConfig('chime')), coord: H.clone(apiConfig('coord')) },
        kind, chatId: key, epoch, generationId: generationId || '', cancelled: false,
        controller, signal: controller.signal, deadline: Date.now() + config.prepareTimeout * 1000,
    };
    j.cancelPromise = new Promise((_, reject) => { j.rejectCancel = reject; });
    j.cancelPromise.catch(() => {});
    jobs.add(j); notify(); return j;
}

export function stop(job) {
    job.cancelled = true;
    try { job.controller.abort(); } catch (_) {}
    if (job.rejectCancel) job.rejectCancel(Error('百宝袋任务已取消，旧结果不会投放'));
}

export function cancelAll() { jobs.forEach(stop); }

export function busy() { return Array.from(jobs).some(j => !j.cancelled); }

export function localEdit(fn, expectedChatId) {
    cancelAll();
    const key = H.chatKey();
    if (!key) throw Error('当前没有可用聊天');
    if (expectedChatId != null && String(key) !== String(expectedChatId)) throw Error('聊天已切换，未执行操作');
    const j = { chatId: key, epoch, deadline: Date.now() + 10000 };
    return change(fn, j);
}

export async function lifecycle(ms, job) {
    const round = H.assistantRound(ms);
    await change(s => {
        if (s.lastDrawAt < 0 || s.lastDrawAt > round) s.lastDrawAt = round;
        if (s.coordAt < 0 || s.coordAt > round) s.coordAt = round;
        // A failed or interrupted main reply may have advanced the assistant round.
        // Keep its pending cards until a receipt or an explicit withdrawal resolves them.
        if (poolOf(s).pending) return;
        const age = round - s.floatAt;
        if (s.floatAt > round) { archiveActive(s, 'invalidated'); s.activeCards = []; s.floatStage = 'done'; }
        if (s.activeCards.length && s.floatStage !== 'done') {
            if (config.chimeLifeMode === 'once' && age >= 1) { archiveActive(s, 'retired'); s.floatStage = 'done'; }
            else if (config.chimeLifeMode === 'half' && age >= Math.max(1, Math.ceil(config.chimeN / 2))) s.floatStage = 'faded';
        }
    }, job);
    return round;
}

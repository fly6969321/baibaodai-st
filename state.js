import * as H from './host.js';
import { config, apiConfig, savingCount } from './config.js';

export const CHIME_VAR = 'director_chime_context';
export const COORD_VAR = 'director_coord_context';

export let epoch = 0;
export const jobs = new Set();
let queue = Promise.resolve();
let diagnostic = '';

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
    return s.pool;
}

export function releasePool(s) {
    const p = poolOf(s); if (!p.pending) return;
    const ids = new Set(p.pending.ids);
    p.cards.forEach(c => { if (ids.has(c.id) && c.status === 'reserved') c.status = 'available'; });
    p.pending = null;
}

export function consumePool(s, key, force) {
    const p = poolOf(s); if (!p.pending || (!force && p.pending.key !== key)) return false;
    const ids = new Set(p.pending.ids);
    p.cards.forEach(c => {
        if (ids.has(c.id) && c.status === 'reserved') { c.status = 'used'; c.usedAt = Date.now(); c.generationKey = key; }
    });
    p.pending = null; return true;
}

export function archiveActive(s, status) {
    if (status === 'fulfilled') consumePool(s, 'manual-confirmation', true); else releasePool(s);
    const h = s.history[s.history.length - 1];
    if (h && h.status === 'active') h.status = status;
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
    s.schemaVersion = 3; s.dynamicMigrated = true; poolOf(s); return s;
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
    if (sameState(next, old)) {
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
        const age = round - s.floatAt;
        if (s.floatAt > round) { archiveActive(s, 'invalidated'); s.activeCards = []; s.floatStage = 'done'; }
        if (s.activeCards.length && s.floatStage !== 'done') {
            if (config.chimeLifeMode === 'once' && age >= 1) { archiveActive(s, 'retired'); s.floatStage = 'done'; }
            else if (config.chimeLifeMode === 'half' && age >= Math.max(1, Math.ceil(config.chimeN / 2))) s.floatStage = 'faded';
        }
    }, job);
    return round;
}

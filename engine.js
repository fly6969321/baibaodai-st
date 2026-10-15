import * as H from './host.js';
import { config, loadCfg, apiConfig, saveCfg, saveRelay, selectRelay, removeRelay, repairRelays, setConfigHooks, getDefaultPrompts, faultText } from './config.js';
import {
    jobs, epoch, bumpEpoch, readState, change, guard, startJob, stop, cancelAll, notify, busy,
    archiveActive, localEdit, lifecycle, setDiagnostic, getDiagnostic, clearInjection, applyInjection,
    poolOf,
} from './state.js';
import { buildContext } from './context.js';
import { ask } from './ask.js';
import {
    buildPool, resetPool, discardPoolCard, drawPool, validatePoolSource, bindPool, settlePool,
    maybeAutoPool, retireOutOfScopeCards,
} from './pool.js';
import { listModels as relayListModels, directAvailable } from './relay.js';

export const VERSION = '0.5.16';

const prepared = new Map(), terminal = new Set();
let bootPromise = null;

function parseCards(raw, s) {
    const text = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '');
    let data;
    try { data = JSON.parse(text); } catch (_) { throw Error('创意空投机响应不是有效剧情 JSON，未投放'); }
    if (!data || typeof data.intervene !== 'boolean' || !Array.isArray(data.cards)) throw Error('剧情 JSON 结构不完整，未投放');
    if (!data.intervene) return { cards: [], reason: H.safeText(data.reason || '当前场景无需介入', 240) };
    const seen = new Set();
    s.history.slice(-8).forEach(h => (h.cards || [{ hook: h.card }]).forEach(c => seen.add(H.safeText(c.hook, 600).replace(/\s/g, ''))));
    const cards = [];
    data.cards.slice(0, 10).forEach(c => {
        if (!c || typeof c.hook !== 'string' || typeof c.title !== 'string' || typeof c.anchor !== 'string') return;
        const hook = H.safeText(c.hook, 600), anchor = H.safeText(c.anchor, 200), key = hook.replace(/\s/g, '');
        if (hook.length < 12 || !anchor || seen.has(key)) return;
        seen.add(key); cards.push({ title: H.safeText(c.title, 50), hook, anchor, kind: H.safeText(c.kind || '事件', 30) });
    });
    if (!cards.length) throw Error('没有有效的新剧情条（空白、重复或缺少依据），未投放');
    return { cards: cards.slice(0, config.chimeCandidates), reason: H.safeText(data.reason, 240) };
}

async function draw(s, round, ms, job, preview) {
    if (!preview && (!config.chimeEnabled || s.paused)) throw Error('创意空投机已关闭或暂停；可以试生成但不投放');
    if (config.chimeMode === 'pool') return drawPool(s, round, ms, job, preview);
    let body = await buildContext(job, ms, s, false);
    body += '\n\n请生成 ' + config.chimeCandidates + ' 条不同方向的候选；无法贴合时返回不介入。';
    const reply = await ask(job, 'chime', config.chimePrompt, body, {});
    const result = parseCards(reply.content, s);
    if (preview) return { ok: true, preview: true, cards: result.cards, reason: result.reason };
    await change(next => {
        if (next.revision !== s.revision) throw Error('剧情生成期间状态已变化，未覆盖新状态');
        next.candidates = result.cards; next.lastDecision = result.reason; next.lastDrawAt = round;
        if (!result.cards.length) return;
        archiveActive(next, 'retired'); next.activeCards = result.cards.slice(0, config.chimeInjectCount);
        next.floatStage = 'active'; next.floatAt = round; next.floatCard = null;
        next.history.push({ cards: next.activeCards, round, status: 'active', mode: 'dynamic', t: Date.now() });
        next.history = next.history.slice(-20);
    }, job);
    return { ok: true, cards: result.cards, skipped: !result.cards.length, reason: result.reason };
}

async function coordinator(s, round, ms, job, extra) {
    if (!config.coordEnabled) throw Error('场外小叮当已关闭');
    let body = await buildContext(job, ms, s, false);
    const usedExtra = extra === undefined ? s.coordExtra : extra;
    if (usedExtra) body = '【用户一次性补充｜优先处理，不覆盖角色事实】\n' + H.cut(usedExtra, 2000) + '\n\n' + body;
    const reply = await ask(job, 'coord', config.coordPreset, body, {});
    let text = H.safeText(reply.content, 1200);
    if (!text) throw Error('场外小叮当返回空内容');
    if (Array.from(text).length > 350) text = Array.from(text).slice(0, 349).join('') + '…';
    await change(next => {
        if (next.revision !== s.revision) throw Error('场外小叮当期间状态已变化，未覆盖新状态');
        next.coordText = text; next.coordAt = round;
        if (next.coordExtra === usedExtra) next.coordExtra = '';
        next.coordLog.push({ t: Date.now(), text }); next.coordLog = next.coordLog.slice(-5); next.ngSuggested = false;
    }, job);
    return { ok: true, text };
}

async function pipeline(event, job) {
    loadCfg(); await guard(job);
    const ms = H.messages(), anchor = H.anchorOf(ms);
    if (!config.chimeEnabled && !config.coordEnabled) return;
    const chime = config.chimeEnabled, coord = config.coordEnabled;
    let s = readState();
    await validatePoolSource(job, ms);
    await bindPool(job);
    if (event.reroll) {
        await change(next => {
            next.rerolls = next.rerollAnchor === anchor ? next.rerolls + 1 : 1;
            next.rerollAnchor = anchor;
            next.ngSuggested = next.rerolls >= 3;
        }, job);
        return;
    }
    if (event.continuation || event.groupFollowup || !anchor || s.lastPreparedAnchor === anchor) return;
    let round = await lifecycle(ms, job);
    s = readState();
    const errors = [];
    if (chime && !s.paused && !(config.chimeMode === 'pool' && poolOf(s).pending) && round - s.lastDrawAt >= config.chimeN) {
        try { await draw(s, round, ms, job, false); } catch (e) { errors.push(e.message); }
    }
    await guard(job); s = readState();
    if (coord && config.coordPatrol && round - s.coordAt >= config.coordPatrolN) {
        try { await coordinator(s, round, ms, job); } catch (e) { errors.push(e.message); }
    }
    await guard(job);
    await change(next => { next.lastPreparedAnchor = anchor; next.rerolls = 0; next.ngSuggested = false; }, job);
    setDiagnostic(errors.length ? errors.join('；') : '');
}

export function prepare(event) {
    const key = String(event.chatId) + ':' + event.generationId;
    if (prepared.has(key)) return prepared.get(key);
    const p = (async () => {
        let j, timer;
        try {
            if (terminal.has(key)) return;
            if (bootPromise) await bootPromise;
            j = await startJob('prepare', event.generationId);
            if (String(j.chatId) !== String(event.chatId)) { stop(j); return; }
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => { stop(j); reject(Error('百宝袋准备超时，主回复正常继续')); }, config.prepareTimeout * 1000);
            });
            await Promise.race([pipeline(event, j), timeout, j.cancelPromise]);
        } catch (e) { setDiagnostic(e.message || e); }
        finally { clearTimeout(timer); if (j) { stop(j); jobs.delete(j); } notify(); }
    })();
    prepared.set(key, p);
    if (prepared.size > 50) prepared.delete(prepared.keys().next().value);
    return p;
}

export async function finish(event) {
    const key = String(event.chatId) + ':' + event.generationId;
    terminal.add(key);
    if (terminal.size > 80) terminal.delete(terminal.values().next().value);
    jobs.forEach(j => {
        if (j.generationId === event.generationId && String(j.chatId) === String(event.chatId)) stop(j);
    });
    try { await settlePool(event); } catch (e) { setDiagnostic(e.message || e); }
    notify();
}

async function manual(kind, fn) {
    let j, timer;
    try {
        if (bootPromise) await bootPromise;
        loadCfg(); j = await startJob(kind);
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { stop(j); reject(Error('百宝袋任务超时')); }, config.prepareTimeout * 1000);
        });
        return await Promise.race([(async () => {
            const ms = H.messages();
            let round = H.assistantRound(ms);
            if (kind !== 'preview') round = await lifecycle(ms, j);
            return fn(readState(), round, ms, j);
        })(), timeout, j.cancelPromise]);
    } catch (e) {
        setDiagnostic(e.message || e);
        return { ok: false, reason: getDiagnostic() };
    } finally { clearTimeout(timer); if (j) { stop(j); jobs.delete(j); } notify(); }
}

function channelStatus() {
    const chime = apiConfig('chime'), coord = apiConfig('coord');
    const notes = [];
    if (config.chimeEnabled && !(chime.url && chime.model)) notes.push('创意空投机：中转站地址或模型未配置');
    if (config.coordEnabled && !(coord.url && coord.model)) notes.push('场外小叮当：中转站地址或模型未配置');
    const route = chime.url && !directAvailable(chime.url) ? '请求经酒馆后端转发' : '请求优先直连，被拦则自动转发';
    return {
        ok: !notes.length,
        chime: config.chimeEnabled && !!(chime.url && chime.model),
        coord: config.coordEnabled && !!(coord.url && coord.model),
        reason: notes.length ? notes.join('；') : '注入走酒馆原生接口，不需要在预设里加条目 · ' + route,
    };
}

export function snapshot() {
    const key = H.chatKey();
    const s = key ? readState() : readState();
    return {
        version: VERSION, cfg: H.clone(config), state: s, chatId: key,
        channels: channelStatus(), diagnostic: getDiagnostic(), configFault: faultText(), busy: busy(),
    };
}

export async function boot() {
    try {
        loadCfg();
        const key = H.chatKey();
        if (!key) { clearInjection(); notify(); return; }
        const j = { chatId: key, epoch, deadline: Date.now() + 15000 };
        const ms = H.messages();
        await validatePoolSource(j, ms);
        const round = H.assistantRound(ms);
        await change(s => {
            if (s.lastDrawAt < 0) s.lastDrawAt = round;
            if (s.coordAt < 0) s.coordAt = round;
        }, j);
    } catch (e) { setDiagnostic(e.message || e); }
    notify();
    setTimeout(maybeAutoPool, 0);
}

export function reboot() { bootPromise = boot(); return bootPromise; }
export function ready() { return bootPromise; }

export function onChatClosed() {
    bumpEpoch(); cancelAll(); clearInjection(); notify();
}

export function onChatChanged() {
    bumpEpoch(); cancelAll(); prepared.clear(); terminal.clear(); clearInjection(); reboot();
}

// 编辑/删除正文让旧调度失效；回合计数不动（重生成就是先删一楼，清零会让自动空投永远不投）
export function invalidateGrounding() {
    return localEdit(s => {
        archiveActive(s, 'invalidated');
        s.activeCards = []; s.floatStage = 'done'; s.floatCard = null;
        s.coordText = ''; s.lastPreparedAnchor = '';
    });
}

setConfigHooks({
    cancelAll,
    notify,
    afterCommit: async () => {
        try { await localEdit(s => { retireOutOfScopeCards(s); }); }
        catch (_) { applyInjection(readState()); }
    },
});

export const app = {
    version: VERSION,
    snapshot,
    listModels: async (kind, draft) => {
        const conn = draft && draft.relayDraft
            ? { url: String(draft.relayDraft.url || '').trim(), key: String(draft.relayDraft.key || '').trim() }
            : apiConfig(kind);
        const result = await relayListModels(conn);
        return { ok: true, models: result.models, via: result.via };
    },
    cancelModelList: () => {},
    buildPool, resetPool, discardPoolCard,
    saveCfg, saveRelay, selectRelay, removeRelay, repairRelays,
    getDefaultPrompts,
    setTone: text => localEdit(s => { s.tone = H.cut(text, 4000); }),
    setCoordExtra: text => localEdit(s => { s.coordExtra = H.cut(text, 4000); }),
    setPaused: on => localEdit(s => { s.paused = !!on; }),
    previewDraw: () => manual('preview', (s, n, ms, j) => draw(s, n, ms, j, true)),
    drawNow: () => manual('draw', (s, n, ms, j) => draw(s, n, ms, j, false)),
    runCoordinator: extra => manual('coord', (s, n, ms, j) => coordinator(s, n, ms, j, extra)),
    closeCard: fulfilled => localEdit(s => {
        archiveActive(s, fulfilled ? 'fulfilled' : 'retired');
        s.floatStage = 'done'; s.activeCards = []; s.floatCard = null;
    }),
    clearCoord: () => localEdit(s => { s.coordText = ''; }),
    resync: () => manual('resync', async (s, n, ms, j) => {
        await change(next => { next.lastDrawAt = n; next.coordAt = n; }, j);
        return { ok: true, round: n };
    }),
    selfCheck: async () => {
        if (bootPromise) await bootPromise;
        try { await localEdit(() => {}); } catch (_) {}
        const r = channelStatus();
        return Object.assign({}, r, {
            chimeConfigured: !!(apiConfig('chime').url && apiConfig('chime').model),
            coordConfigured: !!(apiConfig('coord').url && apiConfig('coord').model),
        });
    },
    cancel: () => { cancelAll(); notify(); },
    refresh: () => { notify(); },
};

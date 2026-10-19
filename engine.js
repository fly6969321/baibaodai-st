import * as H from './host.js';
import { config, loadCfg, apiConfig, saveCfg, saveRelay, selectRelay, removeRelay, repairRelays, setConfigHooks, getDefaultPrompts, faultText } from './config.js';
import {
    jobs, epoch, bumpEpoch, readState, change, guard, startJob, stop, cancelAll, notify, busy,
    archiveActive, localEdit, lifecycle, setDiagnostic, getDiagnostic, syncVars, CHIME_VAR, COORD_VAR,
    poolOf,
} from './state.js';
import { buildContext } from './context.js';
import { ask } from './ask.js';
import {
    buildPool, resetPool, discardPoolCard, drawPool, validatePoolSource, bindPool, settlePool,
    maybeAutoPool, retireOutOfScopeCards, realignPoolSource,
} from './pool.js';
import { listModels as relayListModels, directAvailable } from './relay.js';

export const VERSION = '0.5.18';

const prepared = new Map(), terminal = new Set();
let bootPromise = null;

function parseCards(raw, s, fromReasoning) {
    const text = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '');
    let data;
    try { data = JSON.parse(text); } catch (_) {
        // 推理字段里常混着思考过程，把 JSON 块剥出来再试一次
        const start = fromReasoning ? text.indexOf('{') : -1, end = fromReasoning ? text.lastIndexOf('}') : -1;
        if (start >= 0 && end > start) { try { data = JSON.parse(text.slice(start, end + 1)); } catch (_) {} }
        if (!data) throw Error('创意空投机响应不是有效剧情 JSON，未投放');
    }
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
    const result = parseCards(reply.content, s, reply.fromReasoning);
    if (preview) return { ok: true, preview: true, cards: result.cards, reason: result.reason };
    await change(next => {
        if (next.revision !== s.revision) throw Error('剧情生成期间状态已变化，未覆盖新状态');
        next.candidates = result.cards; next.lastDecision = result.reason; next.lastDrawAt = round;
        if (!result.cards.length) return;
        archiveActive(next, 'retired'); next.activeCards = result.cards.slice(0, config.chimeInjectCount);
        next.floatStage = 'active'; next.floatAt = round; next.floatCard = null;
        next.activeOrigin = job.generationId ? 'automatic' : 'manual';
        next.history.push({ cards: next.activeCards, round, status: 'active', mode: 'dynamic', origin: next.activeOrigin, t: Date.now() });
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
    const checked = checkChannels(event.type);
    if (!checked.chime && !checked.coord) throw Error(checked.reason);
    const chime = checked.chime, coord = checked.coord;
    await validatePoolSource(job, ms);
    await bindPool(job, chime);
    let s = readState();
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
    const errors = checked.ok ? [] : [checked.reason];
    let failed = false;
    if (chime && !s.paused && !(config.chimeMode === 'pool' && poolOf(s).pending) && round - s.lastDrawAt >= config.chimeN) {
        try { await draw(s, round, ms, job, false); } catch (e) { failed = true; errors.push(e.message); }
    }
    await guard(job); s = readState();
    if (coord && config.coordPatrol && round - s.coordAt >= config.coordPatrolN) {
        try { await coordinator(s, round, ms, job); } catch (e) { failed = true; errors.push(e.message); }
    }
    await guard(job);
    await change(next => {
        // A failed selection must remain retryable for the same user message.
        if (!failed) next.lastPreparedAnchor = anchor;
        next.rerolls = 0; next.ngSuggested = false;
    }, job);
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
            if (terminal.has(key)) return;
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
    if (terminal.has(key)) return;
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
            const check = checkChannels();
            const needs = kind === 'coord' ? 'coord' : (kind === 'draw' || kind === 'preview') ? 'chime' : null;
            const enabled = needs === 'coord' ? config.coordEnabled : config.chimeEnabled;
            if (needs && enabled && !check[needs]) throw Error(check.reason);
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

// 两个模块各判各的：缺调度条目不能拖垮接好的空投
function checkChannels(generationType) {
    const entries = H.presetEntries();
    if (!entries) return { ok: false, chime: false, coord: false, reason: '需要对话补全（Chat Completion）预设；当前接口模式读不到预设条目' };
    const judge = (variable, enabled) => {
        if (!enabled) return { ok: true, live: false, note: '' };
        const matching = entries.filter(e => e.enabled && e.role === 'system' && e.content.indexOf('{{getvar::' + variable + '}}') >= 0);
        if (!matching.length) return { ok: false, live: false, note: variable + '：预设缺少已启用的 system 条目' };
        const type = String(generationType || '').trim().toLowerCase();
        const live = !type || matching.some(e => !e.triggers.length || e.triggers.includes(type));
        return live ? { ok: true, live: true, note: '' }
            : { ok: false, live: false, note: variable + '：预设条目未允许本次生成类型 ' + type };
    };
    const chime = judge(CHIME_VAR, config.chimeEnabled), coord = judge(COORD_VAR, config.coordEnabled);
    const notes = [chime.note, coord.note].filter(Boolean);
    const conn = apiConfig('chime');
    const route = conn.url && !directAvailable(conn.url) ? '请求经酒馆后端转发' : '请求优先直连，被拦则自动转发';
    const name = H.presetName();
    return {
        ok: chime.ok && coord.ok, chime: chime.live, coord: coord.live,
        reason: notes.length ? notes.join('；') : '预设' + (name ? '「' + name + '」' : '') + '条目检查通过 · ' + route,
    };
}

export function snapshot() {
    return {
        version: VERSION, cfg: H.clone(config), state: readState(), chatId: H.chatKey(),
        channels: checkChannels(), diagnostic: getDiagnostic(), configFault: faultText(), busy: busy(),
    };
}

export async function boot() {
    try {
        loadCfg();
        const key = H.chatKey();
        if (!key) { notify(); return; }
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
    bumpEpoch(); cancelAll(); notify();
}

export function onChatChanged() {
    bumpEpoch(); cancelAll(); prepared.clear(); terminal.clear(); reboot();
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
        catch (_) { try { syncVars(readState()); } catch (__) {} }
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
    buildPool, resetPool, discardPoolCard, realignPoolSource,
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
        const r = checkChannels();
        return Object.assign({}, r, {
            chimeConfigured: !!(apiConfig('chime').url && apiConfig('chime').model),
            coordConfigured: !!(apiConfig('coord').url && apiConfig('coord').model),
        });
    },
    cancel: () => { cancelAll(); notify(); },
    refresh: () => { notify(); },
};

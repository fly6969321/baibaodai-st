import { readRawCfg, writeRawCfg, cut, clone } from './host.js';
import { relayBase, clearDirectCache } from './relay.js';
import { COORD_PROMPT, LEGACY_COORD_PROMPT, LEGACY_POOL_PROMPT, POOL_PROMPT, CHIME_PROMPT } from './prompts.js';

export const DEFAULTS = {
    chimeMode: 'pool', poolModeVersion: 1, poolAutoInit: false, poolTotalCount: 200, poolContextMessages: 6, poolUseContext: true,
    poolPlotOn: true, poolEmotionOn: true, poolNsfwOn: false, poolAdults: false,
    poolPrompt: POOL_PROMPT, poolTimeout: 300, poolDrawCategory: 'auto',
    chimeEnabled: true, chimeN: 5, chimeCandidates: 3, chimeInjectCount: 3,
    chimeLifeMode: 'half', chimeTimeout: 35,
    chimePrompt: CHIME_PROMPT, contextRounds: 8,
    coordEnabled: true, coordPatrol: false, coordPatrolN: 20,
    coordTimeout: 45, prepareTimeout: 80,
    coordPreset: COORD_PROMPT,
    eyeApiUrl: '', eyeApiKey: '', eyeModel: 'deepseek-chat',
    coordApiUrl: '', coordApiKey: '', coordModel: '', coordUseEye: true,
};

export let config = Object.assign({}, DEFAULTS);
export let configFault = '';
export let configSaving = 0;

function int(x, d, a, b) { x = Number(x); return Number.isFinite(x) ? Math.min(b, Math.max(a, Math.floor(x))) : d; }
function bool(x, d) { return x === undefined ? d : x === true || x === 'true' || x === 1; }

export function normalizeCfg(raw) {
    const c = Object.assign({}, DEFAULTS, raw || {});
    ['chimeEnabled', 'coordEnabled', 'coordPatrol', 'coordUseEye'].forEach(k => { c[k] = bool(c[k], DEFAULTS[k]); });
    c.chimeMode = c.poolModeVersion === 1 && raw && raw.poolModeVersion === 1 && raw.chimeMode === 'dynamic' ? 'dynamic' : 'pool';
    c.poolModeVersion = 1;
    c.chimeN = int(c.chimeN, 5, 1, 50); c.chimeCandidates = int(c.chimeCandidates, 3, 2, 5);
    c.chimeInjectCount = int(c.chimeInjectCount, 3, 1, c.chimeMode === 'pool' ? 5 : c.chimeCandidates);
    c.coordPatrolN = int(c.coordPatrolN, 20, 1, 200); c.contextRounds = int(c.contextRounds, 8, 2, 30);
    c.chimeTimeout = int(c.chimeTimeout, 35, 5, 120); c.coordTimeout = int(c.coordTimeout, 45, 5, 120);
    c.prepareTimeout = int(c.prepareTimeout, 80, 10, 180);
    if (['half', 'once', 'stay'].indexOf(c.chimeLifeMode) < 0) c.chimeLifeMode = 'half';
    ['eyeApiUrl', 'eyeApiKey', 'eyeModel', 'coordApiUrl', 'coordApiKey', 'coordModel'].forEach(k => { c[k] = String(c[k] || '').trim(); });
    c.chimePrompt = String(c.chimePrompt || CHIME_PROMPT);
    c.coordPreset = String(String(c.coordPreset || '').trim() && c.coordPreset !== LEGACY_COORD_PROMPT ? c.coordPreset : COORD_PROMPT);
    ['poolAutoInit', 'poolPlotOn', 'poolEmotionOn', 'poolNsfwOn', 'poolAdults', 'poolUseContext'].forEach(k => { c[k] = bool(c[k], DEFAULTS[k]); });
    c.poolPrompt = cut(String(c.poolPrompt || '').trim() && c.poolPrompt !== LEGACY_POOL_PROMPT ? c.poolPrompt : POOL_PROMPT, 4000);
    c.poolTotalCount = int(c.poolTotalCount, 200, 1, 600); c.poolContextMessages = int(c.poolContextMessages, 6, 1, 100);
    c.poolTimeout = int(c.poolTimeout, 300, 10, 600);
    if (['auto', 'plot', 'emotion', 'nsfw'].indexOf(c.poolDrawCategory) < 0) c.poolDrawCategory = 'auto';
    const selected = Array.isArray(c.poolDrawCategories) ? c.poolDrawCategories : [c.poolDrawCategory];
    c.poolDrawCategories = selected.indexOf('auto') >= 0 ? ['auto'] : ['plot', 'emotion', 'nsfw'].filter(k => selected.indexOf(k) >= 0);
    return normalizeRelays(c);
}

export function normalizeRelays(c) {
    if (c.relaySchemaVersion !== undefined && c.relaySchemaVersion !== 1) throw Error('未知中转配置版本，请勿覆盖原配置');
    if (c.relaySchemaVersion !== 1) {
        c.relayProfiles = [];
        c.eyeRelayId = ''; c.coordRelayId = '';
        if (c.eyeApiUrl || c.eyeApiKey) {
            c.relayProfiles.push({ id: 'legacy-eye', name: '原创意空投机中转', url: c.eyeApiUrl, key: c.eyeApiKey, model: c.eyeModel });
            c.eyeRelayId = 'legacy-eye';
        }
        if (c.coordApiUrl || c.coordApiKey) {
            c.relayProfiles.push({ id: 'legacy-coord', name: '原场外小叮当中转', url: c.coordApiUrl, key: c.coordApiKey, model: c.coordModel });
            c.coordRelayId = 'legacy-coord';
            if (c.coordApiUrl) c.coordUseEye = false;
        }
        if (!c.coordApiUrl && c.coordUseEye && c.coordModel && c.coordModel !== c.eyeModel && c.eyeRelayId) { c.coordRelayId = c.eyeRelayId; c.coordUseEye = false; }
        c.relaySchemaVersion = 1; c.relayRevision = 0;
    }
    if (!Array.isArray(c.relayProfiles) || c.relayProfiles.length > 30) throw Error('中转配置损坏或超过 30 个，请勿覆盖原配置');
    const ids = new Set();
    c.relayProfiles = c.relayProfiles.map(p => {
        if (!p || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id)) throw Error('中转 ID 无效或重复，请勿覆盖原配置');
        ids.add(p.id);
        return { id: p.id, name: cut(p.name || '未命名中转', 80), url: String(p.url || '').trim(), key: String(p.key || '').trim(), model: String(p.model || '').trim() };
    });
    ['eyeRelayId', 'coordRelayId'].forEach(k => { c[k] = String(c[k] || ''); if (c[k] && !ids.has(c[k])) throw Error('模块绑定的中转不存在，请修复配置'); });
    c.relayRevision = Number.isSafeInteger(c.relayRevision) && c.relayRevision >= 0 ? c.relayRevision : 0;
    const eye = c.relayProfiles.find(p => p.id === c.eyeRelayId);
    const coord = c.relayProfiles.find(p => p.id === c.coordRelayId);
    c.eyeApiUrl = eye ? eye.url : ''; c.eyeApiKey = eye ? eye.key : '';
    c.coordApiUrl = coord ? coord.url : ''; c.coordApiKey = coord ? coord.key : '';
    return c;
}

export function readCfg() {
    try { const parsed = normalizeCfg(readRawCfg()); configFault = ''; return parsed; }
    catch (e) { configFault = cut(e.message || e, 240); throw e; }
}

export function loadCfg() { config = readCfg(); return config; }

export function apiConfig(kind, source) {
    const c = source || config;
    if (c.relaySchemaVersion === 1) {
        const reuse = kind === 'coord' && c.coordUseEye, prefix = kind === 'chime' || reuse ? 'eye' : 'coord';
        const p = c.relayProfiles.find(x => x.id === c[prefix + 'RelayId']);
        return { url: p ? p.url : '', key: p ? p.key : '', model: c[prefix + 'Model'], timeout: kind === 'coord' ? c.coordTimeout : c.chimeTimeout };
    }
    if (kind === 'coord') {
        return {
            url: c.coordApiUrl || (c.coordUseEye ? c.eyeApiUrl : ''),
            key: c.coordApiUrl ? c.coordApiKey : (c.coordUseEye ? c.eyeApiKey : ''),
            model: c.coordModel || (c.coordUseEye ? c.eyeModel : ''), timeout: c.coordTimeout,
        };
    }
    return { url: c.eyeApiUrl, key: c.eyeApiKey, model: c.eyeModel, timeout: c.chimeTimeout };
}

function relayKind(kind) { if (kind !== 'chime' && kind !== 'coord') throw Error('未知接口类型'); return kind === 'chime' ? 'eye' : 'coord'; }
function newRelayId() { return 'relay-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

let cfgQueue = Promise.resolve();
function cfgSerial(fn) { const p = cfgQueue.then(fn, fn); cfgQueue = p.catch(() => {}); return p; }

// hooks 由 engine 注入：写配置前要取消在跑的任务，写完要同步投放范围与注入
let hooks = { cancelAll() {}, afterCommit: async () => {}, notify() {} };
export function setConfigHooks(next) { hooks = Object.assign({}, hooks, next); }

export function commitCfg(edit, expectedRevision) {
    return cfgSerial(async () => {
        const fresh = readCfg();
        if (expectedRevision !== undefined && expectedRevision !== fresh.relayRevision) throw Error('设置已被其他操作修改，请放弃草稿并重新载入后保存');
        let next = clone(fresh); edit(next); next = normalizeCfg(next); next.relayRevision = fresh.relayRevision + 1;
        configSaving++; hooks.cancelAll();
        try {
            writeRawCfg(next); config = next;
            clearDirectCache();
            await hooks.afterCommit();
            return { ok: true, revision: config.relayRevision };
        } finally { configSaving--; hooks.notify(); }
    });
}

export function saveCfg(patch) {
    patch = clone(patch || {});
    const expected = patch.expectedRevision; delete patch.expectedRevision;
    return commitCfg(next => {
        if (Object.keys(patch).some(k => /^relay|RelayId$/.test(k) || k === 'eyeRelayId' || k === 'coordRelayId')) throw Error('中转站请使用专用保存/选择操作');
        ['eye', 'coord'].forEach(prefix => {
            const urlKey = prefix + 'ApiUrl', keyKey = prefix + 'ApiKey';
            if (!(urlKey in patch) && !(keyKey in patch)) return;
            let p = next.relayProfiles.find(x => x.id === next[prefix + 'RelayId']);
            if (!p) {
                p = { id: newRelayId(), name: prefix === 'eye' ? '创意空投机中转' : '场外小叮当中转', url: '', key: '', model: '' };
                next.relayProfiles.push(p); next[prefix + 'RelayId'] = p.id;
            }
            if (urlKey in patch && String(patch[urlKey]).trim() !== p.url && p.key && !(keyKey in patch)) throw Error('更换地址时必须明确填写密钥（允许留空），不会把旧站密钥自动带到新站');
            if (urlKey in patch) p.url = String(patch[urlKey] || '').trim();
            if (keyKey in patch) p.key = String(patch[keyKey] || '').trim();
            if (p.url) relayBase(p.url);
        });
        Object.assign(next, patch);
        if ('poolDrawCategory' in patch && !('poolDrawCategories' in patch)) delete next.poolDrawCategories;
    }, expected);
}

export function saveRelay(kind, draft) {
    const prefix = relayKind(kind); draft = clone(draft || {});
    return commitCfg(next => {
        let p = draft.id ? next.relayProfiles.find(x => x.id === draft.id) : null;
        if (draft.id && !p) throw Error('中转站已被删除，请重新载入');
        const url = String(draft.url || '').trim(), name = String(draft.name || '').trim();
        relayBase(url); if (!name) throw Error('请填写中转站名称');
        if (p && p.url !== url && p.key && !Object.prototype.hasOwnProperty.call(draft, 'key')) throw Error('更换地址时必须明确填写密钥（允许留空）');
        const key = Object.prototype.hasOwnProperty.call(draft, 'key') ? String(draft.key || '').trim() : (p ? p.key : '');
        const model = String(draft.model || '').trim(); if (!model) throw Error('请选择或填写模型 ID');
        if (!p) {
            if (next.relayProfiles.length >= 30) throw Error('最多保存 30 个中转站');
            p = { id: newRelayId() }; next.relayProfiles.push(p);
        }
        Object.assign(p, { name, url, key, model });
        next[prefix + 'RelayId'] = p.id; next[prefix + 'Model'] = model;
        if (kind === 'coord') next.coordUseEye = false;
    }, draft.expectedRevision);
}

export function selectRelay(kind, id, model, expectedRevision) {
    const prefix = relayKind(kind);
    return commitCfg(next => {
        const p = next.relayProfiles.find(x => x.id === id); if (!p) throw Error('中转站不存在');
        next[prefix + 'RelayId'] = id; next[prefix + 'Model'] = model === undefined ? p.model : String(model).trim();
        if (kind === 'coord') next.coordUseEye = false;
    }, expectedRevision);
}

export function removeRelay(id, expectedRevision) {
    return commitCfg(next => {
        if (next.eyeRelayId === id || next.coordRelayId === id) throw Error('此中转仍被模块绑定，请先切换模块中转，再删除');
        if (!next.relayProfiles.some(p => p.id === id)) throw Error('中转站不存在');
        next.relayProfiles = next.relayProfiles.filter(p => p.id !== id);
    }, expectedRevision);
}

// 中转列表损坏会让 normalizeCfg 抛错，而每次写配置前都要先读 —— 不留这个出口就连修都保存不了
export function repairRelays(confirmed) {
    if (!confirmed) return Promise.resolve({ ok: false, reason: '这会清空全部中转站（地址、密钥、模型绑定），其他设置保留。再点一次确认。' });
    return cfgSerial(async () => {
        const raw = readRawCfg();
        const revision = Number.isSafeInteger(raw.relayRevision) && raw.relayRevision >= 0 ? raw.relayRevision : 0;
        raw.relaySchemaVersion = 1; raw.relayProfiles = []; raw.relayRevision = revision + 1;
        raw.eyeRelayId = ''; raw.coordRelayId = '';
        raw.eyeApiUrl = ''; raw.eyeApiKey = ''; raw.coordApiUrl = ''; raw.coordApiKey = '';
        const next = normalizeCfg(raw);
        configSaving++; hooks.cancelAll();
        try {
            writeRawCfg(next); config = next; configFault = '';
            return { ok: true, reason: '中转配置已重置，请重新填写地址和模型' };
        } finally { configSaving--; hooks.notify(); }
    });
}

export function getDefaultPrompts() { return { poolPrompt: POOL_PROMPT, coordPreset: COORD_PROMPT }; }
export function faultText() { return configFault; }
export function savingCount() { return configSaving; }

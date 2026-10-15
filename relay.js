import { ctx, cut } from './host.js';
import { t } from './text.js';

const BACKEND_GENERATE = '/api/backends/chat-completions/generate';
const BACKEND_STATUS = '/api/backends/chat-completions/status';

// 同一站点直连失败过就不再重试直连，避免每轮都白等一次跨域失败
const directBlocked = new Map();

export function relayBase(url) {
    let parsed;
    try { parsed = new URL(String(url || '').trim()); } catch (_) { throw Error('请填写有效的中转站 http(s) 地址'); }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw Error('中转站地址只允许 http(s)，请勿在地址中携带账号、密钥、查询参数或片段');
    }
    let p = parsed.pathname.replace(/\/+$/, '');
    p = p.replace(/\/(?:chat\/completions|models)$/i, '');
    parsed.pathname = p || '/v1';
    return parsed.toString().replace(/\/+$/, '');
}

export function endpoint(url) { return relayBase(url) + '/chat/completions'; }

function originOf(url) {
    try { return new URL(relayBase(url)).origin; } catch (_) { return String(url || ''); }
}

export function directAvailable(url) { return !directBlocked.get(originOf(url)); }

// 换了地址或密钥要重新试直连，否则一次跨域失败会永远钉在后端转发上
export function clearDirectCache(url) {
    if (url) directBlocked.delete(originOf(url));
    else directBlocked.clear();
}

function yamlHeader(name, value) {
    return name + ': "' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function providerFailure(status, text) {
    let message = '';
    try {
        const data = JSON.parse(text);
        message = String((data.error && data.error.message) || data.message || '');
    } catch (_) {}
    const key = /max[_ -]?(?:tokens|completion_tokens)|context.{0,30}(?:length|limit)|unsupported.{0,30}(?:parameter|temperature)|invalid.{0,20}parameter/i.test(message) ? 'parameters'
        : status === 401 || status === 403 ? 'auth'
            : status === 429 ? 'rate' : status === 404 ? 'route'
                : status >= 500 ? 'upstream' : status === 400 || status === 422 ? 'parameters' : 'error';
    return Error('HTTP ' + status + ' · ' + t('api.' + key));
}

function isNetworkError(e) {
    return !!e && e.name !== 'AbortError' && (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(e.message || '')));
}

function parseChoice(data, allowPartial) {
    const choice = data && data.choices && data.choices[0];
    const truncated = !!(choice && choice.finish_reason === 'length');
    if (truncated && !allowPartial) throw Error('百宝袋输出被截断，请调整模型或提示词');
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) content = content.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
    if (typeof content !== 'string' || !content.trim()) throw Error('百宝袋 API 未返回正文（不把 reasoning_content 当作正文）');
    return { content: allowPartial ? content : content.trim(), truncated };
}

async function readError(res) {
    try { return await res.text(); } catch (_) { return ''; }
}

async function callDirect(conn, payload, signal) {
    const headers = { 'Content-Type': 'application/json' };
    if (conn.key) headers.Authorization = 'Bearer ' + conn.key;
    const res = await fetch(endpoint(conn.url), { method: 'POST', redirect: 'error', headers, signal, body: JSON.stringify(payload) });
    if (!res.ok) throw providerFailure(res.status, await readError(res));
    return res.json();
}

async function callBackend(conn, payload, signal) {
    const c = ctx();
    const body = Object.assign({}, payload, {
        chat_completion_source: 'custom',
        custom_url: relayBase(conn.url),
    });
    if (conn.key) body.custom_include_headers = yamlHeader('Authorization', 'Bearer ' + conn.key);
    const res = await fetch(BACKEND_GENERATE, { method: 'POST', headers: c.getRequestHeaders(), signal, body: JSON.stringify(body) });
    if (!res.ok) throw providerFailure(res.status, await readError(res));
    return res.json();
}

export async function callModel(conn, prompt, body, options) {
    options = options || {};
    if (!conn || !conn.url || !conn.model) throw Error(options.missing || '中转站地址或模型未配置');
    const payload = {
        model: conn.model,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: body }],
        stream: false,
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.95,
        max_tokens: options.maxTokens || 1800,
    };
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (options.signal) {
        if (options.signal.aborted) ctrl.abort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    let timer;
    const limit = Math.max(1, Number(options.timeout || 45) * 1000);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { ctrl.abort(); reject(Error('百宝袋 API 超时，本轮保留有效旧指令或正常继续')); }, limit);
    });
    const work = (async () => {
        let via = 'direct';
        let data;
        if (directAvailable(conn.url)) {
            try { data = await callDirect(conn, payload, ctrl.signal); }
            catch (e) {
                if (!isNetworkError(e)) throw e;
                directBlocked.set(originOf(conn.url), true);
                via = 'backend';
            }
        } else via = 'backend';
        if (!data) data = await callBackend(conn, payload, ctrl.signal);
        return Object.assign(parseChoice(data, options.allowPartial), { via });
    })();
    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
}

function normalizeModels(data) {
    const items = Array.isArray(data) ? data : data && (Array.isArray(data.data) ? data.data : data.models);
    if (!Array.isArray(items)) throw Error('未识别模型列表格式，可手动填写模型 ID');
    const seen = new Set(), ids = [];
    items.slice(0, 5000).forEach(item => {
        let id = typeof item === 'string' ? item : item && (item.id || item.name);
        if (typeof id !== 'string') return;
        id = id.trim();
        if (!id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id) || seen.has(id)) return;
        seen.add(id); ids.push(id);
    });
    if (!ids.length) throw Error('中转站返回的模型列表为空，可手动填写模型 ID');
    ids.sort((a, b) => a.localeCompare(b));
    return ids;
}

export async function listModels(conn, signal) {
    if (!conn || !conn.url) throw Error('请先填写中转站地址；独立接口不会借用另一接口的密钥');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { ctrl.abort(); reject(Error('拉取模型列表超时，可重试或手动填写模型 ID')); }, 15000);
    });
    const work = (async () => {
        if (directAvailable(conn.url)) {
            try {
                const headers = { Accept: 'application/json' };
                if (conn.key) headers.Authorization = 'Bearer ' + conn.key;
                const res = await fetch(relayBase(conn.url) + '/models', { method: 'GET', headers, signal: ctrl.signal, redirect: 'error' });
                if (!res.ok) throw Error('模型列表 HTTP ' + res.status + '；请检查中转站权限或手动填写模型 ID');
                return { models: normalizeModels(await res.json()), via: 'direct' };
            } catch (e) {
                if (!isNetworkError(e)) throw e;
                directBlocked.set(originOf(conn.url), true);
            }
        }
        const c = ctx();
        const body = { chat_completion_source: 'custom', custom_url: relayBase(conn.url) };
        if (conn.key) body.custom_include_headers = yamlHeader('Authorization', 'Bearer ' + conn.key);
        const res = await fetch(BACKEND_STATUS, { method: 'POST', headers: c.getRequestHeaders(), signal: ctrl.signal, body: JSON.stringify(body) });
        if (!res.ok) throw Error('模型列表 HTTP ' + res.status + '；请检查中转站权限或手动填写模型 ID');
        let data;
        try { data = await res.json(); } catch (_) { throw Error('模型列表不是有效 JSON，可手动填写模型 ID'); }
        return { models: normalizeModels(data), via: 'backend' };
    })();
    try {
        return await Promise.race([work, timeout]);
    } catch (e) {
        if (e && e.name === 'AbortError') throw Error('模型列表请求已取消');
        throw Error(cut(e.message || e, 240));
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

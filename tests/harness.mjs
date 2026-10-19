import { JSDOM } from 'jsdom';

export const TYPES = {
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATION_STARTED: 'GENERATION_STARTED',
    GENERATION_ENDED: 'GENERATION_ENDED',
    GENERATION_STOPPED: 'GENERATION_STOPPED',
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    CHAT_COMPLETION_PROMPT_READY: 'CHAT_COMPLETION_PROMPT_READY',
    GENERATE_AFTER_DATA: 'GENERATE_AFTER_DATA',
    CHAT_COMPLETION_SETTINGS_READY: 'CHAT_COMPLETION_SETTINGS_READY',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_SWIPE_DELETED: 'MESSAGE_SWIPE_DELETED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    GROUP_WRAPPER_STARTED: 'GROUP_WRAPPER_STARTED',
    GROUP_WRAPPER_FINISHED: 'GROUP_WRAPPER_FINISHED',
    CHAT_CHANGED: 'CHAT_CHANGED',
};

// 复现酒馆 eventemitter.js:144 的语义：emit 逐个 await，严格串行
export class Emitter {
    constructor() { this.map = new Map(); }
    on(event, fn) {
        if (!this.map.has(event)) this.map.set(event, []);
        this.map.get(event).push(fn);
    }
    makeFirst(event, fn) {
        const list = (this.map.get(event) || []).filter(listener => listener !== fn);
        list.unshift(fn);
        this.map.set(event, list);
    }
    removeListener(event, fn) {
        this.map.set(event, (this.map.get(event) || []).filter(listener => listener !== fn));
    }
    async emit(event, ...args) {
        for (const fn of (this.map.get(event) || []).slice()) {
            try { await fn(...args); } catch (e) { this.lastError = e; }
        }
    }
}

export function userMsg(text) { return { name: 'User', is_user: true, is_system: false, mes: text, send_date: Date.now() }; }
export function botMsg(text, name) { return { name: name || 'Char', is_user: false, is_system: false, mes: text, send_date: Date.now() }; }
export function hiddenMsg(text) { return { name: 'Char', is_user: false, is_system: true, mes: text, send_date: Date.now() }; }

export const BOTH_ENTRIES = [
    { name: '创意空投机 · 系统变量', content: '{{getvar::director_chime_context}}' },
    { name: '场外小叮当 · 系统变量', content: '{{getvar::director_coord_context}}' },
];

// 仿酒馆 oai_settings：条目定义在 prompts，启用状态在全局排序表 character_id=100001
export function presetWith(entries) {
    const prompts = [{ identifier: 'main', name: 'Main Prompt', role: 'system', content: '主提示', system_prompt: true }];
    const order = [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }];
    entries.forEach((e, i) => {
        const id = 'bbd-' + i;
        prompts.push({ identifier: id, name: e.name || id, role: e.role || 'system', content: e.content, injection_position: e.absolute ? 1 : 0, injection_depth: 4,
            injection_trigger: e.triggers || [] });
        order.push({ identifier: id, enabled: e.enabled !== false });
    });
    return { preset_settings_openai: '如梦织境', prompts, prompt_order: [{ character_id: 100000, order: [] }, { character_id: 100001, order }] };
}

export function setupDom(html) {
    const dom = new JSDOM(html || '<!DOCTYPE html><html><body><div id="extensions_settings"></div><div id="extensions_settings2"></div><form id="send_form"></form></body></html>', {
        url: 'http://localhost:8000/scripts/extensions/third-party/baobaodai-st/',
        pretendToBeVisual: true,
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.Event = dom.window.Event;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    globalThis.innerWidth = 1200;
    globalThis.innerHeight = 900;
    globalThis.jQuery = fn => { if (typeof fn === 'function') globalThis.__bbdReady = fn(); };
    globalThis.toastr = { success() {}, error() {}, warning() {}, info() {} };
    return dom;
}

export function createContext(init) {
    init = init || {};
    // 事件总线与注入表必须跨 boot 复用：被测代码是 ES module 单例，监听只注册一次
    const emitter = init.emitter || new Emitter();
    const stats = { settings: 0, metadata: 0 };
    const injections = init.injections || {};
    Object.keys(injections).forEach(k => { delete injections[k]; });
    const ctx = {
        chat: init.chat || [],
        characters: init.characters || [{ name: '方亦楷', description: '冷淡的建筑师', personality: '嘴硬', scenario: '雨夜的事务所', first_mes: '他抬头看了你一眼。', avatar: 'f.png' }],
        characterId: init.characterId === undefined ? 0 : init.characterId,
        groupId: init.groupId || null,
        groups: init.groups || [],
        chatId: init.chatId === undefined ? 'chat-1' : init.chatId,
        chatMetadata: init.chatMetadata || {},
        extensionSettings: init.extensionSettings || {},
        name1: init.name1 || '我',
        user_avatar: 'user.png',
        powerUserSettings: { persona_description: init.persona === undefined ? '二十六岁，记者' : init.persona },
        eventSource: emitter,
        eventTypes: TYPES,
        streamingProcessor: null,
        extensionPrompts: injections,
        mainApi: init.mainApi || 'openai',
        chatCompletionSettings: init.preset || presetWith(BOTH_ENTRIES),
        getCurrentChatId: () => ctx.chatId,
        saveSettingsDebounced: () => { stats.settings++; },
        saveMetadataDebounced: () => { stats.metadata++; },
        saveMetadata: async () => { stats.metadata++; },
        setExtensionPrompt: (key, value, position, depth, scan, role) => {
            injections[key] = { value: String(value), position, depth, scan, role };
        },
        substituteParams: s => String(s).replace(/\{\{user\}\}/g, ctx.name1)
            .replace(/\{\{getvar::([^}]+)\}\}/g, (_, key) => String((ctx.chatMetadata.variables || {})[key] || '')),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' }),
        unshallowCharacter: async () => {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    return { ctx, emitter, stats, injections };
}

// 对齐 ST：AFTER_COMMANDS -> 用户入库 -> manifest 拦截器 -> 预设展开 ->
// PROMPT_READY -> GENERATE_AFTER_DATA -> CHAT_COMPLETION_SETTINGS_READY。
// 测试可把这些步骤拆开，检查事件之间发生的状态变化。
export async function interceptGeneration(env, type = 'normal') {
    await globalThis.baobaodaiGenerationInterceptor(env.ctx.chat, 8000, () => {}, type);
}

export async function emitPromptReady(env, type = 'normal', prompt, options = {}) {
    if (!prompt) {
        const settings = env.ctx.chatCompletionSettings;
        const order = (settings.prompt_order.find(entry => String(entry.character_id) === '100001') || {}).order || [];
        prompt = order.filter(entry => entry.enabled).map(entry => settings.prompts.find(p => p.identifier === entry.identifier))
            .filter(p => p && (!p.injection_trigger || !p.injection_trigger.length || p.injection_trigger.includes(type)))
            .map(p => ({ role: p.role, content: env.ctx.substituteParams(p.content) }));
    }
    const data = { chat: prompt, dryRun: false };
    await env.emitter.emit(TYPES.CHAT_COMPLETION_PROMPT_READY, data);
    const generationData = { prompt: data.chat };
    // generateRaw 也发PROMPT_READY，但不经过Generate的GENERATE_AFTER_DATA。
    if (!options.raw) await env.emitter.emit(TYPES.GENERATE_AFTER_DATA, generationData, false);
    // createGenerationParameters 先filter成新数组，再把type和messages交给SETTINGS_READY。
    const request = { type: options.raw ? 'quiet' : type, messages: generationData.prompt.filter(message => message && typeof message === 'object'), stream: false };
    await env.emitter.emit(TYPES.CHAT_COMPLETION_SETTINGS_READY, request);
    return request.messages;
}

export async function beginGeneration(env, type = 'normal', options = {}) {
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, type, {}, !!options.dryRun);
    if (options.dryRun) return;
    if (options.userText !== undefined) {
        env.ctx.chat.push(userMsg(options.userText));
        await env.emitter.emit(TYPES.MESSAGE_SENT, env.ctx.chat.length - 1);
    }
    await interceptGeneration(env, type);
    return emitPromptReady(env, type, options.prompt);
}

// 可编程的 fetch：直连可设为 CORS 失败，后端通道单独计数
export function installFetch(plan) {
    const calls = [];
    plan = plan || {};
    globalThis.fetch = async (url, options) => {
        const u = String(url);
        const body = options && options.body ? JSON.parse(options.body) : null;
        calls.push({ url: u, body, headers: (options && options.headers) || {} });
        const backend = u.indexOf('/api/backends/') === 0;
        if (!backend && plan.corsBlocked) throw new TypeError('Failed to fetch');
        if (/\/models$/.test(u) || u.indexOf('/status') >= 0) {
            const models = plan.models || ['deepseek-chat', 'glm-5.3-200k'];
            return jsonResponse({ data: models.map(id => ({ id })) });
        }
        if (plan.httpStatus) return jsonResponse(plan.httpBody || { error: { message: 'bad' } }, plan.httpStatus);
        const reply = typeof plan.reply === 'function' ? plan.reply(body, { backend }) : plan.reply;
        const message = {};
        if (!plan.contentEmpty) message.content = reply === undefined ? '剧情|寄错的信，称呼却很熟悉' : reply;
        if (plan.reasoning !== undefined) message.reasoning_content = plan.reasoning;
        return jsonResponse({ choices: [{ message, finish_reason: plan.finishReason || 'stop' }] });
    };
    globalThis.fetch.calls = calls;
    return calls;
}

function jsonResponse(data, status) {
    return {
        ok: !status || (status >= 200 && status < 300),
        status: status || 200,
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

export function slipReply(lines) { return lines.join('\n'); }

export function makeRunner() {
    const results = [];
    let group = '';
    const api = {
        group(name) { group = name; },
        check(name, pass, detail) {
            results.push({ group, name, pass: !!pass, detail: pass ? '' : (detail === undefined ? '' : String(detail)) });
        },
        eq(name, actual, expected) {
            const pass = JSON.stringify(actual) === JSON.stringify(expected);
            api.check(name, pass, pass ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
        },
        ok(name, value, detail) { api.check(name, !!value, detail); },
        async throws(name, fn, pattern) {
            try { await fn(); api.check(name, false, '没有抛错'); }
            catch (e) {
                const text = String(e && e.message || e);
                api.check(name, pattern ? pattern.test(text) : true, pattern ? `错误文本不匹配：${text}` : '');
            }
        },
        report(title) {
            const failed = results.filter(r => !r.pass);
            const byGroup = new Map();
            results.forEach(r => {
                if (!byGroup.has(r.group)) byGroup.set(r.group, { pass: 0, fail: 0 });
                byGroup.get(r.group)[r.pass ? 'pass' : 'fail']++;
            });
            console.log('\n' + title);
            for (const [name, s] of byGroup) {
                console.log(`  ${s.fail ? '✗' : '✓'} ${name}  ${s.pass}/${s.pass + s.fail}`);
            }
            if (failed.length) {
                console.log('\n失败明细：');
                failed.forEach(r => console.log(`  ✗ [${r.group}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
            }
            console.log(`\n合计 ${results.length - failed.length}/${results.length} 通过`);
            return failed.length;
        },
    };
    return api;
}

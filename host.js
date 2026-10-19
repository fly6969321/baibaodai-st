const NS = 'baobaodai';
const PRESET_ORDER_ID = '100001';

export function ctx() {
    const st = globalThis.SillyTavern;
    if (!st || typeof st.getContext !== 'function') throw Error('酒馆上下文不可用，请确认版本');
    return st.getContext();
}

export function hasCtx() {
    try { ctx(); return true; } catch (_) { return false; }
}

export function cut(x, n) { return String(x == null ? '' : x).slice(0, n); }

export function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
}

export function safeText(x, n) {
    return cut(x, n).replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝')
        .replace(/<\/?(?:system|assistant|user|developer|director)[^>]*>/gi, '').trim();
}

export function clone(x) { return JSON.parse(JSON.stringify(x)); }

// 全局配置：extension_settings 整体进 settings.json
export function readRawCfg() {
    const c = ctx();
    if (!c.extensionSettings[NS] || typeof c.extensionSettings[NS] !== 'object') c.extensionSettings[NS] = {};
    return clone(c.extensionSettings[NS]);
}

export function writeRawCfg(next) {
    const c = ctx();
    c.extensionSettings[NS] = clone(next);
    c.saveSettingsDebounced();
}

// chatMetadata 在切聊天时被整体替换，不能缓存引用，每次重取
export function readRawState() {
    const c = ctx();
    const meta = c.chatMetadata;
    if (!meta) return {};
    const raw = meta[NS];
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (_) { return {}; } }
    return raw && typeof raw === 'object' ? clone(raw) : {};
}

export function writeRawState(next) {
    const c = ctx();
    if (!c.chatMetadata) throw Error('当前没有打开的聊天');
    c.chatMetadata[NS] = clone(next);
    c.saveMetadataDebounced();
}

export function chatKey() {
    const c = ctx();
    const id = c.getCurrentChatId ? c.getCurrentChatId() : c.chatId;
    if (id == null || id === '') return null;
    if (c.groupId) return 'g:' + c.groupId + ':' + id;
    return 'c:' + id;
}

// 只供把本聊天已有的旧群聊卡池迁移到包含聊天文件名的新身份。
export function legacyChatKey() {
    const c = ctx();
    return c.groupId ? 'g:' + c.groupId : chatKey();
}

export function chatInfo() {
    const c = ctx();
    const key = chatKey();
    return { id: key, isGroup: !!c.groupId, characterId: c.characterId, groupId: c.groupId, messageCount: (c.chat || []).length };
}

export function messageText(m) {
    return String(m && m.mes || '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

// DrawGen appends "\n\n" + tag and records the exact tag when it has no
// enclosing element. sdg_env stores only an arbitrary element name, so it
// cannot prove that a matching story container is disposable image metadata.
function stripRecordedDrawgenTail(text, message) {
    const extra = message && message.extra;
    const tag = extra && typeof extra.sdg_tag === 'string' ? extra.sdg_tag : '';
    if (!tag.trim()) return text;
    const tail = text.trimEnd();
    if (!tail.endsWith(tag)) return text;
    const prefix = tail.slice(0, tail.length - tag.length);
    if (prefix && !/\r?\n\r?\n$/.test(prefix)) return text;
    return prefix;
}

// Use this same normalization for the live opening and a saved opening
// snapshot. Only complete, known image markers are removed; an unfinished
// marker must not swallow story text up to a later marker's closing token.
export function normalizeOpeningNarrative(text, message) {
    return stripRecordedDrawgenTail(String(text == null ? '' : text), message)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/image###(?:(?!image###)[\s\S])*?###/gi, '')
        .replace(/<draw>(?:(?!<draw>)[\s\S])*?<\/draw>/gi, '')
        .replace(/!\[(?:[^\]\\]|\\.)*\]\((?:[^()\\]|\\.|\([^()]*\))*\)/g, '')
        .replace(/<img\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi, '')
        .trim();
}

export function narrativeText(m) {
    return normalizeOpeningNarrative(m && m.mes || '', m);
}

// 保存值快照：酒馆流式回复会原地改写同一个 message 对象。
export function replyBaseline() {
    return messages().map(m => ({ raw: m.raw, narrative: m.narrative, swipeId: m.swipeId }));
}

export function hasNewReply(index, baseline, type) {
    const m = messages().find(item => item.index === Number(index));
    if (!m || m.role !== 'assistant' || !m.narrative || m.narrative === '...') return false;
    const before = baseline && baseline[m.index];
    if (!before) return true;
    if (['swipe', 'regenerate', 'continue'].indexOf(type) < 0 || m.index !== baseline.length - 1) return false;
    return m.raw !== before.raw || m.narrative !== before.narrative || m.swipeId !== before.swipeId;
}

// getContext 暴露的是当前 StreamingProcessor；必须在 ENDED 回调入口读取，
// 主流程随后会把它置空。正常完成和用户停止均 isFinished，网络错误另设 isStopped。
export function streamStatus() {
    const p = ctx().streamingProcessor;
    if (!p) return null;
    return {
        processor: p,
        type: p.type || 'normal', messageId: p.messageId,
        finished: p.isFinished === true, failed: p.isStopped === true,
        aborted: !!(p.abortController && p.abortController.signal.aborted),
    };
}

export function promptContainsText(prompt, text) {
    if (!text || !Array.isArray(prompt)) return false;
    return prompt.some(message => {
        if (!message || message.role !== 'system') return false;
        const content = Array.isArray(message.content)
            ? message.content.filter(part => part && part.type === 'text').map(part => part.text || '').join('\n')
            : String(message.content || '');
        return content.indexOf(text) >= 0;
    });
}

// is_system 同时表示「系统条」和「/hide 隐藏楼」。真正系统消息由
// getSystemMessageByType 写入 extra.type；工具结果另有 tool_invocations。
// 隐藏只影响取上下文，不抹去用户/助手身份和已经发生的回合。
export function messages() {
    const c = ctx();
    return (c.chat || []).map((m, index) => ({
        index,
        role: m.is_user ? 'user' : (m.extra && (m.extra.type || Array.isArray(m.extra.tool_invocations)) ? 'system' : 'assistant'),
        hidden: !!m.is_system,
        name: String(m && m.name || ''),
        text: messageText(m),
        narrative: narrativeText(m),
        swipeId: typeof m.swipe_id === 'number' ? m.swipe_id : 0,
        raw: m,
    }));
}

export function assistantRound(ms) {
    return ms.filter(m => m.role === 'assistant').length;
}

export function liveMessages(ms) {
    return ms.filter(m => !m.hidden && (m.role === 'user' || m.role === 'assistant') && m.text);
}

// 消息没有稳定 id，只有数组下标；锚点用「最后一条用户楼的下标+正文指纹」
export function anchorOf(ms) {
    const user = ms.filter(m => m.role === 'user' && !m.hidden).pop();
    return user ? user.index + ':' + hash(user.text) : '';
}

export function groundingSignature(m) {
    return JSON.stringify([m.role, m.name, m.narrative]);
}

// {{getvar::}} 读的就是 chat_metadata.variables
export function getChatVar(name) {
    const c = ctx();
    const vars = c.chatMetadata && c.chatMetadata.variables;
    const v = vars ? vars[name] : undefined;
    return v == null ? '' : String(v);
}

export function setChatVar(name, value) {
    const c = ctx();
    if (!c.chatMetadata) throw Error('当前没有打开的聊天');
    if (!c.chatMetadata.variables || typeof c.chatMetadata.variables !== 'object') c.chatMetadata.variables = {};
    c.chatMetadata.variables[name] = String(value || '');
    c.saveMetadataDebounced();
}

// 当前对话补全预设里的条目，启用状态取全局排序表；非对话补全模式返回 null
export function presetEntries() {
    const c = ctx();
    if (c.mainApi !== 'openai') return null;
    const s = c.chatCompletionSettings || {};
    const prompts = Array.isArray(s.prompts) ? s.prompts : [];
    const list = (Array.isArray(s.prompt_order) ? s.prompt_order : []).find(x => x && String(x.character_id) === PRESET_ORDER_ID);
    const order = list && Array.isArray(list.order) ? list.order : [];
    return order.map(entry => {
        const p = prompts.find(x => x && x.identifier === entry.identifier);
        if (!p) return null;
        return { name: String(p.name || ''), role: p.role || 'system', content: String(p.content || ''), enabled: !!entry.enabled,
            triggers: Array.isArray(p.injection_trigger) ? p.injection_trigger.slice() : [] };
    }).filter(Boolean);
}

export function presetName() {
    const s = ctx().chatCompletionSettings || {};
    return String(s.preset_settings_openai || '');
}

export function substitute(text) {
    try { return ctx().substituteParams(String(text || '')); } catch (_) { return String(text || ''); }
}

async function characterAt(chid) {
    const c = ctx();
    const list = c.characters || [];
    if (chid == null || !list[chid]) return null;
    if (list[chid].shallow && c.unshallowCharacter) { try { await c.unshallowCharacter(chid); } catch (_) {} }
    return c.characters[chid] || list[chid];
}

function groupMemberIds() {
    const c = ctx();
    if (!c.groupId) return [];
    const group = (c.groups || []).find(g => String(g.id) === String(c.groupId));
    if (!group) return [];
    const disabled = new Set((group.disabled_members || []).map(String));
    return (group.members || [])
        .filter(avatar => !disabled.has(String(avatar)))
        .map(avatar => (c.characters || []).findIndex(x => x && x.avatar === avatar))
        .filter(i => i >= 0);
}

export function activeCharacterIds() {
    const c = ctx();
    if (c.groupId) return groupMemberIds();
    return c.characterId == null ? [] : [c.characterId];
}

// raw=true 时不展开宏：建池指纹要在同一聊天里稳定，不能随 persona 变动
export async function characterSections(limit, opts) {
    opts = opts || {};
    const out = [];
    for (const chid of activeCharacterIds().slice(0, limit)) {
        const ch = await characterAt(chid);
        if (!ch) continue;
        const fields = [ch.name, ch.description, ch.personality, ch.scenario];
        if (opts.withOpening) fields.push(ch.first_mes);
        const text = fields.filter(Boolean).map(x => opts.raw ? String(x) : substitute(x)).join('\n');
        if (text.trim()) out.push({ id: chid, text });
    }
    return out;
}

export function scenarioOverride(raw) {
    const c = ctx();
    const text = c.chatMetadata && c.chatMetadata.scenario;
    if (!text) return '';
    return raw ? String(text) : substitute(text);
}

export function personaSection(raw) {
    const c = ctx();
    const name = c.name1 || '';
    const pu = c.powerUserSettings || {};
    const description = pu.persona_description || '';
    const text = [name, description].filter(Boolean).map(x => raw ? String(x) : substitute(x)).join('\n');
    return text.trim();
}

export function personaId() {
    const c = ctx();
    return c.user_avatar || (c.powerUserSettings && c.powerUserSettings.default_persona) || c.name1 || '';
}

let loreLoader = null;
async function loadLoreApi() {
    if (loreLoader) return loreLoader;
    loreLoader = (async () => {
        try { const mod = await import('../../../world-info.js'); return mod.getSortedEntries || null; }
        catch (_) { return null; }
    })();
    return loreLoader;
}

export async function loreEntries() {
    const getSortedEntries = await loadLoreApi();
    if (!getSortedEntries) return [];
    try {
        const entries = await getSortedEntries();
        return Array.isArray(entries) ? entries : [];
    } catch (_) { return []; }
}

let dragLoader = null;
export async function dragApi() {
    if (dragLoader) return dragLoader;
    dragLoader = (async () => {
        try { const mod = await import('../../../RossAscends-mods.js'); return mod.dragElement || null; }
        catch (_) { return null; }
    })();
    return dragLoader;
}

export function toast(kind, text) {
    try {
        const fn = globalThis.toastr && globalThis.toastr[kind];
        if (fn) fn(cut(text, 300));
    } catch (_) {}
}

export function events() {
    const c = ctx();
    return { source: c.eventSource, types: c.eventTypes || c.event_types };
}

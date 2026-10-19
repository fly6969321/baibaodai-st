import * as H from './host.js';
import { prepare, finish, onChatChanged, onChatClosed, invalidateGrounding, reboot, app, VERSION } from './engine.js';
import { mountPanel } from './panel.js';
import { CHIME_VAR, setDiagnostic } from './state.js';

const SKIP_TYPES = ['impersonate', 'quiet'];
const REROLL_TYPES = ['regenerate', 'swipe'];

let active = null;
let groupTurn = null;
const grounding = new Map();

function newGenerationId() {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function remember(replace) {
    H.messages().forEach(m => {
        if (replace || !grounding.has(m.index)) grounding.set(m.index, H.groundingSignature(m));
    });
}

function changedAt(index) {
    const ms = H.messages();
    const m = ms.find(x => x.index === index);
    if (!m) return true;
    const previous = grounding.get(index);
    grounding.set(index, H.groundingSignature(m));
    return previous === undefined || previous !== H.groundingSignature(m);
}

async function onBeforeGeneration(type, _params, dryRun) {
    // 预设编辑器点 token 预览也会走生成流程；不挡住就是每次预览白烧一次付费接口
    if (dryRun) return;
    if (SKIP_TYPES.indexOf(type) >= 0) return;
    if (active && active.ended) {
        const previous = active;
        active = null;
        await finish({ chatId: previous.chatId, generationId: previous.generationId,
            ok: false, verifiedInjection: false, reason: 'no-reply' });
    }
    const chatId = H.chatKey();
    if (!chatId) return;
    if (groupTurn) groupTurn.seen++;
    const event = {
        chatId,
        generationId: newGenerationId(),
        type: type || 'normal',
        reroll: REROLL_TYPES.indexOf(type) >= 0,
        continuation: type === 'continue',
        groupFollowup: !!(groupTurn && groupTurn.seen > 1),
    };
    active = { event, chatId, generationId: event.generationId, gotReply: false, ready: false, generationData: null, request: null };
}

// AFTER_COMMANDS 发生在用户消息入库之前。官方拦截器位于入库之后、
// 世界书扫描和预设宏展开之前；dryRun 不会调用它。
export async function generationInterceptor(_chat, _contextSize, _abort, type) {
    if (SKIP_TYPES.indexOf(type) >= 0) return;
    const current = active;
    if (!current || current.chatId !== H.chatKey()) return;
    if (current.preparing) return current.preparing;
    const previousStream = H.streamStatus();
    current.previousStream = previousStream && previousStream.processor;
    current.preparing = (async () => {
        try { await prepare(current.event); } catch (_) {}
        if (active !== current || current.chatId !== H.chatKey()) return;
        current.baseline = H.replyBaseline();
        current.injectionText = H.getChatVar(CHIME_VAR);
        current.ready = true;
        remember(true);
    })();
    return current.preparing;
}

function matchesType(current, type) {
    type = type || 'normal';
    return type === current.event.type
        || (current.event.type === 'regenerate' && type === 'normal')
        || (current.event.type === 'continue' && ['append', 'appendFinal'].indexOf(type) >= 0);
}

function onGenerationData(data, dryRun) {
    if (!active || !active.ready || active.request || dryRun || active.chatId !== H.chatKey()) return;
    if (data && Array.isArray(data.prompt)) active.generationData = data;
}

function onRequestReady(data) {
    const current = active;
    if (!current || !current.ready || !current.generationData || current.request || current.chatId !== H.chatKey()) return;
    if (!data || !Array.isArray(data.messages) || SKIP_TYPES.indexOf(data.type) >= 0 || !matchesType(current, data.type)) return;
    // PROMPT_READY 不带类型，Vector Storage 的 generateRaw 摘要也会触发它。
    // ST 1.19 最终请求在 SETTINGS_READY 明确给出 type/messages；raw 固定为quiet。
    // 绑定首个匹配的主请求对象，后续辅助请求不能覆盖，后续监听器对messages
    // 的替换则仍反映在该对象上，结算时核验的就是实际发出的payload。
    current.request = data;
}

function onReply(index, type) {
    const current = active;
    if (!current || !current.ready || current.chatId !== H.chatKey() || !matchesType(current, type)) return;
    const stream = H.streamStatus();
    if (stream && matchesType(current, stream.type) && stream.messageId === Number(index)
        && stream.processor !== current.previousStream) current.streamEvidence = stream;
    if (H.hasNewReply(index, current.baseline, current.event.type)) {
        current.gotReply = true;
        current.replyIndex = Number(index);
        if (current.ended) return completeGeneration(false);
    }
}

async function completeGeneration(stopped) {
    const current = active;
    if (!current) return;
    if (current.chatId !== H.chatKey()) { active = null; return; }
    // 流式 finalize 先 ENDED，后 MESSAGE_RECEIVED，不能靠事件先后猜成功。
    // 此时 processor 仍在上下文中，正文已更新；onErrorStreaming 会设置 isStopped。
    const stream = H.streamStatus() || current.streamEvidence;
    const ownStream = stream && matchesType(current, stream.type);
    // 切聊天后旧流可能还在结束；新拦截器之前已经存在的流不属于本轮。
    if (ownStream && (stream.processor === current.previousStream || (!stream.finished && !stream.failed))) {
        current.ended = true;
        return;
    }
    const hasReply = current.ready && (ownStream
        ? stream.finished && !stream.failed && H.hasNewReply(stream.messageId, current.baseline, current.event.type)
        : current.gotReply && H.hasNewReply(current.replyIndex, current.baseline, current.event.type));
    const partial = !!(hasReply && ownStream && stream.aborted);
    // 无请求 ID 的 ENDED 也可能来自别的聊天/后台生成。没有流或正文证据时
    // 保留会话，等迟到正文或下一次生成再收尾，不能提前抹掉当前回复的归属。
    if (!ownStream && !hasReply && !stopped) { current.ended = true; return; }
    const verifiedInjection = H.promptContainsText(current.request && current.request.messages, current.injectionText);
    const ok = !!hasReply && verifiedInjection;
    const reason = ownStream && stream.failed ? 'generation-error'
        : !hasReply ? (stopped || (ownStream && stream.aborted) ? 'stopped' : 'no-reply')
        : !verifiedInjection ? 'not-injected' : '';
    active = null;
    if (hasReply && current.injectionText && !verifiedInjection) {
        setDiagnostic('本轮最终请求没有包含创意空投变量内容；请检查预设条目的启用状态、触发类型和上下文预算。待投纸条已保留。');
    }
    await finish({ chatId: current.chatId, generationId: current.generationId, ok, verifiedInjection, partial, reason });
    if (current.chatId === H.chatKey()) remember(true);
}

function onGenerationEnded() { return completeGeneration(false); }
function onGenerationStopped() { return completeGeneration(true); }

async function onEdited(index) {
    if (active && !active.ended) return;
    if (!changedAt(Number(index))) return;
    try { await invalidateGrounding(); } catch (_) {}
}

async function onDeleted() {
    // 重生成会先删掉最后一楼再生成，生成中的删楼不能当成她手动删
    if (active && !active.ended) return;
    grounding.clear();
    try { await invalidateGrounding(); } catch (_) {}
    remember(true);
}

function register() {
    const { source, types } = H.events();
    if (!source || !types) throw Error('酒馆事件系统不可用');
    // 必须用 on：once 不返回 listener 的 Promise，拿不到阻塞主流程的等待
    source.on(types.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
    source.on(types.GENERATE_AFTER_DATA, onGenerationData);
    source.on(types.CHAT_COMPLETION_SETTINGS_READY, onRequestReady);
    source.on(types.MESSAGE_RECEIVED, onReply);
    source.on(types.GENERATION_ENDED, onGenerationEnded);
    source.on(types.GENERATION_STOPPED, onGenerationStopped);
    // ENDED 的 emit 不被主流程 await；优先同步读取证据，避免前面的异步
    // 扩展监听器等待期间，酒馆已经清空 streamingProcessor。
    if (typeof source.makeFirst === 'function') {
        source.makeFirst(types.GENERATION_ENDED, onGenerationEnded);
        source.makeFirst(types.GENERATION_STOPPED, onGenerationStopped);
        source.makeFirst(types.MESSAGE_RECEIVED, onReply);
    }
    source.on(types.MESSAGE_EDITED, onEdited);
    source.on(types.MESSAGE_UPDATED, onEdited);
    source.on(types.MESSAGE_DELETED, onDeleted);
    source.on(types.MESSAGE_SWIPE_DELETED, onDeleted);
    if (types.GROUP_WRAPPER_STARTED) source.on(types.GROUP_WRAPPER_STARTED, () => { groupTurn = { seen: 0 }; });
    if (types.GROUP_WRAPPER_FINISHED) source.on(types.GROUP_WRAPPER_FINISHED, () => { groupTurn = null; });
    source.on(types.CHAT_CHANGED, () => {
        active = null; groupTurn = null; grounding.clear();
        if (H.chatKey()) { onChatChanged(); remember(true); } else onChatClosed();
    });
}

async function start() {
    if (!H.hasCtx()) { setTimeout(start, 400); return; }
    window.__baobaodaiApp = app;
    globalThis.baobaodaiGenerationInterceptor = generationInterceptor;
    try { register(); } catch (e) { H.toast('error', '百宝袋接入酒馆事件失败：' + (e.message || e)); return; }
    try { await mountPanel(); } catch (e) { H.toast('error', '百宝袋面板未能挂载：' + (e.message || e)); }
    remember(true);
    reboot();
}

jQuery(() => { start(); });

export { VERSION };

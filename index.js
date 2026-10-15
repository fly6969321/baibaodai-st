import * as H from './host.js';
import { prepare, finish, onChatChanged, onChatClosed, invalidateGrounding, reboot, app, VERSION } from './engine.js';
import { mountPanel } from './panel.js';

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
    active = { chatId, generationId: event.generationId, gotReply: false };
    try { await prepare(event); } catch (_) {}
    remember(true);
}

function onReply() {
    if (active) active.gotReply = true;
}

async function onGenerationEnded() {
    const current = active;
    active = null;
    if (!current) return;
    // 酒馆没有「仅成功」事件：收到过回复就算成功，否则按失败处理，预留的纸条留给重试
    await finish({ chatId: current.chatId, generationId: current.generationId, ok: current.gotReply, reason: current.gotReply ? '' : 'no-reply' });
    remember(true);
}

async function onEdited(index) {
    if (active) return;
    if (!changedAt(Number(index))) return;
    try { await invalidateGrounding(); } catch (_) {}
}

async function onDeleted() {
    // 重生成会先删掉最后一楼再生成，生成中的删楼不能当成她手动删
    if (active) return;
    grounding.clear();
    try { await invalidateGrounding(); } catch (_) {}
    remember(true);
}

function register() {
    const { source, types } = H.events();
    if (!source || !types) throw Error('酒馆事件系统不可用');
    // 必须用 on：once 不返回 listener 的 Promise，拿不到阻塞主流程的等待
    source.on(types.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
    source.on(types.MESSAGE_RECEIVED, onReply);
    source.on(types.GENERATION_ENDED, onGenerationEnded);
    source.on(types.MESSAGE_EDITED, onEdited);
    source.on(types.MESSAGE_UPDATED, onEdited);
    source.on(types.MESSAGE_DELETED, onDeleted);
    source.on(types.MESSAGE_SWIPE_DELETED, onDeleted);
    if (types.GROUP_WRAPPER_STARTED) source.on(types.GROUP_WRAPPER_STARTED, () => { groupTurn = { seen: 0 }; });
    if (types.GROUP_WRAPPER_FINISHED) source.on(types.GROUP_WRAPPER_FINISHED, () => { groupTurn = null; });
    source.on(types.CHAT_CHANGED, chatId => {
        active = null; groupTurn = null; grounding.clear();
        if (chatId) { onChatChanged(); remember(true); } else onChatClosed();
    });
}

async function start() {
    if (!H.hasCtx()) { setTimeout(start, 400); return; }
    window.__baobaodaiApp = app;
    try { register(); } catch (e) { H.toast('error', '百宝袋接入酒馆事件失败：' + (e.message || e)); return; }
    try { await mountPanel(); } catch (e) { H.toast('error', '百宝袋面板未能挂载：' + (e.message || e)); }
    remember(true);
    reboot();
}

jQuery(() => { start(); });

export { VERSION };

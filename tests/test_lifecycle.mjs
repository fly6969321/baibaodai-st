import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    setupDom, createContext, installFetch, makeRunner, userMsg, botMsg, hiddenMsg,
    TYPES, Emitter, beginGeneration, interceptGeneration, emitPromptReady,
} from './harness.mjs';

const EXT = process.argv[2];
if (!EXT) throw Error('用法: node test_lifecycle.mjs <扩展目录绝对路径>');
const mod = name => import(pathToFileURL(path.join(EXT, name)).href);
const PANEL_HTML = fs.readFileSync(path.join(EXT, 'panel.html'), 'utf8');
const BUS = new Emitter();
const T = makeRunner();
let sequence = 0;
let endObserver = null;
// 在扩展注册之前已有别的异步监听器，模拟真实扩展装载顺序。
BUS.on(TYPES.GENERATION_ENDED, () => endObserver && endObserver());

async function boot(options = {}) {
    const dom = setupDom();
    const env = createContext({
        emitter: BUS, chatId: 'lifecycle-' + (++sequence),
        chat: options.chat || [botMsg('他抬头看了你一眼。'), userMsg('旧一轮的问题'), botMsg('旧一轮的回答')],
        groupId: options.groupId,
        groups: options.groupId ? [{ id: options.groupId, members: ['f.png'] }] : [],
    });
    env.ctx.extensionSettings.baobaodai = Object.assign({
        eyeApiUrl: 'https://relay.test/v1', eyeApiKey: 'test-key', eyeModel: 'test-model',
        coordEnabled: false, chimeN: 1, chimeInjectCount: 2,
        poolUseContext: false, poolAutoInit: false, chimeMode: 'pool', poolModeVersion: 1,
        poolPlotOn: true, poolEmotionOn: false, poolNsfwOn: false, poolTotalCount: 4,
    }, options.cfg);
    const calls = installFetch(options.plan || {});
    const mockFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => String(url).includes('panel.html')
        ? { ok: true, text: async () => PANEL_HTML }
        : mockFetch(url, opts);
    globalThis.fetch.calls = calls;
    const [host, cfg, state, pool, engine, context] = await Promise.all([
        mod('host.js'), mod('config.js'), mod('state.js'), mod('pool.js'), mod('engine.js'), mod('context.js'),
    ]);
    cfg.loadCfg();
    state.setDiagnostic('');
    const job = { chatId: host.chatKey(), epoch: state.epoch, deadline: Date.now() + 10000 };
    const source = await context.openingSource(job, host.messages());
    env.ctx.chatMetadata.baobaodai = {
        schemaVersion: 3, revision: 1, lastDrawAt: 0, coordAt: 0,
        activeCards: [], candidates: [], history: [], coordLog: [], floatStage: 'done', floatAt: -1,
        pool: {
            schema: 1, owner: host.chatKey(), source, status: 'ready', pending: null, autoAttempted: true,
            nextId: 5, targets: { plot: 4 },
            cards: [1, 2, 3, 4].map(i => ({ id: 'p-' + i, hook: '剧情纸条' + i, category: 'plot', status: 'available' })),
        },
    };
    await mod('index.js');
    // index 首次挂载异步面板；让已排队的 Promise 完成，不模拟主生成时序。
    await new Promise(resolve => setImmediate(resolve));
    if (sequence > 1) await BUS.emit(TYPES.CHAT_CHANGED, env.ctx.chatId);
    await engine.ready();
    calls.length = 0;
    return Object.assign(env, { dom, host, cfg, state, pool, engine, context, calls });
}

function counts(env) {
    const s = env.state.readState();
    return {
        used: s.pool.cards.filter(c => c.status === 'used').length,
        reserved: s.pool.cards.filter(c => c.status === 'reserved').length,
        available: s.pool.cards.filter(c => c.status === 'available').length,
    };
}

function streamFor(env, { text = '这是一段新的主回复正文。', aborted = false, failed = false, finished = true, type = 'normal' } = {}) {
    env.ctx.chat.push(botMsg(text));
    const controller = new AbortController();
    if (aborted) controller.abort();
    env.ctx.streamingProcessor = {
        type, messageId: env.ctx.chat.length - 1,
        isFinished: finished, isStopped: failed, abortController: controller,
    };
    return env.ctx.streamingProcessor;
}

async function nonstreamReply(env, text = '这是成功保存的主回复。') {
    env.ctx.chat.push(botMsg(text));
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, env.ctx.chat.length - 1, 'normal');
    await env.emitter.emit(TYPES.CHARACTER_MESSAGE_RENDERED, env.ctx.chat.length - 1, 'normal');
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
}

// ST 1.19: script.js:4321 -> 4453 -> 4564 -> openai.js:1619。
{
    T.group('用户入库后才准备和展开宏');
    const env = await boot({
        chat: [botMsg('他抬头看了你一眼。')], cfg: { poolUseContext: true },
        plan: { reply: '{"ids":["p-1"],"reason":"回应当轮输入"}' },
    });
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    T.eq('早期事件不抽卡', counts(env).reserved, 0);
    T.eq('早期事件不发收费请求', env.calls.length, 0);
    env.ctx.chat.push(userMsg('这是本轮才刚刚发送的消息。'));
    await env.emitter.emit(TYPES.MESSAGE_SENT, env.ctx.chat.length - 1);
    await interceptGeneration(env);
    T.eq('第一轮用户消息即可抽卡', counts(env).reserved, 1);
    T.eq('准备锚点取本轮用户楼', env.state.readState().lastPreparedAnchor, env.host.anchorOf(env.host.messages()));
    T.ok('筛选请求包含本轮消息', JSON.stringify(env.calls).includes('这是本轮才刚刚发送的消息。'));
    const prompt = await emitPromptReady(env);
    T.ok('实际展开的system消息包含纸条', prompt.some(m => m.role === 'system' && m.content.includes('剧情纸条1')));
    await nonstreamReply(env);
    T.eq('成功回复后才扣卡', counts(env).used, 1);
}

// ST 1.19: finalizeIntermediaryMessage:3795 先解锁/ENDED，再于3799发RECEIVED。
{
    T.group('真实流式结束顺序');
    const env = await boot();
    await beginGeneration(env);
    const p = streamFor(env);
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('ENDED先到仍正确消费', counts(env).used, 2);
    T.eq('待投清空', counts(env).reserved, 0);
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, p.messageId, 'normal');
    await env.emitter.emit(TYPES.CHARACTER_MESSAGE_RENDERED, p.messageId, 'normal');
    env.ctx.streamingProcessor = null;
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('迟到或重复事件不重复扣卡', counts(env).used, 2);
}

{
    T.group('非流式收到消息再结束');
    const env = await boot();
    await beginGeneration(env);
    await nonstreamReply(env);
    T.eq('完整非流式主回复消费', counts(env).used, 2);
    T.eq('历史和库存一致', env.state.readState().history.filter(h => ['fulfilled', 'delivered'].includes(h.status)).length, 1);
}

// ST onErrorStreaming:3821 abort、3822 isStopped=true，也会发 MESSAGE_RECEIVED。
{
    T.group('网络错误不能靠消息事件冒充成功');
    const env = await boot();
    await beginGeneration(env);
    const pending = env.state.readState().pool.pending.ids;
    const p = streamFor(env, { text: '网络断开前的一小段正文', aborted: true, failed: true, finished: false });
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, p.messageId, 'normal');
    T.eq('网络错误不消费', counts(env).used, 0);
    T.eq('保留原待投纸条', env.state.readState().pool.pending.ids, pending);
    T.eq('保留明确错误原因', env.state.readState().pool.pending.lastFailure, 'generation-error');
}

{
    T.group('fire-and-forget与异步监听器交错');
    const env = await boot();
    await beginGeneration(env);
    const p = streamFor(env, { text: '发生错误前的部分文本', aborted: true, failed: true, finished: false });
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    endObserver = () => waiting;
    const ended = env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    env.ctx.streamingProcessor = null;
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, p.messageId, 'normal');
    release();
    await ended;
    endObserver = null;
    T.eq('先采集错误证据，不被清空processor骗过', counts(env).used, 0);
    T.eq('错误后原纸条仍待投', counts(env).reserved, 2);
}

for (const text of ['', '...', '<!--只有注释-->', '<img src="only-an-image.png">']) {
    T.group('空回复和占位符不消费');
    const env = await boot();
    await beginGeneration(env);
    const p = streamFor(env, { text });
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, p.messageId, 'normal');
    T.eq(JSON.stringify(text) + '不消费卡片', counts(env).used, 0);
    T.eq(JSON.stringify(text) + '继续待投', counts(env).reserved, 2);
}

// ST onStopStreaming:3848 abort并置isFinished=true；不置isStopped。
{
    T.group('用户停止的有效部分正文与Tavo一致');
    const env = await boot();
    await beginGeneration(env);
    const p = streamFor(env, { text: '用户停止时已经保留下来的有效正文。', aborted: true });
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    await env.emitter.emit(TYPES.GENERATION_STOPPED);
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, p.messageId, 'normal');
    T.eq('有效部分正文算已投', counts(env).used, 2);
    T.eq('部分停止不会重复结算', counts(env).reserved, 0);
}

{
    T.group('空停止和重试复用');
    const env = await boot();
    await beginGeneration(env);
    const ids = env.state.readState().pool.pending.ids;
    streamFor(env, { text: '...', aborted: true });
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    await env.emitter.emit(TYPES.GENERATION_STOPPED);
    env.ctx.streamingProcessor = null;
    env.ctx.chat.pop(); // 酒馆移除未生成有效内容的占位楼。
    T.eq('空停止仍未消费', counts(env).used, 0);
    T.eq('空停止解绑等重试', env.state.readState().pool.pending.key, '');
    await beginGeneration(env);
    T.eq('重试仍是同一组纸条', env.state.readState().pool.pending.ids, ids);
    await nonstreamReply(env);
    T.eq('重试成功只消费该组', counts(env).used, 2);
}

{
    T.group('重生成在删楼后准备');
    const env = await boot();
    await env.engine.app.drawNow();
    const ids = env.state.readState().pool.pending.ids;
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'regenerate', {}, false);
    env.ctx.chat.pop();
    await env.emitter.emit(TYPES.MESSAGE_DELETED, env.ctx.chat.length);
    await interceptGeneration(env, 'regenerate');
    await emitPromptReady(env, 'regenerate');
    T.eq('生成内删楼没有释放原纸条', env.state.readState().pool.pending.ids, ids);
    streamFor(env, { type: 'regenerate' });
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('重生成正文按删楼后的基线识别', counts(env).used, 2);
}

{
    T.group('续写确认正文确有增加');
    const env = await boot();
    await env.engine.app.drawNow();
    await beginGeneration(env, 'continue');
    const messageId = env.ctx.chat.length - 1;
    env.ctx.chat[messageId].mes += '，这是续写新增的内容。';
    env.ctx.streamingProcessor = {
        type: 'continue', messageId, isFinished: true, isStopped: false, abortController: new AbortController(),
    };
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('在原对象上追加的正文可以结算', counts(env).used, 2);
}

{
    T.group('最终请求核验');
    const env = await boot();
    await beginGeneration(env, 'normal', { prompt: [{ role: 'system', content: '预设有条目，但最终请求没有变量内容。' }] });
    T.ok('变量本身有纸条', env.host.getChatVar('director_chime_context').includes('纸条'));
    await nonstreamReply(env);
    T.eq('最终prompt缺失时不记已投', counts(env).used, 0);
    T.eq('留在待投区', counts(env).reserved, 2);
    T.ok('诊断点名最终请求未包含变量', /最终请求没有包含/.test(env.engine.snapshot().diagnostic));
}

{
    T.group('最终请求后续修改也要核验');
    const env = await boot();
    const prompt = await beginGeneration(env);
    prompt.splice(0, prompt.length, { role: 'system', content: '别的监听器删除了纸条' });
    await nonstreamReply(env);
    T.eq('不能使用过早的已注入快照', counts(env).used, 0);
}

// ST Vector Storage: summarize_sent -> generateRaw -> PROMPT_READY/SETTINGS_READY(quiet)，
// 随后主Generate才组装预设并发GENERATE_AFTER_DATA与SETTINGS_READY(normal)。
{
    T.group('Vector Storage辅助摘要先于主请求');
    const env = await boot();
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    await interceptGeneration(env);
    await emitPromptReady(env, 'quiet', [{ role: 'system', content: '仅总结最近聊天，不含创意纸条。' }], { raw: true });
    await emitPromptReady(env, 'normal');
    await nonstreamReply(env);
    T.eq('辅助摘要不会抢占真正主请求', counts(env).used, 2);
    T.eq('主请求投递后待投清空', counts(env).reserved, 0);
}

{
    T.group('辅助摘要含纸条不能替主请求作证');
    const env = await boot();
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    await interceptGeneration(env);
    const injected = env.host.getChatVar('director_chime_context');
    await emitPromptReady(env, 'quiet', [{ role: 'system', content: injected }], { raw: true });
    await emitPromptReady(env, 'normal', [{ role: 'system', content: '真正的主请求漏掉了创意纸条。' }]);
    await nonstreamReply(env);
    T.eq('辅助先到且含纸条也不假消费', counts(env).used, 0);
    T.eq('漏注入仍保留原待投', counts(env).reserved, 2);
}

{
    T.group('主流输出时的辅助摘要不能覆盖');
    const env = await boot();
    await beginGeneration(env);
    const p = streamFor(env, { finished: false });
    await emitPromptReady(env, 'quiet', [{ role: 'system', content: '输出期间的另一项摘要。' }], { raw: true });
    p.isFinished = true;
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('流式主请求证据不被后到辅助清空', counts(env).used, 2);
}

{
    T.group('主流漏注入不能由后到辅助补成成功');
    const env = await boot();
    await beginGeneration(env, 'normal', { prompt: [{ role: 'system', content: '主请求没有纸条。' }] });
    const injected = env.host.getChatVar('director_chime_context');
    const p = streamFor(env, { finished: false });
    await emitPromptReady(env, 'quiet', [{ role: 'system', content: injected }], { raw: true });
    p.isFinished = true;
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('后到辅助含纸条不改变主请求失败', counts(env).used, 0);
    env.ctx.streamingProcessor = null;
    await emitPromptReady(env, 'quiet', [{ role: 'system', content: injected }], { raw: true });
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, p.messageId, 'normal');
    T.eq('完成后的辅助也不能补记成功', counts(env).used, 0);
}

{
    T.group('核验最终payload替换后的messages');
    const env = await boot();
    const replaceMessages = data => { if (data.type === 'normal') data.messages = [{ role: 'system', content: '后续请求监听器替换了messages。' }]; };
    env.emitter.on(TYPES.CHAT_COMPLETION_SETTINGS_READY, replaceMessages);
    await beginGeneration(env);
    env.emitter.removeListener(TYPES.CHAT_COMPLETION_SETTINGS_READY, replaceMessages);
    await nonstreamReply(env);
    T.eq('不凭组装阶段旧prompt冒充最终注入', counts(env).used, 0);
}

{
    T.group('非主回复和旧正文不能消费');
    const env = await boot();
    await beginGeneration(env);
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, 0, 'first_message');
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, 1, 'normal');
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, 2, 'normal');
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, 999, 'normal');
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('开场/用户/旧助手/越界事件不消费', counts(env).used, 0);
    await env.emitter.emit(TYPES.GENERATION_STOPPED);
}

{
    T.group('后台预览不抽卡');
    const env = await boot();
    await beginGeneration(env, 'normal', { dryRun: true });
    await beginGeneration(env, 'quiet');
    T.eq('dryRun和quiet均不抽取', counts(env).reserved, 0);
    T.eq('dryRun和quiet均不请求API', env.calls.length, 0);
}

{
    T.group('聊天切换和迟到事件');
    const a = await boot();
    await beginGeneration(a);
    const oldMetadata = a.ctx.chatMetadata;
    const b = await boot();
    await beginGeneration(b);
    await b.emitter.emit(TYPES.GENERATION_ENDED, a.ctx.chat.length);
    T.eq('旧END不能消费新聊天纸条', counts(b).used, 0);
    await nonstreamReply(b);
    T.eq('新聊天真实回复仍能结算', counts(b).used, 2);
    T.eq('旧聊天未被结算', oldMetadata.baobaodai.pool.cards.filter(c => c.status === 'used').length, 0);
}

{
    T.group('旧流不能结算新生成');
    const env = await boot();
    const previous = streamFor(env, { text: '旧聊天遗留正文', finished: false });
    await beginGeneration(env);
    previous.isFinished = true;
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('拦截器开始前存在的流被忽略', counts(env).used, 0);
    env.ctx.streamingProcessor = null;
    await nonstreamReply(env);
    T.eq('当前非流式回复仍结算', counts(env).used, 2);
}

{
    T.group('建流请求失败后仍可编辑失效');
    const env = await boot();
    await beginGeneration(env);
    env.ctx.streamingProcessor = {
        type: 'normal', messageId: -1, isFinished: false, isStopped: false, abortController: new AbortController(),
    };
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    env.ctx.streamingProcessor = null;
    T.eq('还未开始输出的请求错误不消费', counts(env).used, 0);
    env.ctx.chat[1].mes = '失败后用户手动修改了依据';
    await env.emitter.emit(TYPES.MESSAGE_EDITED, 1);
    T.eq('生成结束后手改仍能撤下旧待投', counts(env).reserved, 0);
}

{
    T.group('同群不同聊天身份');
    const env = await boot({ groupId: 'group-1' });
    const before = env.host.chatKey();
    env.ctx.chatId = 'another-chat-in-same-group';
    T.ok('同一个群的两个聊天key不同', env.host.chatKey() !== before);
    T.eq('旧群身份只用于迁移', env.host.legacyChatKey(), 'g:group-1');
    env.ctx.chatId = null;
    T.eq('群已选中但没聊天时没有有效key', env.host.chatKey(), null);
}

{
    T.group('群聊逐成员完成只投一次');
    const env = await boot({ groupId: 'group-1' });
    await env.emitter.emit(TYPES.GROUP_WRAPPER_STARTED, { selected_group: 'group-1', type: 'normal' });
    await beginGeneration(env);
    await nonstreamReply(env);
    await beginGeneration(env);
    await nonstreamReply(env);
    await env.emitter.emit(TYPES.GROUP_WRAPPER_FINISHED, { selected_group: 'group-1', type: 'normal' });
    T.eq('同一群聊轮次只抽一组', counts(env).used, 2);
    T.eq('投放记录只有一组', env.state.readState().history.length, 1);
}

{
    T.group('被自动隐藏的有效主回复');
    const env = await boot();
    await beginGeneration(env);
    env.ctx.chat.push(hiddenMsg('已经持久保存、后被自动隐藏的主回复正文。'));
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, env.ctx.chat.length - 1, 'normal');
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('隐藏不抹去已经生成的正文', counts(env).used, 2);
}

{
    T.group('隐藏正文和图片不改变历史回合');
    const env = await boot({ chat: [botMsg('开场'), userMsg('问'), hiddenMsg('已被隐藏的历史回答'), botMsg('最近回答'),
        { name: 'SillyTavern System', is_system: true, is_user: false, mes: '系统提示', extra: { type: 'generic' } }] });
    const before = env.host.messages();
    T.eq('隐藏助手仍计回合，系统条不计', env.host.assistantRound(before), 3);
    T.eq('隐藏正文仍不进实时上下文', env.host.liveMessages(before).some(m => m.narrative.includes('已被隐藏')), false);
    const sig = env.host.groundingSignature(before[0]);
    env.ctx.chat[0].is_system = true;
    env.ctx.chat[0].mes += '<img src="x.png" alt="a > b">';
    T.eq('hide加图片不改变开场依据', env.host.groundingSignature(env.host.messages()[0]), sig);
}

if (BUS.lastError) T.ok('事件监听器没有隐藏异常', false, BUS.lastError.stack);
process.exitCode = T.report('百宝袋 · SillyTavern 1.19 生成生命周期回归') ? 1 : 0;

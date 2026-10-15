import fs from 'node:fs';
import path from 'node:path';
import { setupDom, createContext, installFetch, makeRunner, userMsg, botMsg, hiddenMsg, TYPES, Emitter } from './harness.mjs';

const EXT = process.argv[2];
if (!EXT) { console.error('用法: node test_all.mjs <扩展目录绝对路径>'); process.exit(2); }
const mod = name => import(path.join(EXT, name));
const PANEL_HTML = fs.readFileSync(path.join(EXT, 'panel.html'), 'utf8');

// 被测代码是 ES module 单例，事件监听只注册一次，所以总线和注入表全程复用
const BUS = new Emitter();
const INJECTIONS = {};
let chatSeq = 0;

const T = makeRunner();

function relayCfg(extra) {
    return Object.assign({
        eyeApiUrl: 'https://relay.test/v1', eyeApiKey: 'sk-eye', eyeModel: 'deepseek-v4.1-flash',
        coordUseEye: true, chimeN: 1, chimeInjectCount: 2, poolUseContext: false,
        poolPlotOn: true, poolEmotionOn: true, poolNsfwOn: false, poolTotalCount: 6,
    }, extra || {});
}

function pooledState(extra) {
    const cards = [];
    for (let i = 1; i <= 4; i++) cards.push({ format: 'slip-v1', id: 'p-' + i, title: '', hook: '剧情纸条' + i, category: 'plot', kind: 'plot', status: 'available' });
    for (let i = 5; i <= 8; i++) cards.push({ format: 'slip-v1', id: 'p-' + i, title: '', hook: '情感纸条' + i, category: 'emotion', kind: 'emotion', status: 'available' });
    return Object.assign({
        schemaVersion: 3, revision: 1, lastDrawAt: 0, coordAt: 0, paused: false,
        tone: '想谈恋爱', history: [], coordLog: [], candidates: [], activeCards: [], floatStage: 'done', floatAt: -1,
        lastPreparedAnchor: '', rerolls: 0,
        pool: { schema: 1, owner: 'c:chat-1', source: null, cards, targets: { plot: 4, emotion: 4 }, nextId: 9, status: 'ready', error: '', pending: null, autoAttempted: true },
    }, extra || {});
}

function baseChat() {
    return [botMsg('他抬头看了你一眼。'), userMsg('我把伞收起来。'), botMsg('“雨还没停。”')];
}

async function boot(options) {
    options = options || {};
    const dom = setupDom();
    const chatId = 'chat-' + (++chatSeq);
    const h = createContext({
        chat: options.chat || baseChat(), chatMetadata: options.meta || {}, extensionSettings: {},
        chatId, emitter: BUS, injections: INJECTIONS,
    });
    h.ctx.extensionSettings.baobaodai = relayCfg(options.cfg);
    if (options.state) h.ctx.chatMetadata.baobaodai = options.state;
    const calls = installFetch(options.plan || {});
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        if (String(url).indexOf('panel.html') >= 0) {
            return { ok: true, status: 200, text: async () => PANEL_HTML, json: async () => ({}) };
        }
        return realFetch(url, opts);
    };
    globalThis.fetch.calls = calls;
    const [hostMod, cfgMod, stateMod, poolMod, engineMod, relayMod, ctxMod] = await Promise.all([
        mod('host.js'), mod('config.js'), mod('state.js'), mod('pool.js'), mod('engine.js'), mod('relay.js'), mod('context.js'),
    ]);
    relayMod.clearDirectCache();
    stateMod.setDiagnostic('');
    cfgMod.loadCfg();
    // 卡池必须带当前开场的真实指纹，否则一律按「设定已变化」拒用
    if (options.state && options.state.pool && (options.state.pool.cards || []).length && !options.state.pool.source) {
        const job = { chatId: hostMod.chatKey(), epoch: stateMod.epoch, deadline: Date.now() + 10000, cancelled: false };
        options.state.pool.source = await ctxMod.openingSource(job, hostMod.messages());
        options.state.pool.owner = hostMod.chatKey();
        h.ctx.chatMetadata.baobaodai = options.state;
    }
    await mod('index.js');
    await globalThis.__bbdReady;
    // 第一次 import 时 index.js 会自己接线并 boot；之后每个用例靠切聊天重置引擎内部状态
    if (chatSeq > 1) {
        await BUS.emit(TYPES.CHAT_CHANGED, chatId);
        await engineMod.ready();
    }
    globalThis.fetch.calls.length = 0;
    return { dom, ...h, calls, host: hostMod, cfg: cfgMod, state: stateMod, pool: poolMod, engine: engineMod, relay: relayMod, context: ctxMod };
}

async function runTurn(env, type, opts) {
    opts = opts || {};
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, type, {}, !!opts.dryRun);
    if (opts.reply !== false) {
        if (opts.pushReply !== false) env.ctx.chat.push(botMsg('回复正文'));
        await env.emitter.emit(TYPES.MESSAGE_RECEIVED, env.ctx.chat.length - 1, type);
    }
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
}

// ── 1. 模块与面板 ────────────────────────────────────────────────
{
    const env = await boot();
    T.group('模块与面板挂载');
    T.ok('11 个模块全部加载', env.engine && env.pool && env.cfg && env.state);
    T.ok('运行时挂到 window', typeof globalThis.window.__baobaodaiApp === 'object');
    T.ok('面板 DOM 已插入', !!document.getElementById('dr-panel'));
    T.ok('浮标 DOM 已插入', !!document.getElementById('dr-ball'));
    T.eq('两个页签', document.querySelectorAll('.dr-tab').length, 2);
    const ids = (PANEL_HTML.match(/id="([^"]+)"/g) || []).map(x => x.slice(4, -1));
    const missing = ids.filter(id => !document.getElementById(id));
    T.eq('结构里 142 个 id 全部可取到', missing, []);
    T.ok('文案已本地化（不是裸 key）', (document.querySelector('[data-dr-i18n="layout.delivery"]') || {}).textContent === '剧情投放');
    T.ok('版本号已填', /^v0\.5\.16$/.test(document.getElementById('dr-head-v').textContent));
    T.ok('酒馆扩展区入口已加', !!document.getElementById('dr-entry-open'));
    const snap = await env.engine.snapshot();
    T.ok('快照可取', !!snap && snap.version === '0.5.16');
    T.ok('诊断里说明不用改预设', /不需要在预设里加条目/.test(snap.channels.reason));
    document.getElementById('dr-ball').dispatchEvent(new globalThis.window.Event('click'));
    T.ok('点浮标能打开面板', document.getElementById('dr-panel').classList.contains('show'));
}

// ── 2. 注入（替代预设通道）────────────────────────────────────────
{
    const state = pooledState({ activeCards: [{ id: 'p-1', title: '', hook: '寄错的信，称呼却很熟悉', category: 'plot' }], floatStage: 'active', floatAt: 3 });
    const env = await boot({ state });
    T.group('原生注入');
    await env.engine.app.refresh();
    await env.state.localEdit(() => {});
    const chime = env.injections['baobaodai_chime'];
    T.ok('空投内容已注入', chime && chime.value.indexOf('寄错的信') >= 0);
    T.eq('位置 = IN_CHAT(1)', chime.position, 1);
    T.eq('深度 = 2', chime.depth, 2);
    T.eq('角色 = SYSTEM(0)', chime.role, 0);
    T.ok('注入带「尚未发生」免责', /候选事件，尚未发生/.test(chime.value));
    // 她的疑问：会不会写进楼层。注入只进「发给模型的请求」，聊天记录必须一个字都不动
    T.eq('聊天楼层数没变', env.ctx.chat.length, 3);
    T.eq('楼层正文没被改写', env.ctx.chat.map(m => m.mes), ['他抬头看了你一眼。', '我把伞收起来。', '“雨还没停。”']);
    T.ok('没有任何楼层含纸条文本', !env.ctx.chat.some(m => m.mes.indexOf('寄错的信') >= 0));
    T.ok('没有新增隐藏楼或系统楼', env.ctx.chat.filter(m => m.is_system).length === 0);
    T.ok('注入只存在注入表里', Object.keys(env.injections).indexOf('baobaodai_chime') >= 0);
    await env.engine.app.closeCard(false);
    T.eq('撤下候选后注入清空', env.injections['baobaodai_chime'].value, '');
    await env.emitter.emit(TYPES.CHAT_CHANGED, null);
    T.eq('关闭聊天清空注入', env.injections['baobaodai_chime'].value, '');
}

// ── 3. 重生成不清零回合计数（0.5.15 根因一）──────────────────────
{
    const env = await boot({ state: pooledState({ lastDrawAt: 7, lastPreparedAnchor: 'x', activeCards: [{ id: 'p-1', hook: '在场纸条', category: 'plot' }], floatStage: 'active', floatAt: 7 }) });
    T.group('重生成不清计数');
    // 酒馆重生成 = 先删最后一楼再生成，删楼事件夹在生成流程中间
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'regenerate', {}, false);
    env.ctx.chat.pop();
    await env.emitter.emit(TYPES.MESSAGE_DELETED, env.ctx.chat.length);
    let s = env.state.readState();
    T.eq('重生成期间 lastDrawAt 不动', s.lastDrawAt, 7);
    T.eq('重生成期间不撤在场纸条', s.activeCards.length, 1);
    T.eq('重生成累计次数', s.rerolls, 1);
    env.ctx.chat.push(botMsg('换一版回复'));
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, env.ctx.chat.length - 1, 'regenerate');
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    s = env.state.readState();
    T.eq('重生成结束后 lastDrawAt 仍不动', s.lastDrawAt, 7);
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'swipe', {}, false);
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    T.eq('swipe 也算重生成不清计数', env.state.readState().lastDrawAt, 7);
    T.eq('连续三次给出手动诊断提示', (await (async () => {
        await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'regenerate', {}, false);
        await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
        return env.state.readState();
    })()).ngSuggested, true);
}

// ── 4. 手动删楼仍然失效，但不清计数 ─────────────────────────────
{
    const env = await boot({ state: pooledState({ lastDrawAt: 7, lastPreparedAnchor: 'x', coordText: '【派人】老周', activeCards: [{ id: 'p-1', hook: '在场纸条', category: 'plot' }], floatStage: 'active', floatAt: 7 }) });
    T.group('手动删楼');
    env.ctx.chat.pop();
    await env.emitter.emit(TYPES.MESSAGE_DELETED, env.ctx.chat.length);
    const s = env.state.readState();
    T.eq('撤下在场纸条', s.activeCards.length, 0);
    T.eq('清掉调度文本', s.coordText, '');
    T.eq('清掉本轮锚点', s.lastPreparedAnchor, '');
    T.eq('lastDrawAt 不被清零', s.lastDrawAt, 7);
    T.eq('纸条退回可抽', s.pool.cards.filter(c => c.status === 'available').length, 8);
}

// ── 5. 建池开关不锁死已买的卡（0.5.15 根因二）────────────────────
{
    const env = await boot({
        cfg: { poolPlotOn: false, poolDrawCategories: ['plot'], chimeN: 1 },
        state: pooledState({ lastDrawAt: 0 }),
        chat: baseChat(),
    });
    T.group('建池开关与抽卡白名单分离');
    T.eq('建池分类不含 plot', env.pool.poolCategories(env.cfg.config), ['emotion']);
    const r = await env.engine.app.drawNow();
    T.ok('关掉剧情建池仍能抽到剧情卡', r.ok && r.cards && r.cards.length > 0, r.reason);
    T.ok('抽出的确实是剧情卡', r.cards && r.cards.every(c => c.category === 'plot'), r.reason);
    T.eq('盲抽不调用任何 API', globalThis.fetch.calls.filter(c => c.url.indexOf('completions') >= 0).length, 0);
    const s = env.state.readState();
    T.eq('抽出的纸条转为预留', s.pool.cards.filter(c => c.status === 'reserved').length, 2);
    T.ok('注入里出现剧情纸条', /剧情纸条/.test(env.injections['baobaodai_chime'].value));
}

// ── 6. 投放范围变更会撤下范围外的在场纸条 ───────────────────────
{
    const env = await boot({ state: pooledState({ activeCards: [{ id: 'p-1', hook: '剧情纸条1', category: 'plot' }], floatStage: 'active', floatAt: 3 }) });
    T.group('投放范围变更');
    await env.engine.app.saveCfg({ poolDrawCategories: ['emotion'] });
    T.eq('范围外纸条被撤下', env.state.readState().activeCards.length, 0);
}

// ── 7. dryRun 不花钱 ───────────────────────────────────────────
{
    const env = await boot({ cfg: { poolUseContext: true, chimeN: 1 }, state: pooledState({ lastDrawAt: 0 }) });
    T.group('预设编辑器预览不花钱');
    await runTurn(env, 'normal', { dryRun: true, reply: false });
    T.eq('dryRun 一次 API 都不发', globalThis.fetch.calls.length, 0);
    T.eq('dryRun 不改状态', env.state.readState().lastDrawAt, 0);
}

// ── 8. 成功扣卡 / 失败保留预留 ──────────────────────────────────
{
    const env = await boot({ state: pooledState({ lastDrawAt: 0 }), cfg: { chimeN: 1 } });
    T.group('成功与失败结算');
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    let s = env.state.readState();
    T.eq('本轮抽出两张待投', s.pool.cards.filter(c => c.status === 'reserved').length, 2);
    T.ok('预留已绑定本次生成', !!s.pool.pending && !!s.pool.pending.key);
    env.ctx.chat.push(botMsg('回复正文'));
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, env.ctx.chat.length - 1, 'normal');
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    s = env.state.readState();
    T.eq('成功后记为已投', s.pool.cards.filter(c => c.status === 'used').length, 2);
    T.eq('成功后撤下展示', s.activeCards.length, 0);
    T.eq('历史记为已兑现', (s.history[s.history.length - 1] || {}).status, 'fulfilled');

    const env2 = await boot({ state: pooledState({ lastDrawAt: 0 }), cfg: { chimeN: 1 } });
    await env2.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    await env2.emitter.emit(TYPES.GENERATION_ENDED, env2.ctx.chat.length);
    const s2 = env2.state.readState();
    T.eq('没出回复就不扣卡', s2.pool.cards.filter(c => c.status === 'used').length, 0);
    T.eq('纸条仍为预留等重试', s2.pool.cards.filter(c => c.status === 'reserved').length, 2);
    T.eq('预留解绑等下次重试复用', (s2.pool.pending || {}).key, '');
    T.ok('失败记下原因', (s2.pool.pending || {}).lastFailure === 'no-reply');
}

// ── 9. 节奏控制 ────────────────────────────────────────────────
{
    const env = await boot({ cfg: { chimeN: 5 }, state: pooledState({ lastDrawAt: 2 }) });
    T.group('空投节奏');
    await runTurn(env, 'normal');
    T.eq('没攒够间隔不抽', env.state.readState().activeCards.length, 0);

    const env2 = await boot({ cfg: { chimeN: 1 }, state: pooledState({ lastDrawAt: 0, paused: true }) });
    await runTurn(env2, 'normal');
    T.eq('暂停时不抽', env2.state.readState().activeCards.length, 0);

    const env3 = await boot({ cfg: { chimeN: 1, chimeEnabled: false }, state: pooledState({ lastDrawAt: 0 }) });
    await runTurn(env3, 'normal');
    T.eq('关闭投放时不抽', env3.state.readState().activeCards.length, 0);

    const env4 = await boot({ cfg: { chimeN: 1 }, state: pooledState({ lastDrawAt: 0, pool: Object.assign(pooledState().pool, { pending: { ids: ['p-1'], key: '', at: Date.now() } }) }) });
    await env4.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    T.ok('已有待结算预留时不重复抽', ((env4.state.readState().pool.pending || {}).ids || []).length === 1);

    const env5 = await boot({ cfg: { chimeN: 1 }, state: pooledState({ lastDrawAt: 0 }) });
    await env5.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'continue', {}, false);
    T.eq('续写不消费新一轮', env5.state.readState().activeCards.length, 0);
}

// ── 10. 群聊一轮只算一次 ───────────────────────────────────────
{
    const env = await boot({ cfg: { chimeN: 1 }, state: pooledState({ lastDrawAt: 0 }) });
    T.group('群聊');
    await env.emitter.emit(TYPES.GROUP_WRAPPER_STARTED, { type: 'normal' });
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    const first = env.state.readState().activeCards.length;
    await env.emitter.emit(TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    const second = env.state.readState().activeCards.length;
    await env.emitter.emit(TYPES.GROUP_WRAPPER_FINISHED, { type: 'normal' });
    T.ok('第一个成员正常投放', first > 0);
    T.eq('后续成员不再重复抽', second, first);
}

// ── 11. 直连与后端回落 ────────────────────────────────────────
{
    const env = await boot({ cfg: { poolUseContext: true, chimeN: 1 }, state: pooledState({ lastDrawAt: 0 }), plan: { reply: '{"ids":["p-1"],"reason":"贴合"}' } });
    T.group('双通道');
    const r = await env.engine.app.drawNow();
    T.ok('直连成功就用直连', r.ok, r.reason);
    T.ok('请求打到中转站', globalThis.fetch.calls.some(c => c.url === 'https://relay.test/v1/chat/completions'));
    T.ok('没走后端', !globalThis.fetch.calls.some(c => c.url.indexOf('/api/backends/') === 0));

    const env2 = await boot({ cfg: { poolUseContext: true, chimeN: 1 }, state: pooledState({ lastDrawAt: 0 }), plan: { corsBlocked: true, reply: '{"ids":["p-1"],"reason":"贴合"}' } });
    const r2 = await env2.engine.app.drawNow();
    T.ok('跨域被拦仍然成功', r2.ok, r2.reason);
    const backend = globalThis.fetch.calls.filter(c => c.url.indexOf('/api/backends/chat-completions/generate') === 0);
    T.eq('自动改走酒馆后端', backend.length, 1);
    T.eq('用 custom 源', backend[0].body.chat_completion_source, 'custom');
    T.eq('带上中转地址', backend[0].body.custom_url, 'https://relay.test/v1');
    T.ok('密钥随请求头下发', /Bearer sk-eye/.test(backend[0].body.custom_include_headers));
    T.ok('带 CSRF 头', !!backend[0].headers['X-CSRF-Token']);

    const env3 = await boot({ cfg: { poolUseContext: true, chimeN: 1 }, state: pooledState({ lastDrawAt: 0 }), plan: { httpStatus: 401 } });
    const r3 = await env3.engine.app.drawNow();
    T.ok('401 不回落、直接报鉴权失败', !r3.ok && /鉴权失败/.test(r3.reason), r3.reason);
    T.eq('401 不重复打第二条通道', globalThis.fetch.calls.length, 1);
}

// ── 12. 模型列表双通道 ────────────────────────────────────────
{
    const env = await boot({ plan: { models: ['m-a', 'm-b'] } });
    T.group('模型列表');
    const r = await env.engine.app.listModels('chime', { relayDraft: { url: 'https://relay.test/v1', key: 'sk-eye' } });
    T.eq('直连拉到模型', r.models, ['m-a', 'm-b']);
    const env2 = await boot({ plan: { corsBlocked: true, models: ['m-c'] } });
    const r2 = await env2.engine.app.listModels('chime', { relayDraft: { url: 'https://relay.test/v1', key: 'sk-eye' } });
    T.eq('跨域被拦则走后端 status', r2.models, ['m-c']);
    T.ok('打的是 status 端点', globalThis.fetch.calls.some(c => c.url.indexOf('/api/backends/chat-completions/status') === 0));
}

// ── 13. 建池解析与配额 ────────────────────────────────────────
{
    const env = await boot({
        cfg: { poolTotalCount: 4, poolPlotOn: true, poolEmotionOn: true, poolNsfwOn: false },
        state: Object.assign(pooledState(), { pool: { schema: 1, owner: null, source: null, cards: [], targets: {}, nextId: 1, status: 'empty', error: '', pending: null, autoAttempted: false } }),
        plan: {
            reply: ['剧情|寄错的信，称呼却很熟悉', '情感|争执过后，早餐仍是双份', '剧情|这一条长度明显超过了存储允许的四十个字上限所以它应该在入池之前就被丢弃掉才算正确行为', '剧情|寄错的信，称呼却很熟悉', '乱分类|不该收', '剧情|一'].join('\n'),
        },
    });
    T.group('建池');
    const r = await env.engine.app.buildPool({ confirmed: true });
    T.ok('建池成功', r.ok, r.reason);
    const cards = env.state.readState().pool.cards;
    T.eq('只收下合规的两条', cards.length, 2);
    T.eq('分类正确', cards.map(c => c.category), ['plot', 'emotion']);
    T.ok('超长被丢', !cards.some(c => c.hook.length > 20));
    T.ok('重复被丢', new Set(cards.map(c => c.hook)).size === cards.length);
    T.ok('未知分类被丢', !cards.some(c => c.category === '乱分类'));
    T.ok('一个字的太短被丢', !cards.some(c => c.hook === '一'));
    T.eq('只发一次请求', globalThis.fetch.calls.filter(c => c.url.indexOf('completions') >= 0).length, 1);
    T.ok('未确认付费则拒绝建池', (await env.engine.app.buildPool({})).ok === false);
    const fp = (env.state.readState().pool.source || {}).fingerprint;
    env.ctx.characters[0].description = '换了一张卡';
    const r2 = await env.engine.app.buildPool({ confirmed: true });
    T.ok('设定变了拒绝混池', !r2.ok && /已变化/.test(r2.reason), r2.reason);
    T.ok('旧池保留', env.state.readState().pool.cards.length === 2);
    T.ok('指纹没被覆盖', (env.state.readState().pool.source || {}).fingerprint === fp);
}

// ── 14. 配置与中转 ────────────────────────────────────────────
{
    const env = await boot();
    T.group('配置与中转');
    const rev = env.cfg.config.relayRevision;
    await T.throws('修订冲突会拒绝保存', () => env.engine.app.saveRelay('chime', { id: '', name: 'x', url: 'https://a.test/v1', key: 'k', model: 'm', expectedRevision: rev + 99 }), /重新载入后保存/);
    await T.throws('换地址不填密钥要报错', () => env.engine.app.saveRelay('chime', { id: env.cfg.config.eyeRelayId, name: 'n', url: 'https://other.test/v1', model: 'm', expectedRevision: env.cfg.config.relayRevision }), /必须明确填写密钥/);
    await T.throws('空模型要报错', () => env.engine.app.saveRelay('chime', { id: '', name: 'n', url: 'https://a.test/v1', key: 'k', model: '', expectedRevision: env.cfg.config.relayRevision }), /模型/);
    await T.throws('非 http 地址要报错', () => env.engine.app.saveRelay('chime', { id: '', name: 'n', url: 'ftp://a.test', key: 'k', model: 'm', expectedRevision: env.cfg.config.relayRevision }), /http/);
    const saved = await env.engine.app.saveRelay('chime', { id: '', name: '新站', url: 'https://new.test', key: 'sk-new', model: 'm-new', expectedRevision: env.cfg.config.relayRevision });
    T.ok('新增中转成功', saved.ok);
    T.eq('存的是她填的原文', env.cfg.config.eyeApiUrl, 'https://new.test');
    T.eq('请求时补成 /v1', env.relay.endpoint('https://new.test'), 'https://new.test/v1/chat/completions');
    T.eq('已带 /v1 的不重复补', env.relay.endpoint('https://a.test/v1/'), 'https://a.test/v1/chat/completions');
    T.eq('误填到 completions 也能纠正', env.relay.endpoint('https://a.test/v1/chat/completions'), 'https://a.test/v1/chat/completions');
    T.ok('在用的中转不许删', (await env.engine.app.removeRelay(env.cfg.config.eyeRelayId).catch(e => ({ msg: e.message }))).msg !== undefined);
    const first = await env.engine.app.repairRelays(false);
    T.ok('重置中转要二次确认', first.ok === false);
    const second = await env.engine.app.repairRelays(true);
    T.ok('二次确认后重置', second.ok && env.cfg.config.relayProfiles.length === 0);
}

// ── 15. 编辑楼层的失效判定（消息没有稳定 id）────────────────────
{
    const env = await boot({ state: pooledState({ activeCards: [{ id: 'p-1', hook: '在场纸条', category: 'plot' }], floatStage: 'active', floatAt: 3, coordText: '【派人】老周' }) });
    T.group('编辑楼层');
    env.ctx.chat[2].mes = '“雨还没停。”![生成图片](files/chat/sdg_1.png)';
    await env.emitter.emit(TYPES.MESSAGE_UPDATED, 2);
    T.eq('只加了插图不算改正文', env.state.readState().activeCards.length, 1);
    env.ctx.chat[2].mes = '他转身就走了。';
    await env.emitter.emit(TYPES.MESSAGE_EDITED, 2);
    T.eq('真改了正文就撤下', env.state.readState().activeCards.length, 0);
    T.eq('同时清掉旧调度', env.state.readState().coordText, '');
}

// ── 16. 隐藏楼与回合口径 ──────────────────────────────────────
{
    const env = await boot({ chat: [botMsg('开场'), userMsg('问'), hiddenMsg('被小记总结隐藏的楼'), botMsg('答')] });
    T.group('隐藏楼');
    const ms = env.host.messages();
    T.eq('隐藏楼被标出', ms.filter(m => m.hidden).length, 1);
    T.eq('回合数不含隐藏楼', env.host.assistantRound(ms), 2);
    T.ok('锚点取最后一条用户楼', env.host.anchorOf(ms).indexOf('1:') === 0);
}

// ── 17. 切聊天不串数据 ────────────────────────────────────────
{
    const env = await boot({ state: pooledState({ lastDrawAt: 7, activeCards: [{ id: 'p-1', hook: 'A 聊天的纸条', category: 'plot' }], floatStage: 'active', floatAt: 7 }) });
    T.group('切聊天隔离');
    const metaA = env.ctx.chatMetadata;
    env.ctx.chatId = 'chat-other';
    env.ctx.chatMetadata = {};
    await env.emitter.emit(TYPES.CHAT_CHANGED, 'chat-other');
    await env.engine.ready();
    const s = env.state.readState();
    T.eq('新聊天没有旧纸条', s.activeCards.length, 0);
    T.eq('新聊天卡池是空的', (s.pool.cards || []).length, 0);
    T.ok('旧聊天的数据还在原处', ((metaA.baobaodai || {}).activeCards || []).length === 1);
    T.eq('注入已按新聊天重算', env.injections['baobaodai_chime'].value, '');
}

// ── 18. 场外小叮当 ────────────────────────────────────────────
{
    const env = await boot({ plan: { reply: '【派人】让老周把口信送到。\n【顺场】维持现状。\n【收线】雨夜的伞。\n【本轮重点】先别转场。' } });
    T.group('场外小叮当');
    const r = await env.engine.app.runCoordinator('让冷板凳的老周重新出场');
    T.ok('调度成功', r.ok, r.reason);
    T.ok('调度文本已注入', /老周/.test(env.injections['baobaodai_coord'].value));
    T.ok('注入带不可当事实的免责', /执行建议而非已发生事实/.test(env.injections['baobaodai_coord'].value));
    T.eq('一次性补充用后清空', env.state.readState().coordExtra, '');
    T.ok('留了调度记录', env.state.readState().coordLog.length === 1);
    await env.engine.app.clearCoord();
    T.eq('清空调度后注入也清掉', env.injections['baobaodai_coord'].value, '');

    const env2 = await boot({ cfg: { coordEnabled: false } });
    const r2 = await env2.engine.app.runCoordinator('x');
    T.ok('关掉就不调度', !r2.ok && /已关闭/.test(r2.reason), r2.reason);
}

// ── 19. 试抽不扣卡 ────────────────────────────────────────────
{
    const env = await boot({ state: pooledState({ lastDrawAt: 0 }) });
    T.group('试抽');
    const r = await env.engine.app.previewDraw();
    T.ok('试抽有结果', r.ok && r.cards.length > 0, r.reason);
    const s = env.state.readState();
    T.eq('试抽不预留', s.pool.cards.filter(c => c.status === 'reserved').length, 0);
    T.eq('试抽不改在场', s.activeCards.length, 0);
    T.eq('试抽不动计数', s.lastDrawAt, 0);
}

// ── 20. 丢弃与清空 ────────────────────────────────────────────
{
    const env = await boot({ state: pooledState() });
    T.group('丢弃与清空');
    await env.engine.app.discardPoolCard('p-1');
    T.eq('丢弃后状态为 discarded', (env.state.readState().pool.cards.find(c => c.id === 'p-1') || {}).status, 'discarded');
    T.ok('不能丢弃不可用的卡', (await env.engine.app.discardPoolCard('p-1').catch(e => ({ msg: e.message }))).msg !== undefined);
    T.ok('清空要确认', (await env.engine.app.resetPool(false)).ok === false);
    await env.engine.app.resetPool(true, env.host.chatKey());
    T.eq('清空后卡池为空', env.state.readState().pool.cards.length, 0);
}

process.exit(T.report('百宝袋酒馆版 · 回归测试') ? 1 : 0);

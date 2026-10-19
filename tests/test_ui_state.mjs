import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupDom, createContext, botMsg, userMsg, TYPES, beginGeneration, makeRunner } from './harness.mjs';

const root = path.resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
const mod = name => import(pathToFileURL(path.join(root, name)).href);
const html = fs.readFileSync(path.join(root, 'panel.html'), 'utf8');
setupDom();
const env = createContext({ chat: [botMsg('开场正文'), userMsg('本轮用户问题'), botMsg('上一轮答复')] });
env.ctx.extensionSettings.baobaodai = {
    chimeN: 1, chimeInjectCount: 2, poolUseContext: false, coordEnabled: false,
    eyeApiUrl: 'https://relay.test/v1', eyeModel: 'test', poolAutoInit: false,
};
globalThis.fetch = async url => {
    if (String(url).endsWith('panel.html')) return { ok: true, text: async () => html };
    throw Error('UI regression must not call an API');
};
const [H, S, C, E, Context] = await Promise.all(['host.js', 'state.js', 'config.js', 'engine.js', 'context.js'].map(mod));
C.loadCfg();
await mod('index.js');
await new Promise(resolve => setImmediate(resolve));
await E.ready();
const T = makeRunner();
const flushUI = async () => {
    E.app.refresh();
    await new Promise(resolve => setImmediate(resolve));
};
const face = () => document.getElementById('dr-face').textContent;

async function reset() {
    env.ctx.chat = [botMsg('开场正文'), userMsg('本轮用户问题'), botMsg('上一轮答复')];
    env.ctx.streamingProcessor = null;
    const source = await Context.openingSource({ chatId: H.chatKey(), epoch: S.epoch, deadline: Date.now() + 10000 }, H.messages());
    env.ctx.chatMetadata = { baobaodai: {
        schemaVersion: 3, lastDrawAt: 0, coordAt: 0, activeCards: [], history: [], floatStage: 'done',
        pool: { ...S.newPool(), owner: H.chatKey(), source, status: 'ready', targets: { plot: 4 },
            cards: [1, 2, 3, 4].map(i => ({ id: 'p-' + i, hook: '纸条事件' + i, category: 'plot', status: 'available' })) },
    } };
    await env.emitter.emit(TYPES.CHAT_CHANGED, env.ctx.chatId);
    await E.ready();
    await flushUI();
}

async function succeed() {
    env.ctx.chat.push(botMsg('主模型已返回一段新的有效正文。'));
    await env.emitter.emit(TYPES.MESSAGE_RECEIVED, env.ctx.chat.length - 1, 'normal');
    await env.emitter.emit(TYPES.GENERATION_ENDED, env.ctx.chat.length);
    await flushUI();
}

T.group('待投区仅展示手动抽取');
await reset();
await E.app.drawNow();
await flushUI();
T.eq('手动抽取标明来源', S.readState().pool.pending.origin, 'manual');
T.ok('手动纸条显示在待投区', /纸条事件/.test(face()));
T.eq('手动纸条允许撤下', document.getElementById('dr-close-card').disabled, false);
await beginGeneration(env, 'normal');
await env.emitter.emit(TYPES.GENERATION_STOPPED);
await flushUI();
T.ok('手动纸条失败后仍留待投区', /纸条事件/.test(face()));
const manualIds = S.readState().pool.pending.ids;
await beginGeneration(env, 'normal');
T.eq('手动失败重试复用同组', S.readState().pool.pending.ids, manualIds);
await succeed();
T.ok('手动投送成功后移出待投区', !/纸条事件/.test(face()));
T.eq('成功后撤下按钮不可用', document.getElementById('dr-close-card').disabled, true);

await reset();
await E.app.drawNow();
delete env.ctx.chatMetadata.baobaodai.pool.pending.origin;
await flushUI();
T.eq('旧版未知来源保持明确未知', S.readState().pool.pending.origin, 'legacy');
T.ok('未知来源旧纸条不冒充手动待投', !/纸条事件/.test(face()));
T.eq('旧预留仍保存在后台等待重试', S.readState().pool.cards.filter(c => c.status === 'reserved').length, 2);

await reset();
await beginGeneration(env, 'normal');
await flushUI();
T.eq('自动抽取标明来源', S.readState().pool.pending.origin, 'automatic');
T.ok('自动纸条不进入待投区', !/纸条事件/.test(face()));
T.eq('空待投区不能误撤后台自动纸条', document.getElementById('dr-close-card').disabled, true);
T.ok('后台保留预留以便失败重试', S.readState().pool.pending.ids.length === 2);
await env.emitter.emit(TYPES.GENERATION_STOPPED);
await flushUI();
T.ok('自动失败后也不进入手动待投区', !/纸条事件/.test(face()));
const automaticIds = S.readState().pool.pending.ids;
await beginGeneration(env, 'normal');
T.eq('自动重试没有再次抽取', S.readState().pool.pending.ids, automaticIds);
await succeed();
T.eq('实际投送后卡池计数增加', S.readState().pool.cards.filter(c => c.status === 'used').length, 2);
T.ok('卡池状态栏同步显示已投2', /已投2/.test(document.getElementById('dr-pool-summary').textContent));
T.ok('投送记录说明不代表剧情发生', /已投送（不代表剧情已发生）/.test(document.getElementById('dr-hist').textContent));

T.group('旧池记录与诊断');
await E.app.resetPool(true);
await flushUI();
T.ok('清池后的记录标明旧卡池', /旧卡池记录/.test(document.getElementById('dr-hist').textContent));
T.ok('清池后显示当前卡池已投0', /当前卡池.*已投0/.test(document.getElementById('dr-pool-summary').textContent));
const check = await E.app.selfCheck();
T.eq('诊断自检正常返回', check.ok, true);

process.exit(T.report('百宝袋 · 面板投送状态回归') ? 1 : 0);

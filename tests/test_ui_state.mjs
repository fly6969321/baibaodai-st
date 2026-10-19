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

T.group('沿用现有卡池确认');
// jsdom supplies dialog elements but some versions omit their modal methods.
for (const id of ['dr-realign-dialog', 'dr-reset-dialog']) {
    const dialog = document.getElementById(id);
    if (typeof dialog.showModal !== 'function') dialog.showModal = function () { this.open = true; };
    if (typeof dialog.close !== 'function') dialog.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
}
const originalApp = window.__baobaodaiApp;
const originalChatId = env.ctx.chatId;
const realignCalls = [];
let buildCalls = 0, resetCalls = 0;
const previewCurrent = () => {
    const state = S.readState();
    return {
        ok: true, confirmationRequired: true,
        counts: { total: state.pool.cards.length, available: state.pool.cards.filter(c => c.status === 'available').length,
            reserved: state.pool.cards.filter(c => c.status === 'reserved').length, used: state.pool.cards.filter(c => c.status === 'used').length },
        expectedChatId: H.chatKey(), expectedEpoch: S.epoch, expectedRevision: state.revision,
        expectedSourceFingerprint: state.pool.source.fingerprint, freshFingerprint: 'current-opening-fingerprint',
        reason: '仅开场正文不同，可以确认沿用。',
    };
};
let previewRealign = previewCurrent;
let submitRealign = async options => {
    if (options.expectedRevision !== S.readState().revision) return { ok: false, reason: '卡池状态已变化，请重新核对。' };
    env.ctx.chatMetadata.baobaodai.pool.status = 'ready';
    env.ctx.chatMetadata.baobaodai.pool.sourceMismatch = null;
    return { ok: true, reason: '已沿用现有卡池。' };
};
window.__baobaodaiApp = {
    ...originalApp,
    buildPool: () => { buildCalls++; throw Error('Recovery UI must not build a pool'); },
    resetPool: () => { resetCalls++; throw Error('Recovery UI must not reset a pool'); },
    realignPoolSource: async options => {
        realignCalls.push(options ? structuredClone(options) : null);
        return options ? submitRealign(options) : previewRealign();
    },
};
const realignDialog = document.getElementById('dr-realign-dialog');
const realignRow = document.getElementById('dr-pool-realign-row');
const realignButton = document.getElementById('dr-pool-realign');
const prepareRealignment = async () => {
    env.ctx.chatId = originalChatId;
    await reset();
    const pool = env.ctx.chatMetadata.baobaodai.pool;
    pool.status = 'stale'; pool.sourceMismatch = { openingOnly: true };
    previewRealign = previewCurrent;
    realignCalls.length = 0;
    await flushUI();
};
await prepareRealignment();
T.eq('仅开场不一致时显示沿用入口', realignRow.hidden, false);
T.eq('恢复入口没有重复ID', document.querySelectorAll('#dr-pool-realign-row').length, 1);
T.ok('恢复入口位于付费建池确认之前', !!(realignRow.compareDocumentPosition(document.getElementById('dr-pool-consent')) & 4));
T.eq('恢复入口无需付费建池勾选', document.getElementById('dr-pool-consent').checked, false);
env.ctx.chatMetadata.baobaodai.pool.status = 'ready';
await flushUI();
T.eq('正常卡池隐藏沿用入口', realignRow.hidden, true);
env.ctx.chatMetadata.baobaodai.pool.status = 'stale';
env.ctx.chatMetadata.baobaodai.pool.sourceMismatch.openingOnly = false;
await flushUI();
T.eq('其他设定变化不显示沿用入口', realignRow.hidden, true);

await prepareRealignment();
const beforeCancel = structuredClone(S.readState().pool.cards);
realignButton.click();
await flushUI();
T.eq('首次点击只调用预览', realignCalls, [null]);
T.eq('预览后打开独立确认框', realignDialog.open, true);
T.eq('沿用操作没有打开清空对话框', document.getElementById('dr-reset-dialog').open, false);
T.ok('确认框展示最新库存数量', /共 4 条.*可抽 4.*预留 0.*已投 0/.test(document.getElementById('dr-realign-counts').textContent));
const recoveryDescription = document.getElementById('dr-realign-description').textContent;
T.ok('确认框说明保留纸条和已投记录', /保留全部纸条和已投记录/.test(recoveryDescription));
T.ok('确认框说明撤下未投纸条再对齐开场', /撤下尚未投送的纸条/.test(recoveryDescription) && /对齐当前开场/.test(recoveryDescription));
T.ok('确认框说明不调用建池接口', /不会调用建池 API/.test(recoveryDescription));
document.getElementById('dr-realign-cancel').click();
await flushUI();
T.eq('取消关闭确认框', realignDialog.open, false);
T.eq('取消不会提交恢复', realignCalls.length, 1);
T.eq('取消保留库存不变', S.readState().pool.cards, beforeCancel);

const expectedPreview = previewCurrent();
realignButton.click();
await flushUI();
document.getElementById('dr-realign-accept').click();
document.getElementById('dr-realign-accept').click();
await flushUI();
const submissions = realignCalls.filter(Boolean);
T.eq('确认只提交一次并完整携带预览约束', submissions, [{ ...expectedPreview, confirmed: true }]);
T.eq('提交后关闭确认框', realignDialog.open, false);
T.eq('恢复成功后隐藏入口', realignRow.hidden, true);
T.eq('沿用操作未调用清池', resetCalls, 0);
T.eq('沿用操作未调用建池', buildCalls, 0);

await prepareRealignment();
previewRealign = () => ({ ok: false, reason: '当前变化不限于开场，不能直接沿用。' });
realignButton.click();
await flushUI();
T.eq('失败预览不打开确认框', realignDialog.open, false);
T.ok('失败预览给出后端原因', /不能直接沿用/.test(document.getElementById('dr-pool-msg').textContent));
T.eq('失败预览不自动提交', realignCalls.filter(Boolean).length, 0);

await prepareRealignment();
realignButton.click();
await flushUI();
env.ctx.chatMetadata.baobaodai.revision = S.readState().revision + 1;
document.getElementById('dr-realign-accept').click();
await flushUI();
T.eq('状态变化仍交由后端验证旧预览约束', realignCalls.filter(Boolean).length, 1);
T.ok('提交被拒后显示状态变化原因', /卡池状态已变化/.test(document.getElementById('dr-pool-msg').textContent));
T.eq('被拒操作不报告恢复成功', S.readState().pool.status, 'stale');

await prepareRealignment();
realignButton.click();
await flushUI();
env.ctx.chatId = 'other-ui-chat';
await env.emitter.emit(TYPES.CHAT_CHANGED, env.ctx.chatId);
await E.ready();
await flushUI();
T.eq('切换聊天关闭已打开的确认框', realignDialog.open, false);
document.getElementById('dr-realign-accept').click();
await flushUI();
T.eq('旧聊天确认按钮不能提交到新聊天', realignCalls.filter(Boolean).length, 0);

for (const switchBack of [false, true]) {
    await prepareRealignment();
    const delayedPreview = previewCurrent();
    let resolvePreview;
    previewRealign = () => new Promise(resolve => { resolvePreview = resolve; });
    realignButton.click();
    await flushUI();
    env.ctx.chatId = 'other-ui-chat';
    await env.emitter.emit(TYPES.CHAT_CHANGED, env.ctx.chatId);
    await E.ready();
    await flushUI();
    if (switchBack) {
        env.ctx.chatId = originalChatId;
        await env.emitter.emit(TYPES.CHAT_CHANGED, env.ctx.chatId);
        await E.ready();
        await flushUI();
    }
    resolvePreview(delayedPreview);
    await flushUI();
    T.eq(switchBack ? '切走再切回也不打开过期预览' : '预览期间切换聊天不弹旧确认', realignDialog.open, false);
    T.eq(switchBack ? '切回后的过期预览零提交' : '跨聊天过期预览零提交', realignCalls.filter(Boolean).length, 0);
    if (switchBack) T.ok('切回后不会把过期预览提示成已保存', /已变化/.test(document.getElementById('dr-pool-msg').textContent));
}
window.__baobaodaiApp = originalApp;

process.exit(T.report('百宝袋 · 面板投送状态回归') ? 1 : 0);

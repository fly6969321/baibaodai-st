import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupDom, createContext, installFetch, makeRunner, userMsg, botMsg } from './harness.mjs';

const EXT = process.argv[2];
if (!EXT) throw Error('用法: node test_source_compat.mjs <扩展目录绝对路径>');
const mod = name => import(pathToFileURL(path.resolve(EXT, name)).href);
const [H, C, S, P, X] = await Promise.all(['host.js', 'config.js', 'state.js', 'pool.js', 'context.js'].map(mod));
const T = makeRunner();
const OPENING = '他把伞放在门边，抬头说：“进来吧。”';
const LATER_REPLY = '后面那轮回复里，他已经把信封交给了你。';
const CATEGORIES = ['plot', 'emotion', 'nsfw'];
let sequence = 0;

function job(generationId = '') {
    return { chatId: H.chatKey(), epoch: S.epoch, generationId, deadline: Date.now() + 10000, cancelled: false };
}

function replaceOpening(source, opening) {
    const marker = '【第一楼开场】\n';
    const start = source.text.indexOf(marker);
    if (start < 0) throw Error('测试夹具缺少开场段');
    const contentStart = start + marker.length;
    const next = source.text.indexOf('\n\n【聊天开场设定】\n', contentStart);
    const text = source.text.slice(0, contentStart) + opening + (next < 0 ? '' : source.text.slice(next));
    const legacy = Object.assign({}, source, { text, fingerprint: H.hash(text), capturedAt: 1000 });
    delete legacy.schemaVersion;
    delete legacy.sections;
    delete legacy.opening;
    return legacy;
}

async function fixture(options = {}) {
    S.cancelAll();
    S.jobs.clear();
    S.bumpEpoch();
    S.setDiagnostic('');
    setupDom();
    const opening = botMsg(options.currentOpening || OPENING);
    if (options.hiddenOpening) opening.is_system = true;
    const env = createContext({
        chatId: 'source-compat-' + (++sequence),
        chat: [opening, userMsg('用户随后问起了那封信。'), botMsg(LATER_REPLY)],
        characters: [{
            name: '方亦楷', description: '冷淡的建筑师', personality: '嘴硬', scenario: '雨夜的事务所',
            first_mes: OPENING, avatar: 'f.png',
        }],
        chatMetadata: { scenario: '固定的本聊天场景：雨夜门口。' },
    });
    env.ctx.extensionSettings.baobaodai = Object.assign({
        eyeApiUrl: 'https://relay.test/v1', eyeApiKey: 'test-key', eyeModel: 'test-model',
        coordEnabled: false, chimeEnabled: true, chimeMode: 'pool', poolModeVersion: 1,
        chimeInjectCount: 2, poolUseContext: false, poolAutoInit: false,
        poolPlotOn: true, poolEmotionOn: true, poolNsfwOn: true, poolTotalCount: 394,
    }, options.cfg);
    C.loadCfg();
    const calls = installFetch(options.plan || {});
    const fresh = await X.openingSource(job(), H.messages());
    const oldOpening = (options.oldOpening === undefined ? OPENING + '\n<draw>旧版保留的绘图提示词</draw>' : options.oldOpening).slice(0, 5000);
    const oldSource = replaceOpening(fresh, oldOpening);
    if (options.identity !== undefined) oldSource.identity = options.identity;
    const cards = Array.from({ length: 394 }, (_, i) => {
        const category = CATEGORIES[i % CATEGORIES.length];
        const card = {
            id: 'original-' + (i + 1), format: 'slip-v1', title: '', hook: '原有纸条' + (i + 1),
            category, kind: category, status: i < 17 ? 'used' : i < 20 ? 'discarded' : 'available', createdAt: 100 + i,
        };
        if (card.status === 'used') Object.assign(card, { usedAt: 10000 + i, generationKey: 'historical-generation-' + i });
        if (card.status === 'discarded') card.discardedAt = 20000 + i;
        return card;
    });
    const targets = Object.fromEntries(CATEGORIES.map(category => [category,
        cards.filter(card => card.category === category).length + (options.partial ? 1 : 0)]));
    const history = [
        { mode: 'pool', status: 'delivered', cards: H.clone(cards.slice(0, 3)), round: 4, deliveredAt: 12345, generationKey: 'old-delivery' },
        { mode: 'pool', status: 'fulfilled', cards: H.clone(cards.slice(3, 5)), round: 7, deliveredAt: 23456, confirmedAt: 34567 },
    ];
    env.ctx.chatMetadata.baobaodai = {
        schemaVersion: 3, dynamicMigrated: true, revision: 7, lastDrawAt: 0, coordAt: 0,
        tone: '保持本局原有偏好', history, coordLog: [], candidates: [], activeCards: [], floatStage: 'done', floatAt: -1,
        pool: {
            schema: 1, owner: options.owner || H.chatKey(), source: oldSource, cards, targets, nextId: 395,
            status: options.status || 'stale', error: '旧版本记录：开场正文变化，暂时停用', pending: null, autoAttempted: true,
            lastBuild: { requested: 400, accepted: 394, calls: 1 },
        },
    };
    return Object.assign(env, {
        calls, fresh, oldSource, oldOpening,
        originalCards: JSON.stringify(cards), originalHistory: JSON.stringify(history),
    });
}

function counts() {
    const cards = S.readState().pool.cards;
    return { total: cards.length, used: cards.filter(card => card.status === 'used').length,
        available: cards.filter(card => card.status === 'available').length,
        reserved: cards.filter(card => card.status === 'reserved').length,
        discarded: cards.filter(card => card.status === 'discarded').length };
}

function assertPreserved(env, prefix = '') {
    T.eq(prefix + '394张原库存逐字保留', JSON.stringify(S.readState().pool.cards), env.originalCards);
    T.eq(prefix + '已投和手动确认历史逐字保留', JSON.stringify(S.readState().history), env.originalHistory);
    T.eq(prefix + '不把历史used清零', counts().used, 17);
}

async function result(fn) {
    try {
        const value = await fn();
        return value && typeof value.ok === 'boolean' ? value : { ok: true, value };
    }
    catch (error) { return { ok: false, reason: error.message || String(error) }; }
}

async function test(name, fn) {
    T.group(name);
    try { await fn(); }
    catch (error) { T.ok('用例正常完成', false, error.stack || error.message); }
}

const mediaVariants = [
    ['完整image###块', OPENING + '\nimage###一段完整的画面提示词###'],
    ['完整draw块', OPENING + '\n<draw>旧版画面提示词\n包含多行</draw>'],
    ['HTML图片标签', OPENING + '\n<img src="images/opening.png" alt="a > b">'],
    ['Markdown图片', OPENING + '\n![开场插图](images/opening.png)'],
    ['混合图片附加物', OPENING + '\nimage###画面一###\n<draw>画面二</draw>\n<img src="x.png">\n![图](y.png)'],
];

for (const [name, oldOpening] of mediaVariants) await test('自动兼容：' + name, async () => {
    const env = await fixture({ oldOpening });
    const migrated = await result(() => P.validatePoolSource(job(), H.messages()));
    T.ok('完整附加物可自动兼容', migrated.ok, migrated.reason);
    T.eq('来源更新到规范化后的当前开场', S.readState().pool.source.fingerprint, env.fresh.fingerprint);
    T.eq('满目标旧池恢复ready', S.readState().pool.status, 'ready');
    T.eq('清除旧stale错误', S.readState().pool.error, '');
    assertPreserved(env);
    T.eq('来源兼容不调用API', env.calls.length, 0);
});

await test('自动兼容保留未补齐目标', async () => {
    const env = await fixture({ partial: true });
    const migrated = await result(() => P.validatePoolSource(job(), H.messages()));
    T.ok('兼容迁移成功', migrated.ok, migrated.reason);
    T.eq('还有缺口恢复partial', S.readState().pool.status, 'partial');
    assertPreserved(env);
    T.eq('不自动付费补齐', env.calls.length, 0);
});

const exactLimitOpening = OPENING + '\n<draw>' + '图'.repeat(5000 - OPENING.length - '\n<draw></draw>'.length) + '</draw>';
for (const [name, oldOpening] of [
    ['5000字符边界即使标签闭合也不能推定完整', exactLimitOpening],
    ['截断draw块', OPENING + '\n<draw>' + '图'.repeat(6000)],
    ['截断image###块', OPENING + '\nimage###' + '图'.repeat(6000)],
    ['不完整Markdown图片', OPENING + '\n![开场图](images/'],
]) await test('保守拒绝自动迁移：' + name, async () => {
    const env = await fixture({ oldOpening });
    const migrated = await result(() => P.validatePoolSource(job(), H.messages()));
    T.ok('证据不足时拒绝自动改绑', !migrated.ok, migrated.reason);
    T.eq('旧来源指纹保留', S.readState().pool.source.fingerprint, env.oldSource.fingerprint);
    T.eq('旧池继续暂停', S.readState().pool.status, 'stale');
    assertPreserved(env);
    T.eq('不因不确定性调用API', env.calls.length, 0);
});

await test('已满目标的build入口同样兼容旧来源', async () => {
    const env = await fixture();
    const built = await P.buildPool({ confirmed: true });
    T.ok('开始/继续建池不会错误拒绝兼容旧来源', built.ok, built.reason);
    T.eq('build入口更新来源指纹', S.readState().pool.source.fingerprint, env.fresh.fingerprint);
    assertPreserved(env);
    T.eq('已满目标无需API', env.calls.length, 0);
});

await test('明确refill只付费补池，不为兼容多请求', async () => {
    const env = await fixture({ cfg: { poolTotalCount: 3 }, plan: {
        reply: '剧情|兼容后补入的新剧情纸条\n情感|兼容后补入的新情感纸条\nNSFW|移开目光后又靠近了半步',
    } });
    const built = await P.buildPool({ confirmed: true, refill: true });
    T.ok('补池入口允许已验证的兼容迁移', built.ok, built.reason);
    T.eq('refill入口更新来源指纹', S.readState().pool.source.fingerprint, env.fresh.fingerprint);
    T.eq('原394张全部原样留存', JSON.stringify(S.readState().pool.cards.slice(0, 394)), env.originalCards);
    T.eq('旧投放历史未改写', JSON.stringify(S.readState().history), env.originalHistory);
    T.eq('仅追加确认购买的三张', counts().total, 397);
    T.eq('兼容自身未增加API请求', env.calls.length, 1);
    T.ok('补池发送的是清理后的来源', !JSON.stringify(env.calls[0] && env.calls[0].body).includes('旧版保留的绘图提示词'));
});

for (const preview of [false, true]) await test('直接draw入口兼容，preview=' + preview, async () => {
    const env = await fixture();
    const j = await S.startJob('draw', 'source-compat-draw');
    let drawn;
    try { drawn = await result(() => P.drawPool(S.readState(), H.assistantRound(H.messages()), H.messages(), j, preview)); }
    finally { S.stop(j); S.jobs.delete(j); }
    T.ok('迁移后刷新revision再抽取，不触发自己的乐观锁', drawn.ok, drawn.reason);
    T.eq('draw入口更新来源指纹', S.readState().pool.source.fingerprint, env.fresh.fingerprint);
    T.eq('总库存保持394', counts().total, 394);
    T.eq('旧used数量保持17', counts().used, 17);
    T.eq('只按实际抽取情况预留', counts().reserved, preview ? 0 : 2);
    T.eq('兼容与盲抽不调用API', env.calls.length, 0);
});

for (const [name, mutate] of [
    ['角色描述', env => { env.ctx.characters[0].description += '，真实角色设定已经改变'; }],
    ['角色原始开场', env => { env.ctx.characters[0].first_mes += '角色卡内新增设定'; }],
    ['persona描述', env => { env.ctx.powerUserSettings.persona_description = '四十五岁，律师'; }],
    ['聊天场景', env => { env.ctx.chatMetadata.scenario = '真实场景已经改为白天机场。'; }],
    ['身份标识', env => { env.ctx.user_avatar = 'another-user.png'; }],
    ['聊天归属', env => { env.ctx.chatMetadata.baobaodai.pool.owner = 'c:another-owner'; }],
]) await test('真实来源变化不能借兼容恢复：' + name, async () => {
    const env = await fixture();
    mutate(env);
    const checked = await result(() => P.validatePoolSource(job(), H.messages()));
    T.ok('自动校验拒绝真实变化', !checked.ok, checked.reason);
    const preview = await result(() => P.realignPoolSource());
    T.ok('显式恢复也不能越过角色/身份/场景/归属校验', !preview.ok, preview.reason);
    T.eq('旧来源没有被悄悄改写', S.readState().pool.source.fingerprint, env.oldSource.fingerprint);
    assertPreserved(env);
    T.eq('所有拒绝路径均不调用API', env.calls.length, 0);
});

for (const refill of [false, true]) await test('build/refill对真实来源变化必须同等拒绝：' + refill, async () => {
    const env = await fixture();
    env.ctx.characters[0].description += '，另一套真实设定';
    const built = await P.buildPool({ confirmed: true, refill });
    T.ok('build/refill不能绕过来源检查', !built.ok, built.reason);
    assertPreserved(env);
    T.eq('来源不匹配时先拒绝，不调用API', env.calls.length, 0);
});

for (const partial of [false, true]) await test('隐藏首楼旧池经明确确认恢复，partial=' + partial, async () => {
    const env = await fixture({ hiddenOpening: true, oldOpening: LATER_REPLY, partial });
    const checked = await result(() => P.validatePoolSource(job(), H.messages()));
    T.ok('旧版错用后续回复不能自动替换', !checked.ok, checked.reason);
    const beforePreview = JSON.stringify(env.ctx.chatMetadata.baobaodai);
    const preview = await P.realignPoolSource();
    T.ok('提供可审阅的恢复预览', preview.ok && preview.confirmationRequired, preview.reason);
    T.eq('预览是只读操作', JSON.stringify(env.ctx.chatMetadata.baobaodai), beforePreview);
    T.eq('预览展示394张库存', preview.counts && preview.counts.total, 394);
    T.eq('预览保留已投计数', preview.counts && preview.counts.used, 17);
    T.eq('预览绑定当前聊天', preview.expectedChatId, H.chatKey());
    T.eq('预览绑定epoch', preview.expectedEpoch, S.epoch);
    T.eq('预览绑定当前revision', preview.expectedRevision, S.readState().revision);
    T.eq('预览绑定旧来源', preview.expectedSourceFingerprint, env.oldSource.fingerprint);
    T.eq('预览明确新来源', preview.freshFingerprint, env.fresh.fingerprint);
    const recovered = await P.realignPoolSource(Object.assign({}, preview, { confirmed: true }));
    T.ok('用户明确确认后无损恢复', recovered.ok, recovered.reason);
    T.eq('确认后来源切到真正首楼', S.readState().pool.source.fingerprint, env.fresh.fingerprint);
    T.eq('按原目标恢复ready或partial', S.readState().pool.status, partial ? 'partial' : 'ready');
    assertPreserved(env);
    T.eq('预览和恢复全程不调用API', env.calls.length, 0);
});

await test('真实开场改动必须经过显式确认', async () => {
    const env = await fixture({ oldOpening: OPENING, currentOpening: OPENING + '他随后补充了一句新的约定。' });
    const checked = await result(() => P.validatePoolSource(job(), H.messages()));
    T.ok('正文真实改动不自动接受', !checked.ok, checked.reason);
    const preview = await P.realignPoolSource();
    T.ok('只有开场改变时允许请求用户确认', preview.ok && preview.confirmationRequired, preview.reason);
    const recovered = await P.realignPoolSource(Object.assign({}, preview, { confirmed: true }));
    T.ok('明确确认后可重新绑定这段开场', recovered.ok, recovered.reason);
    assertPreserved(env);
    T.eq('重新绑定不等于重新付费建池', env.calls.length, 0);
});

await test('旧版长开场即使前5000字符相同仍须明确沿用', async () => {
    const longOpening = OPENING + '开场正文'.repeat(1400);
    const env = await fixture({ oldOpening: longOpening, currentOpening: longOpening });
    T.eq('旧快照与新快照的截断text指纹相同', env.oldSource.fingerprint, env.fresh.fingerprint);
    const checked = await result(() => P.validatePoolSource(job(), H.messages()));
    T.ok('缺少完整正文指纹时不自动认为相同', !checked.ok, checked.reason);
    const preview = await P.realignPoolSource();
    T.ok('可提供明确沿用预览', preview.ok && preview.confirmationRequired, preview.reason);
    T.eq('预览包含当前完整开场指纹', preview.freshOpeningFingerprint, H.hash(longOpening));
    T.eq('预览包含完整长度', preview.freshOpeningLength, longOpening.length);
    const recovered = await P.realignPoolSource({ ...preview, confirmed: true });
    T.ok('明确确认后可升级为完整指纹快照', recovered.ok, recovered.reason);
    T.eq('保存完整开场指纹', S.readState().pool.source.opening && S.readState().pool.source.opening.fullFingerprint, H.hash(longOpening));
    assertPreserved(env);
    T.eq('长开场恢复不调用API', env.calls.length, 0);
});

await test('结构化长开场仅5000字符后的正文改变也必须确认', async () => {
    const longOpening = OPENING + '开场正文'.repeat(1400);
    const env = await fixture({ currentOpening: longOpening });
    env.ctx.chatMetadata.baobaodai.pool.source = H.clone(env.fresh);
    env.ctx.chat[0].mes += '五千字符之后真正新增的一句话。';
    const fresh = await X.openingSource(job(), H.messages());
    T.eq('截断text指纹没有改变', fresh.fingerprint, env.fresh.fingerprint);
    T.ok('完整开场指纹确实改变', fresh.opening.fullFingerprint !== env.fresh.opening.fullFingerprint);
    const checked = await result(() => P.validatePoolSource(job(), H.messages()));
    T.ok('不能仅凭截断text相同通过exact', !checked.ok, checked.reason);
    T.eq('自动拒绝后保留旧完整指纹', S.readState().pool.source.opening.fullFingerprint, env.fresh.opening.fullFingerprint);
    const preview = await P.realignPoolSource();
    T.ok('正文尾部差异可明确请求沿用', preview.ok && preview.confirmationRequired, preview.reason);
    const recovered = await P.realignPoolSource({ ...preview, confirmed: true });
    T.ok('明确确认后更新完整正文指纹', recovered.ok, recovered.reason);
    T.eq('新完整指纹已保存', S.readState().pool.source.opening.fullFingerprint, fresh.opening.fullFingerprint);
    assertPreserved(env);
    T.eq('长开场尾部恢复不调用API', env.calls.length, 0);
});

await test('长开场预览后仅尾部变化也使确认失效', async () => {
    const longOpening = OPENING + '开场正文'.repeat(1400);
    const env = await fixture({ oldOpening: LATER_REPLY, currentOpening: longOpening });
    const preview = await P.realignPoolSource();
    T.ok('先得到有效预览', preview.ok && preview.confirmationRequired, preview.reason);
    env.ctx.chat[0].mes += '预览之后新增在尾部的正文。';
    const before = JSON.stringify(env.ctx.chatMetadata.baobaodai);
    const recovered = await P.realignPoolSource({ ...preview, confirmed: true });
    T.ok('完整正文变化使预览失效', !recovered.ok, recovered.reason);
    T.ok('旧卡池快照保持不变', JSON.stringify(env.ctx.chatMetadata.baobaodai) === before);
    T.eq('过期长开场确认不调用API', env.calls.length, 0);
});

const races = [
    ['切到另一聊天', env => { env.ctx.chatId += '-other'; env.ctx.chatMetadata = { untouched: '新聊天数据' }; }],
    ['切走再回来epoch已变', () => { S.bumpEpoch(); }],
    ['用户修改状态revision已变', async () => { await S.localEdit(s => { s.tone += '新偏好'; }); }],
    ['旧source指纹已换', env => { env.ctx.chatMetadata.baobaodai.pool.source = replaceOpening(env.oldSource, '另一份旧来源正文'); }],
    ['实时开场freshFingerprint已换', env => { env.ctx.chat[0].mes += '确认期间新改的一句正文。'; }],
    ['实时persona变化', env => { env.ctx.powerUserSettings.persona_description += '，确认期间身份信息改变'; }],
    ['旧source身份变化但指纹不变', env => { env.ctx.chatMetadata.baobaodai.pool.source.identity = 'foreign-identity'; }],
    ['池owner变化但revision不变', env => { env.ctx.chatMetadata.baobaodai.pool.owner = 'c:foreign-owner'; }],
];
for (const [name, mutate] of races) await test('恢复确认拒绝过期预览：' + name, async () => {
    const env = await fixture({ hiddenOpening: true, oldOpening: LATER_REPLY });
    const originalMetadata = env.ctx.chatMetadata;
    const preview = await P.realignPoolSource();
    T.ok('先得到有效预览', preview.ok && preview.confirmationRequired, preview.reason);
    await mutate(env);
    const before = JSON.stringify(env.ctx.chatMetadata);
    const previousBefore = JSON.stringify(originalMetadata);
    const recovered = await result(() => P.realignPoolSource(Object.assign({}, preview, { confirmed: true })));
    T.ok('过期或跨聊天确认被拒绝', !recovered.ok, recovered.reason);
    T.eq('拒绝后当前聊天数据不变', JSON.stringify(env.ctx.chatMetadata), before);
    T.eq('拒绝后原聊天数据不变', JSON.stringify(originalMetadata), previousBefore);
    T.eq('过期确认不调用API', env.calls.length, 0);
});

await test('确认等待来源展开期间revision变化也拒绝', async () => {
    const env = await fixture({ hiddenOpening: true, oldOpening: LATER_REPLY });
    const preview = await P.realignPoolSource();
    let enteredResolve, release;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    env.ctx.characters[0].shallow = true;
    env.ctx.unshallowCharacter = async () => { enteredResolve(); await waiting; env.ctx.characters[0].shallow = false; };
    const pending = result(() => P.realignPoolSource(Object.assign({}, preview, { confirmed: true })));
    await Promise.race([entered, pending.then(() => { throw Error('确认没有进入实时来源展开，无法验证等待期间竞态'); })]);
    env.ctx.chatMetadata.baobaodai.revision++;
    env.ctx.chatMetadata.baobaodai.tone = '等待期间的新偏好';
    const before = JSON.stringify(env.ctx.chatMetadata.baobaodai);
    release();
    const recovered = await pending;
    T.ok('提交前重新检查revision', !recovered.ok, recovered.reason);
    T.eq('不覆盖等待期间的新状态', JSON.stringify(env.ctx.chatMetadata.baobaodai), before);
    T.eq('竞态拒绝不调用API', env.calls.length, 0);
});

for (const [name, mutate] of [
    ['最终来源展开时revision变化', env => { env.ctx.chatMetadata.baobaodai.revision++; env.ctx.chatMetadata.baobaodai.tone = '最后提交期间的新偏好'; }],
    ['最终来源展开时开场正文变化', env => { env.ctx.chat[0].mes += '最后提交期间新增的真实剧情。'; }],
]) await test('最终提交再次检查：' + name, async () => {
    const env = await fixture({ hiddenOpening: true, oldOpening: LATER_REPLY });
    const preview = await P.realignPoolSource();
    let reads = 0, enteredResolve, release;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    env.ctx.characters[0].shallow = true;
    env.ctx.unshallowCharacter = async () => {
        if (++reads === 2) { enteredResolve(); await waiting; env.ctx.characters[0].shallow = false; }
    };
    const pending = result(() => P.realignPoolSource({ ...preview, confirmed: true }));
    await Promise.race([entered, pending.then(() => { throw Error('确认未进入第二次来源展开，无法验证最终提交竞态'); })]);
    mutate(env);
    const before = JSON.stringify(env.ctx.chatMetadata.baobaodai);
    release();
    const recovered = await pending;
    T.ok('最终提交拒绝等待期间的变化', !recovered.ok, recovered.reason);
    T.ok('不会覆盖较新的状态或改写旧来源', JSON.stringify(env.ctx.chatMetadata.baobaodai) === before);
    T.eq('最终检查拒绝不调用API', env.calls.length, 0);
});

await test('确认最终提交持有任务锁', async () => {
    const env = await fixture({ hiddenOpening: true, oldOpening: LATER_REPLY });
    const preview = await P.realignPoolSource();
    let reads = 0, enteredResolve, release;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    env.ctx.characters[0].shallow = true;
    env.ctx.unshallowCharacter = async () => {
        if (++reads === 2) { enteredResolve(); await waiting; env.ctx.characters[0].shallow = false; }
    };
    const pending = result(() => P.realignPoolSource({ ...preview, confirmed: true }));
    await Promise.race([entered, pending.then(() => { throw Error('确认未进入第二次来源展开，无法验证任务锁'); })]);
    let concurrentJob;
    const concurrent = await result(async () => { concurrentJob = await S.startJob('draw', 'concurrent-recovery'); });
    if (concurrentJob) { S.stop(concurrentJob); S.jobs.delete(concurrentJob); }
    T.ok('恢复完成前拒绝并发抽卡任务', !concurrent.ok, concurrent.reason);
    release();
    const recovered = await pending;
    T.ok('恢复本身仍可完成', recovered.ok, recovered.reason);
    T.eq('结束后清理任务锁', Array.from(S.jobs).filter(j => !j.cancelled).length, 0);
    assertPreserved(env);
    T.eq('任务锁不触发API', env.calls.length, 0);
});

process.exitCode = T.report('百宝袋 0.5.18 · 旧来源兼容与无损恢复') ? 1 : 0;

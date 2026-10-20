import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupDom, createContext, installFetch, makeRunner, userMsg, botMsg } from './harness.mjs';

const EXT = process.argv[2];
if (!EXT) throw Error('用法: node test_source_compat.mjs <扩展目录绝对路径>');
const mod = name => import(pathToFileURL(path.resolve(EXT, name)).href);
const [H, C, S, P, X, Lore] = await Promise.all(['host.js', 'config.js', 'state.js', 'pool.js', 'context.js', 'pool-lore.js'].map(mod));
const T = makeRunner();
let sequence = 0;

function job() { return { chatId: H.chatKey(), epoch: S.epoch, deadline: Date.now() + 10000, cancelled: false }; }
async function fixture({ legacy = false } = {}) {
    S.cancelAll(); S.jobs.clear(); S.bumpEpoch(); S.setDiagnostic(''); setupDom();
    const env = createContext({
        chatId: 'source-compat-' + (++sequence),
        chat: [botMsg('开场剧情'), userMsg('随后发生的对话'), botMsg('后续回复')],
        characters: [{ name: '角色甲', description: '冷静的建筑师', personality: '谨慎', scenario: '旧场景', first_mes: '旧开场白', avatar: 'f.png' }],
        chatMetadata: { scenario: '聊天场景' },
    });
    env.ctx.extensionSettings.baobaodai = {
        eyeApiUrl: 'https://relay.test/v1', eyeApiKey: 'test-key', eyeModel: 'test-model',
        coordEnabled: false, chimeEnabled: true, chimeMode: 'pool', poolModeVersion: 1,
        chimeInjectCount: 2, poolUseContext: false, poolAutoInit: false,
        poolPlotOn: true, poolEmotionOn: true, poolNsfwOn: false, poolTotalCount: 6,
    };
    C.loadCfg();
    const calls = installFetch({ reply: '剧情|门外多了一双湿漉漉的鞋子\n情感|他把热茶推到你手边' });
    const source = await X.openingSource(job());
    const old = await X.legacyPoolSource(job());
    let saved = legacy ? old : source;
    if (legacy) saved = { ...saved, schemaVersion: 2 };
    const cards = Array.from({ length: 6 }, (_, i) => ({
        id: 'old-' + i, format: 'slip-v1', hook: '旧纸条' + i, category: i % 2 ? 'emotion' : 'plot',
        kind: i % 2 ? 'emotion' : 'plot', status: i === 0 ? 'used' : 'available',
    }));
    env.ctx.chatMetadata.baobaodai = {
        schemaVersion: 3, revision: 4, tone: '', history: [{ mode: 'pool', status: 'delivered', cards: [cards[0]] }],
        coordLog: [], candidates: [], activeCards: [], floatStage: 'done', floatAt: -1,
        pool: { schema: 1, owner: H.chatKey(), source: saved, cards, targets: { plot: 3, emotion: 3 },
            nextId: 7, status: 'stale', error: '旧版本来源提示', pending: null, autoAttempted: true },
    };
    return { ...env, calls, source, old: saved, cards: structuredClone(cards) };
}

async function test(name, fn) {
    T.group(name);
    try { await fn(); } catch (error) { T.ok('用例正常完成', false, error.stack || error.message); }
}
function preserved(env) {
    T.eq('保留全部纸条及状态', JSON.stringify(S.readState().pool.cards), JSON.stringify(env.cards));
    T.eq('保留已投记录', S.readState().history.length, 1);
    T.eq('已投数量保留', S.readState().pool.cards.filter(card => card.status === 'used').length, 1);
}

await test('新来源快照只保存角色基础设定和user设定', async () => {
    const env = await fixture();
    const serialized = JSON.stringify(env.source);
    for (const excluded of ['开场剧情', '旧开场白', '旧场景', '聊天场景']) T.ok('排除' + excluded, !serialized.includes(excluded));
    T.ok('有稳定来源版本', env.source.schemaVersion === 3);
});

for (const [name, mutate] of [
    ['聊天首楼', env => { env.ctx.chat[0].mes = '被总结插件隐藏或替换的内容'; }],
    ['角色卡开场白', env => { env.ctx.characters[0].first_mes = '新开场白'; }],
    ['角色卡场景', env => { env.ctx.characters[0].scenario = '新角色场景'; }],
    ['聊天场景覆盖', env => { env.ctx.chatMetadata.scenario = '新聊天场景'; }],
]) await test('不校验' + name, async () => {
    const env = await fixture({ legacy: true }); mutate(env);
    await P.validatePoolSource(job(), H.messages());
    T.eq('旧池恢复可用', S.readState().pool.status, 'ready');
    T.eq('快照迁移到精简来源', S.readState().pool.source.fingerprint, env.source.fingerprint);
    preserved(env);
    T.eq('兼容迁移不调用API', env.calls.length, 0);
});

for (const [name, mutate] of [
    ['角色描述', env => { env.ctx.characters[0].description += '，设定已变'; }],
    ['角色性格', env => { env.ctx.characters[0].personality += '，设定已变'; }],
    ['user设定', env => { env.ctx.powerUserSettings.persona_description += '，设定已变'; }],
]) await test('角色/user来源改变时保留并暂停旧池：' + name, async () => {
    const env = await fixture(); mutate(env);
    let rejected = false;
    try { await P.validatePoolSource(job(), H.messages()); } catch (_) { rejected = true; }
    T.ok('阻止不同设定继续使用旧池', rejected);
    T.eq('旧池暂停', S.readState().pool.status, 'stale');
    T.ok('错误不泄露设定正文', !S.readState().pool.error.includes('设定已变'));
    preserved(env);
    T.eq('校验失败不调用API', env.calls.length, 0);
});

await test('建池请求包含角色绑定世界书，并排除开场和场景', async () => {
    const env = await fixture();
    env.ctx.extensionSettings.baobaodai.poolTotalCount = 12;
    C.loadCfg();
    env.ctx.characters[0].data = { extensions: { world: '角色书' } };
    env.ctx.loadWorldInfo = async name => ({ entries: {
        a: { uid: 1, comment: '角色设定补充', content: '角色书内的关键背景。', constant: true },
        b: { uid: 2, comment: '勿用', content: '禁用的条目', disable: true, constant: true },
    } });
    const built = await P.buildPool({ confirmed: true });
    T.ok('建池成功', built.ok, built.reason);
    T.ok('请求带入绑定世界书内容', JSON.stringify(env.calls[0] && env.calls[0].body).includes('角色书内的关键背景'));
    T.ok('请求排除角色/聊天场景及开场白', !JSON.stringify(env.calls[0] && env.calls[0].body).includes('旧开场白')
        && !JSON.stringify(env.calls[0] && env.calls[0].body).includes('旧场景')
        && !JSON.stringify(env.calls[0] && env.calls[0].body).includes('聊天场景'));
    T.ok('禁用世界书条目不发送', !JSON.stringify(env.calls[0] && env.calls[0].body).includes('禁用的条目'));
    T.eq('本次只发一个API请求', env.calls.length, 1);
});

await test('筛选角色绑定与关键词相关的世界书条目', async () => {
    const result = await Lore.collectPoolLore({
        characters: [{ fileName: 'f', tags: ['builder'] }],
        settings: { caseSensitive: false, matchWholeWords: false },
        books: [{ name: '角色书', bound: true }, { name: '全局书', bound: false }],
        load: async name => ({ entries: name === '角色书' ? {
            bound: { uid: 1, content: '角色绑定条目。', key: 'never matches' },
            filteredCharacter: { uid: 2, content: '其他角色条目。', constant: true, characterFilter: { names: ['other'] } },
            disabled: { uid: 3, content: '禁用条目。', constant: true, disable: true },
        } : {
            relevant: { uid: 4, content: '建筑师相关条目。', key: 'architect' },
            unrelated: { uid: 5, content: '无关条目。', key: 'spaceship' },
            selective: { uid: 6, content: '未满足次要关键词。', key: 'architect', keysecondary: 'night', selective: true },
        } }),
    }, '角色是一位architect，白天工作。');
    T.ok('保留角色绑定书条目', result.text.includes('角色绑定条目'));
    T.ok('保留匹配角色设定的全局书条目', result.text.includes('建筑师相关条目'));
    for (const omitted of ['其他角色条目', '禁用条目', '无关条目', '未满足次要关键词']) {
        T.ok('排除' + omitted, !result.text.includes(omitted));
    }
});

process.exitCode = T.report('百宝袋 · 来源校验与角色世界书') ? 1 : 0;

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupDom, createContext, botMsg, userMsg } from './harness.mjs';

const root = process.argv[2] || fileURLToPath(new URL('..', import.meta.url));
const mod = name => import(pathToFileURL(path.join(root, name)).href);
const [H, C, S, P, Context] = await Promise.all(['host.js', 'config.js', 'state.js', 'pool.js', 'context.js'].map(mod));
setupDom();
globalThis.fetch = async () => { throw Error('This test must never call an API'); };

function selectedState() {
    const cards = ['p-1', 'p-2', 'p-3'].map((id, i) => ({ id, hook: 'A local story suggestion ' + i, category: 'plot', status: i ? 'available' : 'reserved' }));
    const activeCards = [{ id: cards[0].id, hook: cards[0].hook, category: 'plot' }];
    return {
        schemaVersion: 3, dynamicMigrated: true, revision: 7, lastDrawAt: 1, coordAt: 1,
        activeCards, floatStage: 'active', floatAt: 1,
        history: [{ mode: 'pool', cards: structuredClone(activeCards), status: 'active', round: 1, origin: 'manual' }],
        pool: { ...S.newPool(), cards, status: 'ready', pending: { ids: ['p-1'], origin: 'manual', key: '', at: 123, lastFailure: 'no-reply' } },
    };
}

function env(state = selectedState(), cfg = {}, context = {}) {
    const h = createContext({
        chat: [botMsg('Opening'), userMsg('Question')], chatId: 'pool-state-test',
        chatMetadata: { baobaodai: state }, ...context,
    });
    h.ctx.extensionSettings.baobaodai = { chimeMode: 'pool', poolModeVersion: 1, chimeEnabled: true,
        coordEnabled: false, poolUseContext: false, chimeLifeMode: 'once', chimeN: 1, ...cfg };
    C.loadCfg();
    return { ...h, job: generationId => ({ generationId, chatId: H.chatKey(), epoch: S.epoch, deadline: Date.now() + 10000 }) };
}

const statusCount = (s, status) => s.pool.cards.filter(c => c.status === status).length;
let scenarios = 0;
async function test(name, fn) {
    try { await fn(); scenarios++; }
    catch (e) { console.error('FAILED:', name); throw e; }
}

await test('valid retry preserves selected IDs and failure metadata', () => {
    const state = selectedState(); state.floatStage = 'faded';
    env(state);
    const s = S.readState();
    assert.deepEqual(s.pool.pending.ids, ['p-1']);
    assert.equal(s.pool.pending.at, 123);
    assert.equal(s.pool.pending.lastFailure, 'no-reply');
    assert.equal(s.floatStage, 'active');
    assert.equal(statusCount(s, 'reserved'), 1);
    assert.equal(s.history[0].status, 'active');
});

await test('valid legacy reservation without history restores only an active record', () => {
    const state = selectedState(); state.history = [];
    delete state.pool.pending.origin;
    env(state);
    const s = S.readState();
    assert.equal(s.history.length, 1);
    assert.equal(s.history[0].status, 'active');
    assert.equal(s.history[0].recovered, true);
    assert.equal(s.history[0].origin, 'legacy');
    assert.equal(s.pool.pending.origin, 'legacy');
    assert.equal(statusCount(s, 'used'), 0);
    assert.deepEqual(s.pool.pending.ids, ['p-1']);
});

await test('pending without active cards is released', () => {
    const state = selectedState(); state.activeCards = [];
    env(state);
    const s = S.readState();
    assert.equal(s.pool.pending, null);
    assert.equal(s.floatStage, 'done');
    assert.equal(statusCount(s, 'reserved'), 0);
    assert.equal(statusCount(s, 'available'), 3);
    assert.equal(s.history[0].status, 'invalidated');
});

await test('orphan reserved card is released and withdrawn', () => {
    const state = selectedState(); state.pool.pending = null;
    env(state);
    const s = S.readState();
    assert.equal(statusCount(s, 'reserved'), 0);
    assert.equal(s.activeCards.length, 0);
    assert.equal(s.floatStage, 'done');
    assert.equal(s.history[0].status, 'invalidated');
});

await test('missing or duplicate pending IDs cannot become delivered', () => {
    for (const ids of [['p-1', 'missing'], ['p-1', 'p-1'], [], 'p-1']) {
        const state = selectedState(); state.pool.pending.ids = ids;
        env(state);
        assert.equal(S.consumePool(state, '', false), false);
        const s = S.readState();
        assert.equal(s.pool.pending, null);
        assert.equal(statusCount(s, 'used'), 0);
        assert.equal(statusCount(s, 'reserved'), 0);
        assert.equal(s.history[0].status, 'invalidated');
    }
});

await test('available card cannot be consumed through a stale pending reference', async () => {
    const state = selectedState(); state.pool.cards[0].status = 'available';
    const h = env(state); state.pool.pending.key = H.chatKey() + ':g1';
    assert.equal(S.consumePool(state, H.chatKey() + ':g1', false), false);
    await P.settlePool({ chatId: H.chatKey(), generationId: 'g1', ok: true });
    const s = S.readState();
    assert.equal(statusCount(s, 'used'), 0);
    assert.equal(s.history[0].status, 'invalidated');
    assert.equal(h.ctx.chatMetadata.baobaodai.history[0].status, 'active');
});

await test('mismatched active IDs release the entire invalid reservation', () => {
    const state = selectedState(); state.activeCards[0].id = 'p-2';
    env(state);
    const s = S.readState();
    assert.equal(s.pool.pending, null);
    assert.equal(s.activeCards.length, 0);
    assert.equal(statusCount(s, 'reserved'), 0);
});

await test('unrelated orphan does not discard a valid retry', () => {
    const state = selectedState(); state.pool.cards[1].status = 'reserved';
    env(state);
    const s = S.readState();
    assert.deepEqual(s.pool.pending.ids, ['p-1']);
    assert.equal(s.pool.cards[0].status, 'reserved');
    assert.equal(s.pool.cards[1].status, 'available');
});

await test('consumption targets the history with matching IDs, not the last record', () => {
    const state = selectedState(); state.pool.pending.key = 'attempt';
    state.history.push({ mode: 'dynamic', status: 'active', cards: [{ hook: 'Another record' }] });
    assert.equal(S.consumePool(state, 'wrong-attempt', false), false);
    assert.equal(S.consumePool(state, 'attempt', false), true);
    assert.equal(state.history[0].status, 'delivered');
    assert.equal(state.history[0].generationKey, 'attempt');
    assert.equal(state.history[1].status, 'active');
    assert.equal(statusCount(state, 'used'), 1);
    assert.equal(state.pool.pending, null);
    assert.equal(S.consumePool(state, 'attempt', false), false);
});

await test('direct consumption requires a corresponding active pool history', () => {
    const state = selectedState(); state.history = [];
    assert.equal(S.consumePool(state, 'manual-confirmation', true), false);
    assert.equal(statusCount(state, 'used'), 0);
});

await test('partial failed reply remains retryable despite a changed assistant round', async () => {
    const h = env();
    await P.bindPool(h.job('g1'));
    await P.settlePool({ chatId: H.chatKey(), generationId: 'g1', ok: false, reason: 'interrupted' });
    h.ctx.chat.push(botMsg('Partial reply'));
    await S.lifecycle(H.messages(), h.job('g2'));
    let s = S.readState();
    assert.deepEqual(s.pool.pending.ids, ['p-1']);
    assert.equal(s.pool.pending.key, '');
    assert.equal(s.activeCards.length, 1);
    assert.equal(s.floatStage, 'active');
    await P.bindPool(h.job('g2'));
    await P.settlePool({ chatId: H.chatKey(), generationId: 'g2', ok: true });
    s = S.readState();
    assert.equal(s.pool.pending, null);
    assert.equal(statusCount(s, 'used'), 1);
    assert.equal(s.history[0].status, 'delivered');
    assert.equal(s.activeCards.length, 0);
    assert.equal(s.floatStage, 'done');
    assert.equal(s.history[0].confirmedAt, undefined);
});

await test('missing chime channel cannot bind or settle a reservation', async () => {
    const h = env();
    await P.bindPool(h.job('g1'), false);
    await P.settlePool({ chatId: H.chatKey(), generationId: 'g1', ok: true });
    const s = S.readState();
    assert.equal(s.pool.pending.key, '');
    assert.equal(statusCount(s, 'reserved'), 1);
    assert.equal(statusCount(s, 'used'), 0);
});

await test('round rollback does not retire an unacknowledged reservation', async () => {
    const state = selectedState(); state.floatAt = 20;
    const h = env(state);
    await S.lifecycle(H.messages(), h.job('g1'));
    const s = S.readState();
    assert.equal(s.floatAt, 20);
    assert.equal(s.floatStage, 'active');
    assert.equal(s.pool.pending.ids[0], 'p-1');
});

await test('explicit manual confirmation remains fulfilled', () => {
    const state = selectedState();
    assert.equal(S.archiveActive(state, 'fulfilled'), true);
    assert.equal(state.history[0].status, 'fulfilled');
    assert.ok(state.history[0].confirmedAt);
    assert.equal(state.pool.cards[0].generationKey, 'manual-confirmation');
    assert.equal(statusCount(state, 'used'), 1);
});

await test('pool reset marks retained history as belonging to an earlier pool', async () => {
    const state = selectedState();
    S.consumePool(state, 'attempt', true);
    state.activeCards = []; state.floatStage = 'done';
    state.history.push({ mode: 'dynamic', status: 'retired', cards: [{ hook: 'Dynamic history' }] });
    env(state);
    await P.resetPool(true, H.chatKey());
    const s = S.readState();
    assert.equal(s.pool.cards.length, 0);
    assert.equal(s.history[0].status, 'delivered');
    assert.equal(s.history[0].previousPool, true);
    assert.equal(s.history[1].previousPool, undefined);
});

await test('a reused card ID does not change history from an earlier pool', () => {
    const state = selectedState();
    const previous = structuredClone(state.history[0]); previous.previousPool = true;
    state.history.push(previous);
    assert.equal(S.consumePool(state, 'new-attempt', true), true);
    assert.equal(state.history[0].status, 'delivered');
    assert.equal(previous.status, 'active');
});

await test('read repairs are persisted once by the next atomic change', async () => {
    const state = selectedState(); state.activeCards = [];
    const h = env(state);
    S.readState();
    assert.equal(h.stats.metadata, 0);
    assert.ok(h.ctx.chatMetadata.baobaodai.pool.pending);
    await S.change(() => {}, h.job('g1'));
    assert.equal(h.ctx.chatMetadata.baobaodai.pool.pending, null);
    assert.equal(h.ctx.chatMetadata.baobaodai.revision, 8);
    await S.change(() => {}, h.job('g2'));
    assert.equal(h.ctx.chatMetadata.baobaodai.revision, 8);
});

await test('legacy group owner migrates only within matching source metadata', async () => {
    const h = env(selectedState(), {}, {
        groupId: 'group-one', chatId: 'chat-one', groups: [{ id: 'group-one', members: ['f.png'] }],
    });
    assert.equal(H.legacyChatKey(), 'g:group-one');
    assert.equal(H.chatKey(), 'g:group-one:chat-one');
    const source = await Context.openingSource(h.job('g1'), H.messages());
    const raw = h.ctx.chatMetadata.baobaodai;
    raw.pool.owner = H.legacyChatKey(); raw.pool.source = source;
    raw.pool.pending.key = H.legacyChatKey() + ':old-attempt';
    await P.validatePoolSource(h.job('g1'), H.messages());
    const s = S.readState();
    assert.equal(s.pool.owner, H.chatKey());
    assert.equal(s.pool.pending.key, '');
    assert.equal(statusCount(s, 'reserved'), 1);
    assert.equal(s.history[0].status, 'active');
});

await test('legacy group migration rejects a mismatched source identity', async () => {
    const h = env(selectedState(), {}, {
        groupId: 'group-one', chatId: 'chat-two', groups: [{ id: 'group-one', members: ['f.png'] }],
    });
    const source = await Context.openingSource(h.job('g1'), H.messages());
    const raw = h.ctx.chatMetadata.baobaodai;
    raw.pool.owner = H.legacyChatKey(); raw.pool.source = { ...source, identity: 'another-persona' };
    await assert.rejects(P.validatePoolSource(h.job('g1'), H.messages()), /不匹配/);
    const s = S.readState();
    assert.equal(s.pool.owner, H.legacyChatKey());
    assert.equal(s.pool.status, 'stale');
    assert.equal(statusCount(s, 'used'), 0);
});

await test('a hidden opening can restore a wrongly stale pool without changing inventory or receipts', async () => {
    const state = selectedState();
    S.consumePool(state, 'earlier-delivery', true);
    state.activeCards = []; state.floatStage = 'done';
    const h = env(state);
    const raw = h.ctx.chatMetadata.baobaodai;
    raw.pool.owner = H.chatKey();
    raw.pool.source = await Context.openingSource(h.job('g1'), H.messages());
    raw.pool.targets = { plot: 3 };
    raw.pool.status = 'stale'; raw.pool.error = 'Old opening visibility error';
    const cards = structuredClone(raw.pool.cards), history = structuredClone(raw.history);
    h.ctx.chat[0].is_system = true;
    S.setDiagnostic('卡池与当前角色/user/开场不匹配，已撤下旧纸条；请明确重建');
    await P.validatePoolSource(h.job('g1'), H.messages());
    const s = S.readState();
    assert.equal(s.pool.status, 'ready');
    assert.equal(s.pool.error, '');
    assert.deepEqual(s.pool.cards, cards);
    assert.deepEqual(s.history, history);
    assert.equal(statusCount(s, 'used'), 1);
    assert.equal(S.getDiagnostic(), '');
});

await test('a matching stale pool with an unfilled quota recovers as partial without an API request', async () => {
    const state = selectedState();
    const h = env(state);
    const raw = h.ctx.chatMetadata.baobaodai;
    raw.pool.owner = H.chatKey();
    raw.pool.source = await Context.openingSource(h.job('g1'), H.messages());
    raw.pool.status = 'stale'; raw.pool.error = 'Old source mismatch';
    raw.pool.targets = { plot: 5, emotion: 1 };
    const cards = structuredClone(raw.pool.cards), history = structuredClone(raw.history);
    await P.validatePoolSource(h.job('g1'), H.messages());
    const s = S.readState();
    assert.equal(s.pool.status, 'partial');
    assert.equal(s.pool.error, '');
    assert.deepEqual(s.pool.cards, cards);
    assert.deepEqual(s.history, history);
    assert.deepEqual(s.pool.pending.ids, ['p-1']);
});

await test('source validation does not clear an unrelated API error', async () => {
    const h = env();
    const raw = h.ctx.chatMetadata.baobaodai;
    raw.pool.owner = H.chatKey();
    raw.pool.source = await Context.openingSource(h.job('g1'), H.messages());
    raw.pool.status = 'error'; raw.pool.error = 'API HTTP 500';
    await P.validatePoolSource(h.job('g1'), H.messages());
    const s = S.readState();
    assert.equal(s.pool.status, 'error');
    assert.equal(s.pool.error, 'API HTTP 500');
});

await test('actual source edits remain stale and diagnostics reveal only the changed section', async () => {
    const cases = [
        ['开场正文', ctx => { ctx.chat[0].mes = 'PRIVATE_SENTINEL opening'; }],
        ['角色卡', ctx => { ctx.characters[0].description = 'PRIVATE_SENTINEL character'; }],
        ['user设定', ctx => { ctx.name1 = 'PRIVATE_SENTINEL persona'; }],
        ['聊天场景', ctx => { ctx.chatMetadata.scenario = 'PRIVATE_SENTINEL scene'; }],
    ];
    for (const [label, edit] of cases) {
        const state = selectedState();
        S.consumePool(state, 'earlier-delivery', true);
        state.activeCards = []; state.floatStage = 'done';
        const h = env(state), raw = h.ctx.chatMetadata.baobaodai;
        raw.pool.owner = H.chatKey();
        raw.pool.source = await Context.openingSource(h.job('g1'), H.messages());
        raw.pool.status = 'stale'; raw.pool.error = 'Previous mismatch';
        const cards = structuredClone(raw.pool.cards), history = structuredClone(raw.history);
        edit(h.ctx);
        await assert.rejects(P.validatePoolSource(h.job('g1'), H.messages()), error => {
            assert.ok(error.message.includes(label));
            assert.equal(error.message.includes('PRIVATE_SENTINEL'), false);
            return true;
        });
        const s = S.readState();
        assert.equal(s.pool.status, 'stale');
        assert.ok(s.pool.error.includes(label));
        assert.equal(s.pool.error.includes('PRIVATE_SENTINEL'), false);
        assert.deepEqual(s.pool.cards, cards);
        assert.deepEqual(s.history, history);
    }
});

for (const origin of ['manual', 'automatic']) {
    await test(origin + ' draw keeps its origin through failure, binding, and delivery', async () => {
        const state = selectedState();
        state.pool.pending = null; state.pool.cards.forEach(card => { card.status = 'available'; });
        state.activeCards = []; state.floatStage = 'done'; state.history = [];
        const h = env(state, { chimeInjectCount: 1 }), raw = h.ctx.chatMetadata.baobaodai;
        const drawJob = h.job(origin === 'automatic' ? 'auto-attempt' : '');
        raw.pool.owner = H.chatKey();
        raw.pool.source = await Context.openingSource(drawJob, H.messages());
        const result = await P.drawPool(S.readState(), H.assistantRound(H.messages()), H.messages(), drawJob, false);
        assert.equal(result.ok, true);
        let s = S.readState();
        const ids = s.pool.pending.ids.slice();
        assert.equal(s.pool.pending.origin, origin);
        assert.equal(s.history[0].origin, origin);
        assert.equal(statusCount(s, 'reserved'), 1);
        await P.bindPool(h.job('reply-attempt'));
        await P.settlePool({ chatId: H.chatKey(), generationId: 'reply-attempt', ok: false, reason: 'interrupted' });
        s = S.readState();
        assert.equal(s.pool.pending.key, '');
        assert.equal(s.pool.pending.origin, origin);
        assert.equal(s.history[0].origin, origin);
        assert.deepEqual(s.pool.pending.ids, ids);
        await P.bindPool(h.job('retry-attempt'));
        s = S.readState();
        assert.equal(s.pool.pending.origin, origin);
        assert.deepEqual(s.pool.pending.ids, ids);
        await P.settlePool({ chatId: H.chatKey(), generationId: 'retry-attempt', ok: true });
        s = S.readState();
        assert.equal(s.pool.pending, null);
        assert.equal(s.history[0].origin, origin);
        assert.equal(s.history[0].status, 'delivered');
        assert.equal(statusCount(s, 'used'), 1);
    });
}

await test('legacy origin is never inferred from an empty or bound generation key', async () => {
    for (const key of ['', 'c:old-chat:old-attempt']) {
        const state = selectedState();
        delete state.pool.pending.origin; delete state.history[0].origin;
        state.pool.pending.key = key;
        const h = env(state);
        let s = S.readState();
        assert.equal(s.pool.pending.origin, 'legacy');
        assert.equal(s.history[0].origin, 'legacy');
        await P.bindPool(h.job('retry-attempt'));
        s = S.readState();
        assert.equal(s.pool.pending.origin, 'legacy');
        assert.equal(s.history[0].origin, 'legacy');
        assert.equal(statusCount(s, 'reserved'), 1);
    }
});

await test('restored history preserves an explicitly automatic pending origin', () => {
    const state = selectedState(); state.history = [];
    state.pool.pending.origin = 'automatic'; state.pool.pending.key = '';
    env(state);
    const s = S.readState();
    assert.equal(s.history[0].recovered, true);
    assert.equal(s.history[0].origin, 'automatic');
    assert.equal(s.pool.pending.origin, 'automatic');
    assert.equal(statusCount(s, 'reserved'), 1);
});

console.log('pool state:', scenarios, 'scenarios passed; no API calls');

import * as H from './host.js';
import { config } from './config.js';
import { guard } from './state.js';

const SKIP_LORE = /🎬小风铃|🎬统筹|🎬创意空投机|🎬场外小叮当/;

function loreKeys(e) {
    let keys = e.key || e.keys || [];
    if (typeof keys === 'string') keys = keys.split(',');
    return Array.isArray(keys) ? keys : [];
}

async function loreExcerpt(story) {
    const entries = await H.loreEntries();
    const lore = [];
    let size = 0;
    for (const e of entries) {
        if (!e || e.disable === true || e.enabled === false) continue;
        const name = String(e.comment || e.name || '');
        if (SKIP_LORE.test(name)) continue;
        const relevant = e.constant === true || e.strategy === 'constant'
            || loreKeys(e).some(k => String(k).trim() && story.toLowerCase().indexOf(String(k).toLowerCase()) >= 0);
        if (!relevant || size >= 5000) continue;
        const txt = H.cut(name + '：' + (e.content || ''), Math.min(1600, 5000 - size));
        lore.push(txt); size += txt.length;
    }
    return lore;
}

export async function buildContext(job, ms, s, selection) {
    await guard(job);
    const parts = [];
    if (s.tone) parts.push('【用户基调｜叙事偏好】\n' + H.cut(s.tone, 2000));
    for (const section of await H.characterSections(4, {})) {
        parts.push('【角色】\n' + H.cut(section.text, 4500));
        await guard(job);
    }
    const persona = H.personaSection();
    if (persona) parts.push('【用户角色】\n' + H.cut(persona, 2000));
    const recent = H.liveMessages(ms).slice(-(selection ? config.poolContextMessages : config.contextRounds * 2 + 2));
    const story = recent.map(m => (m.role === 'user' ? '用户' : (m.name || '角色')) + '：' + H.cut(m.text, 2200)).join('\n\n');
    const lore = await loreExcerpt(story);
    await guard(job);
    if (lore.length) parts.push('【相关世界书摘录｜按常驻与近期关键词筛选，不等于主模型完整激活结果】\n' + lore.join('\n'));
    const scenario = H.scenarioOverride();
    if (scenario) parts.push('【当前场景】\n' + H.cut(scenario, 2000));
    if (s.activeCards.length) parts.push('【当前候选｜状态=' + s.floatStage + '；不是已发生事实】\n' + JSON.stringify(s.activeCards));
    if (s.history.length) parts.push('【最近五组投放记录｜delivered 仅表示纸条已随请求投送，不代表剧情发生；confirmedAt 表示手动确认；旧版 fulfilled 未必经用户确认，仍须以正文核实】\n' + JSON.stringify(s.history.slice(-5)));
    if (!selection && s.coordLog.length) parts.push('【此前场外小叮当｜需验收，不能当事实】\n' + s.coordLog.slice(-2).map(g => H.cut(g.text, 1200)).join('\n'));
    parts.push('【最近正文】\n' + story);
    return parts.join('\n\n');
}

// Keep the historical export name for callers. Pool ownership now depends only
// on raw character/persona settings, never on a chat message, greeting or scenario.
export async function openingSource(job) {
    return settingsSource(job, false);
}

// Reconstruct the old character-card section solely to migrate saved pools.
// This comparison input is never stored as the new source or sent to the API.
export async function legacyPoolSource(job) {
    return settingsSource(job, true);
}

async function settingsSource(job, legacyOpening) {
    await guard(job);
    const sections = [];
    const fullSections = [];
    const ids = [];
    for (const section of await H.characterSections(4, { withOpening: legacyOpening, withScenario: legacyOpening, raw: true })) {
        ids.push(section.id);
        sections.push({ kind: '初始角色卡', text: H.cut(section.text, 10000) });
        fullSections.push({ kind: '初始角色卡', text: section.text });
        await guard(job);
    }
    const persona = H.personaSection(true);
    if (persona) {
        sections.push({ kind: 'user 设定', text: H.cut(persona, 5000) });
        fullSections.push({ kind: 'user 设定', text: persona });
    }
    const scenario = legacyOpening ? H.scenarioOverride(true) : '';
    if (scenario) {
        sections.push({ kind: '聊天开场设定', text: H.cut(scenario, 4000) });
        fullSections.push({ kind: '聊天开场设定', text: scenario });
    }
    if (!sections.length) throw Error('未读到角色卡或 user 设定，未开始建池');
    const text = sections.map(section => '【' + section.kind + '】\n' + section.text).join('\n\n');
    const fullText = JSON.stringify(fullSections);
    return {
        schemaVersion: legacyOpening ? 2 : 3, sections,
        settingsFingerprint: H.hash(fullText), settingsLength: fullText.length,
        identity: ids.join(',') + ':' + H.personaId(), fingerprint: H.hash(text), text, capturedAt: Date.now(),
    };
}

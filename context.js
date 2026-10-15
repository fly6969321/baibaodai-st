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
    if (s.history.length) parts.push('【最近五组投放记录｜fulfilled 为用户确认，其余不代表发生】\n' + JSON.stringify(s.history.slice(-5)));
    if (!selection && s.coordLog.length) parts.push('【此前场外小叮当｜需验收，不能当事实】\n' + s.coordLog.slice(-2).map(g => H.cut(g.text, 1200)).join('\n'));
    parts.push('【最近正文】\n' + story);
    return parts.join('\n\n');
}

// 指纹用未展开宏的原文，否则换个 persona 就会误判「设定已变化」
export async function openingSource(job, ms) {
    await guard(job);
    const sections = [];
    const ids = [];
    for (const section of await H.characterSections(4, { withOpening: true, raw: true })) {
        ids.push(section.id);
        sections.push('【初始角色卡】\n' + H.cut(section.text, 10000));
        await guard(job);
    }
    const persona = H.personaSection(true);
    if (persona) sections.push('【user 设定】\n' + H.cut(persona, 5000));
    const opening = ms.find(m => m.role === 'assistant');
    if (opening) sections.push('【第一楼开场】\n' + H.cut(opening.narrative, 5000));
    const scenario = H.scenarioOverride(true);
    if (scenario) sections.push('【聊天开场设定】\n' + H.cut(scenario, 4000));
    if (!sections.length) throw Error('未读到角色卡、user 设定或开场白，未开始建池');
    const text = sections.join('\n\n');
    return { identity: ids.join(',') + ':' + H.personaId(), fingerprint: H.hash(text), text, capturedAt: Date.now() };
}

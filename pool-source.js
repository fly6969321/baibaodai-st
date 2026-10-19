import * as H from './host.js';

const NAMES = { '初始角色卡': '角色卡', 'user 设定': 'user设定', '第一楼开场': '开场正文', '聊天开场设定': '聊天场景' };
const serialize = sections => sections.map(s => '【' + s.kind + '】\n' + s.text).join('\n\n');

// Older snapshots contain only the formatted API input. Never normalize character
// or persona text, and require an exact round trip before interpreting its sections.
function sectionsOf(source) {
    if (!source || typeof source.text !== 'string' || H.hash(source.text) !== source.fingerprint) return null;
    if (source.schemaVersion === 2) {
        const sections = source.sections;
        return Array.isArray(sections) && sections.length && sections.every(s => s && NAMES[s.kind] && typeof s.text === 'string')
            && serialize(sections) === source.text ? sections : null;
    }
    const headings = Array.from(source.text.matchAll(/(?:^|\n\n)【(初始角色卡|user 设定|第一楼开场|聊天开场设定)】\n/g));
    const sections = headings.map((h, i) => ({ kind: h[1], text: source.text.slice(h.index + h[0].length,
        i + 1 < headings.length ? headings[i + 1].index : source.text.length) }));
    return sections.length && serialize(sections) === source.text ? sections : null;
}

export function comparePoolSources(previous, fresh, ms) {
    const before = sectionsOf(previous), after = sectionsOf(fresh);
    const identityMatches = !previous.identity || previous.identity === fresh.identity;
    const priorOpening = previous.opening, currentOpening = fresh.opening;
    const hasFullOpening = priorOpening && typeof priorOpening.fullFingerprint === 'string';
    const unknownOpening = !hasFullOpening && currentOpening && currentOpening.truncated;
    const changedFullOpening = hasFullOpening && (!currentOpening
        || priorOpening.fullFingerprint !== currentOpening.fullFingerprint || priorOpening.length !== currentOpening.length);
    const exact = identityMatches && !unknownOpening && !changedFullOpening
        && previous.fingerprint === fresh.fingerprint && previous.text === fresh.text;
    if (exact) return { exact: true, compatible: false, openingOnly: false, changed: '' };
    const values = (sections, kind) => (sections || []).filter(s => s.kind === kind).map(s => s.text);
    const changed = Object.keys(NAMES).filter(kind => JSON.stringify(values(before, kind)) !== JSON.stringify(values(after, kind)));
    if ((unknownOpening || changedFullOpening) && !changed.includes('第一楼开场')) changed.push('第一楼开场');
    const labels = changed.map(kind => NAMES[kind]);
    if (!identityMatches) labels.push('角色/user身份');
    const oldOpenings = values(before, '第一楼开场'), newOpenings = values(after, '第一楼开场');
    const sameLayout = before && after && JSON.stringify(before.map(s => s.kind)) === JSON.stringify(after.map(s => s.kind));
    const openingOnly = !!(sameLayout && previous.identity === fresh.identity && changed.length === 1
        && changed[0] === '第一楼开场' && oldOpenings.length === 1 && newOpenings.length === 1);
    const opening = ms.find(m => m.role === 'assistant');
    // A 5,000-character legacy snapshot may end inside an image block or omit
    // story text. A truncated snapshot is not proof of unchanged narrative.
    const compatible = !!(openingOnly && oldOpenings[0].length < 5000 && newOpenings[0].length < 5000
        && !(fresh.opening && fresh.opening.truncated)
        && H.normalizeOpeningNarrative(oldOpenings[0], opening && opening.raw)
            === H.normalizeOpeningNarrative(newOpenings[0], opening && opening.raw));
    return { exact: false, compatible, openingOnly, changed: labels.join('、') || '角色/user/开场/场景' };
}

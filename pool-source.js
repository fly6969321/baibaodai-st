import * as H from './host.js';

const NAMES = { '初始角色卡': '角色卡', 'user 设定': 'user设定', '第一楼开场': '开场正文', '聊天开场设定': '聊天场景' };
const serialize = sections => sections.map(s => '【' + s.kind + '】\n' + s.text).join('\n\n');

// Older snapshots contain only the formatted API input. Never normalize character
// or persona text, and require an exact round trip before interpreting its sections.
function sectionsOf(source) {
    if (!source || typeof source.text !== 'string' || H.hash(source.text) !== source.fingerprint) return null;
    if (source.schemaVersion === 2 || source.schemaVersion === 3) {
        const sections = source.sections;
        return Array.isArray(sections) && sections.length && sections.every(s => s && NAMES[s.kind] && typeof s.text === 'string')
            && serialize(sections) === source.text ? sections : null;
    }
    const headings = Array.from(source.text.matchAll(/(?:^|\n\n)【(初始角色卡|user 设定|第一楼开场|聊天开场设定)】\n/g));
    const sections = headings.map((h, i) => ({ kind: h[1], text: source.text.slice(h.index + h[0].length,
        i + 1 < headings.length ? headings[i + 1].index : source.text.length) }));
    return sections.length && serialize(sections) === source.text ? sections : null;
}

export function comparePoolSources(previous, fresh, legacy) {
    const before = sectionsOf(previous), after = sectionsOf(fresh);
    const identityMatches = !previous.identity || previous.identity === fresh.identity;
    const currentSchema = previous.schemaVersion === 3;
    const fullMatch = previous.settingsFingerprint === fresh.settingsFingerprint && previous.settingsLength === fresh.settingsLength;
    const exact = !!(before && after && currentSchema && identityMatches && fullMatch
        && previous.fingerprint === fresh.fingerprint && previous.text === fresh.text);
    if (exact) return { exact: true, compatible: false, changed: '' };
    const sameValues = (a, b, kind) => JSON.stringify((a || []).filter(s => s.kind === kind).map(s => s.text))
        === JSON.stringify((b || []).filter(s => s.kind === kind).map(s => s.text));
    const oldCharacters = (before || []).filter(s => s.kind === '初始角色卡');
    const newCharacters = (after || []).filter(s => s.kind === '初始角色卡');
    // Older snapshots flattened name/description/personality/scenario/greeting
    // into one field. The stable fields are a prefix; require a field boundary
    // after that prefix so a shortened description/personality cannot pass.
    const characterSettingsMatch = oldCharacters.length === newCharacters.length
        && oldCharacters.every((section, index) => section.text.startsWith(newCharacters[index].text)
            && (section.text.length === newCharacters[index].text.length
                || section.text[newCharacters[index].text.length] === '\n'));
    const compatible = !!(!currentSchema && before && after && identityMatches && characterSettingsMatch
        && sameValues(before, after, 'user 设定'));
    if (compatible) return { exact: false, compatible: true, changed: '' };
    const values = (sections, kind) => (sections || []).filter(s => s.kind === kind).map(s => s.text);
    const changed = ['初始角色卡', 'user 设定'].filter(kind => JSON.stringify(values(before, kind)) !== JSON.stringify(values(after, kind)));
    const labels = changed.map(kind => NAMES[kind]);
    if (!identityMatches) labels.push('角色/user身份');
    return { exact: false, compatible: false, changed: labels.join('、') || '角色/user设定' };
}

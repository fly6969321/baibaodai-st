import * as H from './host.js';
import { guard } from './state.js';

const SKIP_LORE = /🎬小风铃|🎬统筹|🎬创意空投机|🎬场外小叮当/;
const TOTAL_LIMIT = 20000, ENTRY_LIMIT = 4000;
const TRUNCATED = '\n…（本条已截断）';

function keys(value) {
    if (typeof value === 'string') value = value.split(',');
    return Array.isArray(value) ? value.filter(key => typeof key === 'string').map(key => key.trim()).filter(Boolean) : [];
}

function parseKeyRegex(input) {
    const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match || /(^|[^\\])\//.test(match[1])) return null;
    try { return new RegExp(match[1].replace('\\/', '/'), match[2]); } catch (_) { return null; }
}

function matchesKey(text, key, entry, settings) {
    const regex = parseKeyRegex(key);
    if (regex) { regex.lastIndex = 0; return regex.test(text); }
    if (!(entry.caseSensitive ?? settings.caseSensitive)) { text = text.toLowerCase(); key = key.toLowerCase(); }
    if (!(entry.matchWholeWords ?? settings.matchWholeWords) || key.split(/\s+/).length > 1) return text.includes(key);
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|\\W)(' + escaped + ')(?:$|\\W)').test(text);
}

function matchesSource(entry, sourceText, settings) {
    if (entry.constant === true || entry.constant === 1 || entry.strategy === 'constant') return true;
    if (!keys(entry.key || entry.keys).some(key => matchesKey(sourceText, key, entry, settings))) return false;
    const secondary = keys(entry.keysecondary);
    if (!entry.selective || !secondary.length) return true;
    const matches = secondary.map(key => matchesKey(sourceText, key, entry, settings));
    switch (Number(entry.selectiveLogic || 0)) {
        case 1: return !matches.every(Boolean); // NOT_ALL
        case 2: return !matches.some(Boolean); // NOT_ANY
        case 3: return matches.every(Boolean); // AND_ALL
        default: return matches.some(Boolean); // AND_ANY
    }
}

function matchesCharacter(entry, characters) {
    const filter = entry.characterFilter;
    if (!filter || typeof filter !== 'object') return true;
    const names = Array.isArray(filter.names) ? filter.names : [];
    const tags = Array.isArray(filter.tags) ? filter.tags : [];
    if (!names.length && !tags.length) return true;
    const excludes = !!filter.isExclude;
    // Both constraints must pass for one character; do not combine a name
    // match on one group member with a tag match on another member.
    return characters.some(ch => (!names.length || names.includes(ch.fileName) !== excludes)
        && (!tags.length || ch.tags.some(tag => tags.includes(tag)) !== excludes));
}

// Mirror ST's leading decorator block, including the @@@ fallback form.
// Inline occurrences are ordinary text. Activation does not broaden the
// agreed constant/keyword rule for a global-only book.
function readContent(value) {
    let content = typeof value === 'string' ? value : '';
    const decorators = [];
    if (content.startsWith('@@')) {
        const lines = content.split('\n');
        let fallback = false, index = 0;
        for (; index < lines.length && lines[index].startsWith('@@'); index++) {
            const line = lines[index].replace(/\r$/, '');
            if (line.startsWith('@@@') && !fallback) continue;
            const directive = line.startsWith('@@@') ? line.slice(1) : line;
            if (directive.startsWith('@@activate') || directive.startsWith('@@dont_activate')) {
                decorators.push(directive); fallback = false;
            } else fallback = true;
        }
        content = lines.slice(index).join('\n');
    }
    return {
        content: content.trim(),
        suppressed: !decorators.includes('@@activate') && decorators.includes('@@dont_activate'),
    };
}

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function entryOrder(entry) { return Number.isFinite(Number(entry.order)) ? Number(entry.order) : 100; }
function sliceText(text, limit) {
    const result = text.slice(0, Math.max(0, limit));
    return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
}

// Export the catalogue reader separately so its selection rules can be tested
// with real ST-shaped book objects without running ST's UI or activation loop.
export async function collectPoolLore(catalog, sourceText, checkpoint = async () => {}) {
    const rows = [], scannedBooks = [];
    const characters = Array.isArray(catalog.characters) ? catalog.characters : [];
    const settings = catalog.settings || {};
    const books = Array.isArray(catalog.books) ? catalog.books : [];
    sourceText = String(sourceText || '');
    for (const book of books) {
        await checkpoint();
        let data;
        try {
            if (typeof catalog.load !== 'function') throw Error('当前酒馆未提供世界书读取接口');
            data = await catalog.load(book.name);
        } catch (error) {
            await checkpoint();
            throw Error('世界书「' + H.cut(book.name, 120) + '」读取失败：' + H.cut(error.message || error, 160));
        }
        await checkpoint();
        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
            throw Error('世界书「' + H.cut(book.name, 120) + '」读取失败：未返回有效条目，请检查绑定或重试');
        }
        scannedBooks.push(book.name);
        const entries = Object.entries(data.entries).filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry));
        entries.sort(([keyA, a], [keyB, b]) => entryOrder(b) - entryOrder(a)
            || compareText(String(a.uid ?? keyA), String(b.uid ?? keyB)) || compareText(keyA, keyB));
        for (const [, entry] of entries) {
            if (entry.disable == true || entry.enabled === false || !matchesCharacter(entry, characters)) continue;
            const name = String(entry.comment || entry.name || '');
            if (SKIP_LORE.test(name)) continue;
            const parsed = readContent(entry.content);
            if (!parsed.content || parsed.suppressed) continue;
            if (!book.bound && !matchesSource(entry, sourceText, settings)) continue;
            rows.push({ book: book.name, name, content: parsed.content });
        }
    }
    let text = '', entriesCount = 0, truncatedEntries = 0, omittedEntries = 0;
    const includedBooks = new Set();
    for (const row of rows) {
        const separator = text ? '\n\n' : '';
        const heading = '【世界书：' + row.book + (row.name ? '｜' + row.name : '') + '】\n';
        const remaining = TOTAL_LIMIT - text.length - separator.length;
        const limit = Math.min(ENTRY_LIMIT, remaining);
        if (limit <= heading.length + TRUNCATED.length) { omittedEntries++; continue; }
        const full = heading + row.content;
        const clipped = full.length > limit;
        text += separator + (clipped ? sliceText(full, limit - TRUNCATED.length) + TRUNCATED : full);
        entriesCount++;
        if (clipped) truncatedEntries++;
        includedBooks.add(row.book);
    }
    await checkpoint();
    return {
        text, entriesCount, books: Array.from(includedBooks),
        truncated: truncatedEntries > 0 || omittedEntries > 0,
        truncatedEntries, omittedEntries, eligibleEntries: rows.length, scannedBooks,
    };
}

// The caller supplies only the stable character/user settings. This snapshot
// is additional API material, never a pool fingerprint or per-turn dependency.
export async function buildPoolLore(job, sourceText) {
    const checkpoint = () => guard(job);
    const catalog = await H.poolLoreContext(checkpoint);
    return collectPoolLore(catalog, sourceText, checkpoint);
}

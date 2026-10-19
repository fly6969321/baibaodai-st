import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] || fileURLToPath(new URL('..', import.meta.url));
const H = await import(pathToFileURL(path.join(root, 'host.js')).href);
let scenarios = 0;
function test(name, fn) {
    try { fn(); scenarios++; }
    catch (error) { console.error('FAILED:', name); throw error; }
}

test('existing comments and outer whitespace are removed', () => {
    assert.equal(H.normalizeOpeningNarrative(' \n开场<!--图片元数据\n注释-->正文\n '), '开场正文');
    assert.equal(H.messageText({ mes: '开场<!--隐藏注释-->正文' }), '开场正文');
});

test('all built-in image and draw marker case variants are ignored', () => {
    for (const tag of ['image###portrait###', 'IMAGE###portrait###', 'ImAgE###portrait###',
        '<draw>portrait</draw>', '<DRAW>portrait</DRAW>', '<DrAw>portrait</dRaW>']) {
        assert.equal(H.normalizeOpeningNarrative('开场正文\n\n' + tag), '开场正文', tag);
    }
});

test('complete multiline and nested built-in markers are ignored', () => {
    assert.equal(H.normalizeOpeningNarrative('开场\n\nimage###镜头\n人物###\n\n<draw>环境\n动作</draw>'), '开场');
    assert.equal(H.normalizeOpeningNarrative('开场\n\n<draw>image###portrait###</draw>'), '开场');
});

test('ordinary internal prose whitespace is not rewritten', () => {
    assert.equal(H.normalizeOpeningNarrative('  前文\n\n  后文  \n'), '前文\n\n  后文');
    assert.equal(H.normalizeOpeningNarrative('前文 image###portrait### 后文'), '前文  后文');
});

test('unfinished image markers and orphan closing tokens remain visible', () => {
    for (const text of ['开场\n\nimage###unfinished', '开场\n\nIMAGE###unfinished##',
        '开场\n\n<draw>unfinished', '开场\n\n<DRAW>unfinished', '开场\n\n</draw>', '开场\n\n###']) {
        assert.equal(H.normalizeOpeningNarrative(text), text);
    }
});

test('an unfinished marker cannot consume prose before another complete marker', () => {
    assert.equal(H.normalizeOpeningNarrative('开场\nimage###未闭合\n这是剧情\nimage###portrait###'),
        '开场\nimage###未闭合\n这是剧情');
    assert.equal(H.normalizeOpeningNarrative('开场\n<draw>未闭合\n这是剧情\n<draw>portrait</draw>'),
        '开场\n<draw>未闭合\n这是剧情');
});

test('draw-like story elements are not treated as built-in markers', () => {
    for (const text of ['<drawer>抽屉里有信</drawer>', '<draw class="story">他画了一封信</draw>',
        '<draw >带属性边界的原文</draw >', '&lt;draw&gt;显示标签示例&lt;/draw&gt;']) {
        assert.equal(H.normalizeOpeningNarrative(text), text);
    }
});

test('complete Markdown images keep the existing removal behavior', () => {
    assert.equal(H.normalizeOpeningNarrative('开场\n\n![图片](https://example.test/portrait.png)'), '开场');
    assert.equal(H.normalizeOpeningNarrative('开场\n\n![a\\]b](https://example.test/image_(1).png)'), '开场');
    assert.equal(H.normalizeOpeningNarrative('开场\n\n![图片](https://example.test/unfinished'),
        '开场\n\n![图片](https://example.test/unfinished');
});

test('complete HTML images allow quoted angle brackets without eating later markup', () => {
    assert.equal(H.normalizeOpeningNarrative('开场\n\n<IMG src="x.png" alt="a > b"><img src=\'y.png\' />'), '开场');
    assert.equal(H.normalizeOpeningNarrative('开场\n\n<img alt="unfinished'), '开场\n\n<img alt="unfinished');
    assert.equal(H.normalizeOpeningNarrative('开场\n<img unfinished\n故事<p>后续</p>'),
        '开场\n<img unfinished\n故事<p>后续</p>');
});

test('custom exact recorded suffix is stripped at the actual injection boundary', () => {
    const tag = '[生图.*]\nportrait\n[/生图]';
    const message = { mes: '开场\n\n' + tag, extra: { sdg_tag: tag, sdg_desc: 'portrait' } };
    assert.equal(H.narrativeText(message), '开场');
    assert.equal(H.normalizeOpeningNarrative(message.mes + '\n  ', message), '开场');
    assert.equal(H.normalizeOpeningNarrative('开场\r\n\r\n' + tag, message), '开场');
    assert.equal(H.normalizeOpeningNarrative(tag, message), '');
});

test('custom tag matching is literal, case-sensitive, and requires the complete suffix', () => {
    const tag = '[DRAW]portrait[/DRAW]';
    const message = { extra: { sdg_tag: tag } };
    for (const text of ['开场\n\n[draw]portrait[/draw]', '开场\n\n[DRAW]portrait[/DRA',
        '开场\n\n[DRAW]another portrait[/DRAW]', '开场\n\n' + tag + '\n继续剧情']) {
        assert.equal(H.normalizeOpeningNarrative(text, message), text);
    }
});

test('custom-looking story text without an exact record or boundary is preserved', () => {
    const tag = '[生图]portrait[/生图]';
    assert.equal(H.normalizeOpeningNarrative('开场\n\n' + tag), '开场\n\n' + tag);
    assert.equal(H.normalizeOpeningNarrative('开场' + tag, { extra: { sdg_tag: tag } }), '开场' + tag);
    assert.equal(H.normalizeOpeningNarrative('开场\n' + tag, { extra: { sdg_tag: tag } }), '开场\n' + tag);
    assert.equal(H.normalizeOpeningNarrative('开场\n\n' + tag, { extra: { sdg_tag: 17 } }), '开场\n\n' + tag);
});

test('only the recorded trailing occurrence is removed', () => {
    const tag = '[生图]portrait[/生图]';
    const text = '信里引用了' + tag + '\n\n后续正文\n\n' + tag;
    assert.equal(H.normalizeOpeningNarrative(text, { extra: { sdg_tag: tag } }),
        '信里引用了' + tag + '\n\n后续正文');
});

test('sdg_env alone never authorizes stripping an arbitrary story container', () => {
    const text = '<details><summary>一封旧信</summary><p>信里有重要剧情。</p></details>';
    assert.equal(H.normalizeOpeningNarrative(text, { extra: { sdg_env: 'details', sdg_desc: '信里有重要剧情。' } }), text);
    assert.equal(H.normalizeOpeningNarrative('<scene>两人来到车站</scene>',
        { extra: { sdg_env: 'scene', sdg_layers: { env: '两人来到车站' } } }), '<scene>两人来到车站</scene>');
});

test('other HTML structure and visible story remain intact when images are removed', () => {
    const text = '<details><summary>原剧情标题</summary><p>原剧情正文。</p><img src="x"></details>';
    assert.equal(H.normalizeOpeningNarrative(text), '<details><summary>原剧情标题</summary><p>原剧情正文。</p></details>');
});

test('live and saved opening text use exactly the same public normalization', () => {
    const tag = '[镜头]portrait[/镜头]';
    const message = { mes: '开场正文\n\n' + tag, extra: { sdg_tag: tag } };
    const savedOpening = message.mes;
    assert.equal(H.normalizeOpeningNarrative(savedOpening, message), H.narrativeText(message));
    assert.equal(H.normalizeOpeningNarrative('开场正文\n\n<DRAW>old portrait</DRAW>'),
        H.narrativeText({ mes: '开场正文\n\nimage###new portrait###' }));
    assert.notEqual(H.normalizeOpeningNarrative('旧开场\n\n<draw>portrait</draw>'),
        H.normalizeOpeningNarrative('真实改动的开场\n\n<draw>portrait</draw>'));
});

test('a truncated saved custom block is not reconstructed or discarded', () => {
    const tag = '[镜头]portrait[/镜头]';
    const savedOpening = '开场正文\n\n[镜头]portr';
    assert.equal(H.normalizeOpeningNarrative(savedOpening, { extra: { sdg_tag: tag } }), savedOpening);
});

test('normalization does not modify the message, swipe, or image metadata', () => {
    const message = { mes: '开场\n\nIMAGE###portrait###', swipe_id: 2, swipes: ['A', 'B', 'C'],
        extra: { sdg_gal: { 2: { 0: { list: ['image-a', 'image-b'], cur: 1 } } } } };
    const before = structuredClone(message);
    assert.equal(H.narrativeText(message), '开场');
    assert.deepEqual(message, before);
});

console.log('narrative:', scenarios, 'scenarios passed; no API calls');

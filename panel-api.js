export function createRelayUI(S) {
    const { $, t, panel, on, app, msg, act } = S;

    const modelLists = { chime: { seq: 0, ids: [], signature: '' }, coord: { seq: 0, ids: [], signature: '' } };
    let relayEditors = { chime: null, coord: null };

    function relayPrefix(kind) { return kind === 'chime' ? 'eye' : 'coord'; }

    function modelIds(kind) {
        return kind === 'coord'
            ? { field: 'dr-coordmodel', fetch: 'dr-coord-models-fetch', select: 'dr-coord-models-select', filter: 'dr-coord-models-filter', box: 'dr-coord-models-box', msg: 'dr-coord-models-msg' }
            : { field: 'dr-eyemodel', fetch: 'dr-eye-models-fetch', select: 'dr-eye-models-select', filter: 'dr-eye-models-filter', box: 'dr-eye-models-box', msg: 'dr-eye-models-msg' };
    }

    function relayFields(kind) {
        const p = relayPrefix(kind);
        return ['dr-' + p + '-relay-name', 'dr-' + p + '-url', 'dr-' + p + '-key', modelIds(kind).field]
            .concat(kind === 'coord' ? ['dr-reuse'] : []).map($);
    }

    function relayDirty(kind) { return relayFields(kind).some(e => S.dirty.has(S.keyOf(e))); }
    function clearRelayDirty(kind) { relayFields(kind).forEach(e => S.dirty.delete(S.keyOf(e))); }

    function connectionDraft(kind) {
        const snap = S.getSnap();
        if (snap && snap.cfg.relaySchemaVersion === 1) {
            if (kind === 'coord' && $('dr-reuse').checked) return { relayDraft: { url: snap.cfg.eyeApiUrl, key: snap.cfg.eyeApiKey } };
            const p = relayPrefix(kind);
            return { relayDraft: { url: $('dr-' + p + '-url').value.trim(), key: $('dr-' + p + '-key').value.trim() } };
        }
        return {
            eyeApiUrl: $('dr-eye-url').value.trim(), eyeApiKey: $('dr-eye-key').value.trim(),
            coordApiUrl: $('dr-coord-url').value.trim(), coordApiKey: $('dr-coord-key').value.trim(),
            coordUseEye: $('dr-reuse').checked,
        };
    }

    function connectionSignature(kind) {
        const d = connectionDraft(kind);
        if (d.relayDraft) return JSON.stringify(d.relayDraft);
        return JSON.stringify(kind === 'coord' && d.coordApiUrl ? [d.coordApiUrl, d.coordApiKey]
            : kind === 'chime' || d.coordUseEye ? [d.eyeApiUrl, d.eyeApiKey] : ['', '']);
    }

    function renderModels(kind) {
        const ids = modelIds(kind), state = modelLists[kind];
        const select = $(ids.select), filter = $(ids.filter).value.trim().toLowerCase();
        select.replaceChildren();
        const option = document.createElement('option');
        option.value = ''; option.textContent = t('proxy.choose'); select.appendChild(option);
        const choices = state.ids.slice(), current = $(ids.field).value.trim();
        if (current && choices.indexOf(current) < 0) choices.unshift(current);
        const matches = choices.filter(id => id.toLowerCase().includes(filter));
        matches.forEach(id => { const o = document.createElement('option'); o.value = id; o.textContent = id; select.appendChild(o); });
        if (!matches.length) {
            const empty = document.createElement('option');
            empty.value = ''; empty.disabled = true; empty.textContent = t('proxy.emptyFilter'); select.appendChild(empty);
        }
        select.value = matches.indexOf($(ids.field).value) >= 0 ? $(ids.field).value : '';
    }

    function invalidateModels(kind, showMessage) {
        const state = modelLists[kind], ids = modelIds(kind);
        const existed = state.ids.length || $(ids.fetch).disabled;
        state.seq++; state.ids = []; state.signature = '';
        $(ids.box).hidden = true; $(ids.select).replaceChildren(); $(ids.filter).value = '';
        $(ids.fetch).disabled = false; renderModels(kind);
        if (existed && showMessage) msg(ids.msg, t('proxy.changed'), 'warn');
        else if (!showMessage) msg(ids.msg, '');
    }

    function loadRelayEditor(kind, id, c, isDraft) {
        const prefix = relayPrefix(kind), p = (c.relayProfiles || []).find(x => x.id === id);
        clearRelayDirty(kind);
        relayEditors[kind] = { id: id || '', revision: c.relayRevision, keep: !!isDraft, lastURL: p ? p.url : '' };
        $('dr-' + prefix + '-relay-name').value = p ? p.name : '';
        $('dr-' + prefix + '-url').value = p ? p.url : '';
        $('dr-' + prefix + '-key').value = p ? p.key : '';
        $(modelIds(kind).field).value = id === c[prefix + 'RelayId'] ? c[prefix + 'Model'] || '' : p ? p.model : '';
        if (kind === 'coord') $('dr-reuse').checked = isDraft ? false : c.coordUseEye;
        $('dr-' + prefix + '-relay').value = id || '';
        invalidateModels(kind, false);
    }

    function renderRelays(c) {
        if (c.relaySchemaVersion !== 1) return;
        ['chime', 'coord'].forEach(kind => {
            const prefix = relayPrefix(kind), state = relayEditors[kind];
            const select = $('dr-' + prefix + '-relay');
            select.replaceChildren();
            const empty = document.createElement('option');
            empty.value = ''; empty.textContent = t('relay.empty'); select.appendChild(empty);
            c.relayProfiles.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; select.appendChild(o); });
            if (!state || (!state.keep && !relayDirty(kind) && state.revision !== c.relayRevision)) loadRelayEditor(kind, c[prefix + 'RelayId'], c, false);
            select.value = relayEditors[kind].id;
            const reuse = kind === 'coord' && $('dr-reuse').checked;
            ['dr-' + prefix + '-relay-name', 'dr-' + prefix + '-url', 'dr-' + prefix + '-key', modelIds(kind).field, modelIds(kind).select]
                .forEach(id => { $(id).disabled = reuse; });
            $('dr-' + prefix + '-relay-delete').disabled = !relayEditors[kind].id || S.isPending();
            $('dr-' + prefix + '-save').disabled = S.isPending();
            $('dr-' + prefix + '-relay-edit').disabled = reuse;
            $('dr-' + prefix + '-model-edit').disabled = reuse;
            renderModels(kind);
        });
    }

    function relayFingerprint(kind) { return JSON.stringify([relayEditors[kind], relayFields(kind).map(S.value)]); }

    async function saveRelayUI(api, kind) {
        const snap = S.getSnap();
        if (!api.saveRelay || !snap || snap.cfg.relaySchemaVersion !== 1) {
            return S.saveFields(api, '[data-foldbody="' + (kind === 'chime' ? 'eyeapi' : 'coordapi') + '"] [data-config]');
        }
        const p = relayPrefix(kind), editor = relayEditors[kind];
        const before = relayFingerprint(kind), chatAtStart = S.getCurrentChat();
        const result = kind === 'coord' && $('dr-reuse').checked
            ? await api.saveCfg({ coordUseEye: true, expectedRevision: editor.revision })
            : await api.saveRelay(kind, {
                id: editor.id, name: $('dr-' + p + '-relay-name').value, url: $('dr-' + p + '-url').value,
                key: $('dr-' + p + '-key').value, model: $(modelIds(kind).field).value, expectedRevision: editor.revision,
            });
        if (result && result.ok && S.getCurrentChat() === chatAtStart && relayFingerprint(kind) === before) {
            clearRelayDirty(kind); relayEditors[kind] = null;
        }
        return result;
    }

    async function fetchModels(kind) {
        const ids = modelIds(kind), state = modelLists[kind];
        if (!app() || !app().listModels) { msg(ids.msg, t('ui.wait'), 'warn'); return; }
        invalidateModels(kind, false);
        const seq = state.seq, chatAtStart = S.getCurrentChat();
        const signature = connectionSignature(kind), draft = connectionDraft(kind);
        $(ids.fetch).disabled = true; state.signature = signature; msg(ids.msg, t('proxy.loading'));
        const live = () => !S.isDisposed() && S.getCurrentChat() === chatAtStart && state.seq === seq && connectionSignature(kind) === signature;
        try {
            const result = await app().listModels(kind, draft);
            if (!live()) return;
            if (!result || result.ok === false || !Array.isArray(result.models)) throw Error(t('proxy.failed'));
            state.ids = result.models; $(ids.box).hidden = false; renderModels(kind);
            msg(ids.msg, t('proxy.loaded').replace('{n}', result.models.length), 'ok');
        } catch (e) {
            if (live()) msg(ids.msg, e.message || t('proxy.failed'), 'err');
        } finally {
            if (!S.isDisposed() && state.seq === seq) $(ids.fetch).disabled = false;
        }
    }

    function bind() {
        ['chime', 'coord'].forEach(kind => {
            const p = relayPrefix(kind), message = kind === 'chime' ? 'dr-msg4' : 'dr-msg5';
            const choose = id => {
                const snap = S.getSnap();
                if (!snap || snap.cfg.relaySchemaVersion !== 1) return;
                if (relayDirty(kind)) { $('dr-' + p + '-relay').value = relayEditors[kind].id; msg(message, t('relay.unsaved'), 'warn'); return; }
                loadRelayEditor(kind, id, snap.cfg, true); renderRelays(snap.cfg);
            };
            on($('dr-' + p + '-url'), 'input', function () {
                const editor = relayEditors[kind]; if (!editor) return;
                const origin = url => { try { return new URL(url).origin; } catch (_) { return ''; } };
                if (origin(editor.lastURL) !== origin(this.value)) { const key = $('dr-' + p + '-key'); key.value = ''; S.recordEdit(key); }
                editor.lastURL = this.value;
            });
            on($('dr-' + p + '-relay'), 'change', function () { choose(this.value); });
            on($('dr-' + p + '-relay-new'), 'click', () => { choose(''); $('dr-' + p + '-name-field').hidden = false; $('dr-' + p + '-relay-name').focus(); });
            on($('dr-' + p + '-relay-edit'), 'click', () => {
                const field = $('dr-' + p + '-name-field');
                field.hidden = !field.hidden; if (!field.hidden) $('dr-' + p + '-relay-name').focus();
            });
            on($('dr-' + p + '-model-edit'), 'click', () => {
                const field = $(modelIds(kind).field);
                field.hidden = !field.hidden; if (!field.hidden) field.focus();
            });
            on($('dr-' + p + '-relay-discard'), 'click', async () => {
                if (!app()) return;
                const fresh = await app().snapshot();
                if (fresh.chatId !== S.getCurrentChat()) return;
                clearRelayDirty(kind); relayEditors[kind] = null;
                msg(message, ''); S.setSnap(fresh); S.render(fresh);
            });
            S.click('dr-' + p + '-relay-delete', message, async api => {
                const editor = relayEditors[kind];
                if (!editor || !editor.id) throw Error(t('relay.empty'));
                const result = await api.removeRelay(editor.id, editor.revision);
                if (result && result.ok) { clearRelayDirty(kind); relayEditors[kind] = null; }
                return result;
            });
            const ids = modelIds(kind);
            on($(ids.fetch), 'click', () => { fetchModels(kind); });
            on($(ids.filter), 'input', () => { renderModels(kind); });
            on($(ids.field), 'input', () => { renderModels(kind); });
            on($(ids.select), 'change', function () {
                const snap = S.getSnap();
                if (!this.value || (kind === 'coord' && snap && snap.cfg.relaySchemaVersion === 1 && $('dr-reuse').checked)) return;
                const field = $(ids.field); field.value = this.value; S.recordEdit(field);
                msg(ids.msg, t('proxy.selected'), 'ok');
            });
        });
        on($('dr-reuse'), 'change', () => { const snap = S.getSnap(); if (snap) renderRelays(snap.cfg); });
        ['dr-eye-url', 'dr-eye-key', 'dr-coord-url', 'dr-coord-key', 'dr-reuse'].forEach(id => {
            on($(id), 'input', () => {
                if (id === 'dr-eye-url' || id === 'dr-eye-key') {
                    invalidateModels('chime', true);
                    if ($('dr-reuse').checked) invalidateModels('coord', true);
                } else invalidateModels('coord', true);
            });
        });
        S.click('dr-eye-save', 'dr-msg4', api => saveRelayUI(api, 'chime'));
        S.click('dr-coord-save', 'dr-msg5', api => saveRelayUI(api, 'coord'));
    }

    return {
        bind, renderRelays, renderModels, invalidateModels, connectionSignature,
        resetEditors: () => { relayEditors = { chime: null, coord: null }; },
        hasList: kind => !!modelLists[kind].ids.length,
        signatureOf: kind => modelLists[kind].signature,
    };
}

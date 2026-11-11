import id from '../i18n/id.json';
import en from '../i18n/en.json';
import presets from './presets.json';
import setupGuide from '../../docs/setup.md?url';
import { translator, detectLanguage } from './i18n.js';
import { createSettingsClient } from './apiClient.js';
import { node } from './dom.js';
import { mountImageSettings } from './imageSettings.js';
import { mountMemorySettings } from './memorySettings.js';
import { TAB_LABELS, SLOT_LABELS, STATUS_WARNING_KEYS, DEFAULT_TTS_PARAMS, DEFAULT_ELEVENLABS_PARAMS, ELEVENLABS_MODELS, FISH_EMOTION_GROUPS, FISH_EMOTION_TAGS, emotionMapSelections, updateEmotionSelection, friendlyError, validateBaseUrl, originNeedsConfirmation, parseAdvanced, makeSlot, privacyFlows, withSecret } from './viewModel.js';
import { WIZARD_STEPS, WIZARD_LABELS, WIZARD_STORAGE_KEY, needsWizard, readWizard, moveWizard, saveWizard } from './wizard.js';
import './settings.css';

export async function mountSettings({ document = window.document, api = createSettingsClient(), storage = window.localStorage,
  navigatorLanguage = navigator.language, confirm = message => window.confirm(message) } = {}) {
  let language = detectLanguage(navigatorLanguage);
  let t = translator(language, { id, en });
  let effective;
  let status;
  let tab = 'chat';
  let selected = null;
  let busy = false;
  let fieldId = 0;
  let wizard;
  let imageController;
  let memoryController;
  let content;
  let heading;
  let headingHelp;
  let mobileNavigation;
  let activeForm;
  const forms = new Map();
  const fieldRecords = new WeakMap();
  const tabButtons = new Map();
  const walk = element => [element, ...Array.from(element.children || []).flatMap(walk)];
  const formOf = element => {
    while (element && element.tagName?.toLowerCase() !== 'form') element = element.parentElement || element.parent;
    return element;
  };
  const formDirty = state => state.fields.some(({ input, value }) => input.type === 'password' ? Boolean(input.value)
    : (input.type === 'checkbox' ? input.checked : input.value) !== value);
  const dirty = () => [...forms.values()].some(formDirty) || imageController?.isDirty?.() || memoryController?.isDirty?.();
  const allowLeave = () => !busy && !walk(root).some(item => item.getAttribute?.('aria-busy') === 'true')
    && (!dirty() || confirm(t('confirm.unsaved')));
  try { wizard = readWizard(storage.getItem(WIZARD_STORAGE_KEY)); } catch { wizard = readWizard(null); }
  let showWizard = !wizard.completed;
  const root = node(document, 'main', undefined, { id: 'settings-page' });
  const toast = node(document, 'p', '', { role: 'status', 'aria-live': 'polite', class: 'settings-toast' });
  document.body.replaceChildren(root);
  root.append(node(document, 'h1', t('app.loading')));
  const el = (tag, text, attributes) => node(document, tag, text, attributes);
  const message = (key, vars) => { toast.textContent = t(key, vars); toast.setAttribute('data-state', 'success'); };
  const fail = error => {
    const text = t(friendlyError(error.code)) + ' (' + (error.code || 'BAD_RESPONSE') + ')';
    toast.textContent = text;
    toast.setAttribute('data-state', 'error');
    if (activeForm && forms.has(activeForm)) {
      const state = forms.get(activeForm); state.notice.textContent = text; state.notice.setAttribute('data-state', 'error');
    }
  };
  function refreshDirty(form) {
    const state = forms.get(form);
    if (!state) return;
    state.dirty = formDirty(state);
    form.setAttribute('data-dirty', String(state.dirty));
    state.notice.textContent = state.dirty ? t('action.unsaved') : '';
    state.notice.removeAttribute('data-state');
  }
  function trackForm(form, rebuild) {
    const state = forms.get(form);
    state.rebuild = rebuild;
    state.fields = walk(form).filter(input => fieldRecords.has(input) && !['slot.probeTimeout', 'slot.threshold'].includes(fieldRecords.get(input))).map(input => ({ input,
      value: input.type === 'password' ? undefined : input.type === 'checkbox' ? input.checked : input.value }));
    refreshDirty(form);
  }
  function replaceForm(form, create) {
    clearSecrets(form);
    const next = create();
    forms.delete(form);
    form.replaceWith(next);
    return next;
  }
  function clearSecrets(element) {
    for (const input of walk(element)) if (input.type === 'password') input.value = '';
  }
  function lockControls(element) {
    const locked = element ? walk(element).filter(input => ['input', 'select', 'textarea', 'button'].includes(input.tagName?.toLowerCase()))
      .map(input => [input, input.disabled]) : [];
    for (const [input] of locked) input.disabled = true;
    return () => { for (const [input, disabled] of locked) input.disabled = disabled; };
  }
  const button = (label, action, parent) => {
    const item = el('button', label, { type: 'button' });
    item.addEventListener('click', () => { if (!busy) Promise.resolve().then(() => { if (!busy) return action(); }).catch(fail); });
    parent?.append(item); return item;
  };
  const field = (parent, key, value = '', { type = 'text', options, ...attrs } = {}) => {
    const label = el('label', t(key), { class: 'settings-field' });
    const input = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input', undefined, { id: 'settings-field-' + ++fieldId, ...attrs });
    label.setAttribute('for', input.id);
    if (options) for (const [optionValue, text] of options) input.append(el('option', text, { value: optionValue }));
    else if (type !== 'textarea') input.type = type;
    input.value = value ?? '';
    fieldRecords.set(input, key);
    input.setAttribute('data-setting-field', key);
    for (const event of ['input', 'change']) input.addEventListener(event, () => {
      input.removeAttribute('aria-invalid'); refreshDirty(formOf(input));
      Promise.resolve().then(() => refreshDirty(formOf(input)));
    });
    label.append(input); parent.append(label); return input;
  };
  const checkbox = (parent, key, checked = false) => {
    const input = field(parent, key, '', { type: 'checkbox' }); input.checked = checked; return input;
  };
  const details = (parent, key) => { const box = el('details'); box.append(el('summary', t(key))); parent.append(box); return box; };
  const submit = (form, action) => {
    const actions = el('div', undefined, { class: 'settings-form-actions' }); form.append(actions);
    const item = el('button', t('action.save'), { type: 'submit', class: 'settings-primary' }); actions.append(item);
    const notice = el('p', '', { class: 'settings-form-status', role: 'status', 'aria-live': 'polite' }); form.append(notice);
    forms.set(form, { fields: [], dirty: false, notice });
    form.addEventListener('invalid', event => {
      event.target?.setAttribute('aria-invalid', 'true');
      notice.textContent = t('error.invalid'); notice.setAttribute('data-state', 'error');
    }, true);
    button(t('action.cancelChanges'), () => forms.get(form)?.rebuild?.(), actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (busy) return;
      activeForm = form;
      busy = true; root.setAttribute('aria-busy', 'true');
      const locked = forms.get(form).fields.map(({ input }) => [input, input.disabled]);
      for (const [input] of locked) input.disabled = true;
      notice.textContent = t('action.saving');
      Promise.resolve().then(action).catch(fail).finally(() => {
        for (const [input, disabled] of locked) input.disabled = disabled;
        busy = false; root.removeAttribute('aria-busy'); activeForm = undefined;
      });
    });
  };
  async function load() {
    [effective, status] = await Promise.all([api.get('/'), api.get('/status')]);
    language = effective.sources['ui.language'] === 'default' ? detectLanguage(navigatorLanguage) : effective.settings.ui.language;
    t = translator(language, { id, en });
    if (needsWizard(status, effective.settings)) { showWizard = true; if (wizard.completed) wizard = readWizard(null); }
  }
  async function write(path, body, method = 'PUT') {
    const result = await api.write(path, { version: effective.version, ...body }, method);
    effective.version = result.version;
    return result;
  }
  async function change(operation, target = activeForm) {
    busy = true; root.setAttribute('aria-busy', 'true');
    const unlock = lockControls(target);
    try {
      const previousLanguage = language;
      const previousWizard = showWizard;
      const providerChange = target?.getAttribute('data-provider-form') === 'true';
      await operation(); await load();
      if (previousWizard !== showWizard) { renderContent(); updateNavigation(); }
      else if (target && forms.get(target)?.rebuild && previousLanguage === language) {
        const next = forms.get(target).rebuild();
        if (next && forms.has(next)) forms.get(next).notice.textContent = t('toast.saved');
        updateNavigation();
        for (const form of [...forms.keys()]) {
          if (form === next) continue;
          const name = form.getAttribute('data-slot');
          if (forms.get(form).dirty) { if (providerChange) forms.get(form).syncProvider?.(); continue; }
          if (name && (providerChange || effective.settings.slots[name]?.followLlm)) forms.get(form).rebuild();
        }
        updateProviderOptions();
      } else render();
      message('toast.saved');
    }
    finally { unlock(); busy = false; root.removeAttribute('aria-busy'); }
  }
  async function refresh() {
    if (!allowLeave()) return;
    busy = true; root.setAttribute('aria-busy', 'true');
    const unlock = lockControls(root);
    try { await load(); render(); }
    finally { unlock(); busy = false; root.removeAttribute('aria-busy'); }
  }
  function updateProviderOptions() {
    for (const form of forms.keys()) {
      const name = form.getAttribute('data-slot');
      if (!name) continue;
      const input = walk(form).find(item => fieldRecords.get(item) === 'slot.profile');
      const value = input.value;
      input.replaceChildren(el('option', t('slot.unassigned'), { value: '' }), ...Object.entries(effective.settings.profiles)
        .filter(([, profile]) => profile && (name === 'memoryEmbedding' ? profile.adapter === 'localEmbedding' : profile.adapter !== 'localEmbedding'))
        .map(([id]) => el('option', id, { value: id })));
      input.value = value;
    }
  }
  function providers(host) {
    const parent = el('section', undefined, { class: 'settings-provider-editor' }); host.append(parent);
    parent.append(el('h2', t('provider.title')));
    const list = el('div', undefined, { class: 'settings-provider-list settings-actions' }); parent.append(list);
    const choose = name => {
      if (forms.get(form)?.dirty && !confirm(t('confirm.unsaved'))) return;
      selected = name; forms.get(form).rebuild();
    };
    for (const [name, profile] of Object.entries(effective.settings.profiles)) if (profile) button(name, () => choose(name), list);
    button(t('action.add'), () => choose(null), list);
    const previous = effective.settings.profiles[selected];
    const form = el('form', undefined, { autocomplete: 'off', class: 'settings-card', 'data-provider-form': 'true' }); parent.append(form);
    const preset = field(form, 'provider.preset', 'custom', { options: presets.map(item => [item.id, t(item.labelKey)]) });
    const identifier = field(form, 'provider.id', selected || '', { required: '', maxlength: 64, pattern: '[A-Za-z0-9][A-Za-z0-9_-]*' });
    identifier.disabled = Boolean(selected);
    const adapter = field(form, 'provider.adapter', previous?.adapter || 'openaiCompatible', { options: [
      ['openaiCompatible', t('preset.compatible')], ['anthropicNative', t('preset.anthropic')], ['fishAudio', t('preset.fish')],
      ['elevenLabs', t('preset.elevenLabs')],
      ['localEmbedding', t('preset.localEmbedding')],
    ] });
    const url = field(form, 'provider.url', previous?.baseUrl?.startsWith('REPLACE_WITH_') ? '' : previous?.baseUrl || '', { required: '' });
    const environment = field(form, 'provider.environment', previous?.apiKeyEnv || '', { maxlength: 80 });
    const key = field(form, 'provider.key', '', { type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: 8192 });
    form.append(el('p', t('provider.keyHelp')));
    const metadata = effective.secrets[selected];
    form.append(el('p', t(metadata?.apiKey?.has ? 'provider.present' : 'provider.absent', { suffix: metadata?.apiKey?.last4 ? ' …' + metadata.apiKey.last4 : '' })));
    const deleteKey = checkbox(form, 'provider.deleteKey');
    const flagBox = details(form, 'provider.flags');
    const flags = Object.fromEntries([
      ['supportsImages', 'flag.images'], ['supportsStt', 'flag.stt'], ['supportsVerboseStt', 'flag.verbose'],
      ['supportsJsonMode', 'flag.json'], ['supportsStreamUsage', 'flag.usage'],
    ].map(([name, label]) => [name, checkbox(flagBox, label, previous?.flags?.[name] === true)]));
    const warning = el('p', '', { role: 'status' }); form.append(warning);
    const checkUrl = () => {
      try {
        warning.textContent = validateBaseUrl(url.value, { websocket: adapter.value === 'fishAudio' }).insecureTransport ? t('warning.http') : '';
        url.removeAttribute('aria-invalid');
      } catch { warning.textContent = t('error.invalid'); url.setAttribute('aria-invalid', 'true'); }
    };
    url.addEventListener('change', checkUrl); adapter.addEventListener('change', checkUrl);
    preset.addEventListener('change', () => {
      const value = presets.find(item => item.id === preset.value);
      adapter.value = value.adapter; url.value = value.baseUrl; key.value = '';
      environment.value = value.apiKeyEnv || '';
      checkUrl(); if (value.maintainerVerificationRequired) warning.textContent += ' ' + t('warning.preset');
    });
    submit(form, () => withSecret(key, async apiKey => {
      validateBaseUrl(url.value, { websocket: adapter.value === 'fishAudio' });
      const name = identifier.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw { code: 'INVALID_SETTINGS' };
      const profile = { ...previous, adapter: adapter.value, baseUrl: url.value.trim(), apiKeyEnv: environment.value.trim() || null,
        flags: Object.fromEntries(Object.entries(flags).map(([name, input]) => [name, input.checked])) };
      const changed = originNeedsConfirmation(previous, profile, metadata);
      if (changed && !apiKey && !deleteKey.checked) throw { code: 'ORIGIN_CHANGE' };
      if (changed && !apiKey && !confirm(t('confirm.origin'))) return;
      await change(async () => {
        await write('/profiles/' + name, { profile, ...(apiKey && { secrets: { apiKey } }),
          ...(changed && !apiKey && { confirmDeleteSecrets: true }) }); selected = name;
      });
    }));
    if (selected) button(t('action.delete'), async () => {
      if (!confirm(t('confirm.delete', { id: selected }))) return;
      await change(async () => { await write('/profiles/' + selected, { force: true }, 'DELETE'); selected = null; }, form);
      message('toast.deleted');
    }, form).className = 'settings-danger';
    trackForm(form, () => {
      clearSecrets(form);
      forms.delete(form);
      const next = providers(host);
      parent.replaceWith(next.parentElement || next.parent);
      return next;
    });
    return form;
  }
  function resultView(parent, result, threshold) {
    parent.replaceChildren(el('p', t(result.ok ? 'test.success' : 'test.failure')));
    const table = el('table'); parent.append(table);
    for (const [label, value] of [['test.ttft', result.ttftMs], ['test.total', result.latencyMs],
      ['test.tokens', (result.tokens?.inputTokens ?? '—') + ' / ' + (result.tokens?.outputTokens ?? '—')]]) {
      const row = el('tr'); row.append(el('th', t(label), { scope: 'row' }), el('td', value ?? '—')); table.append(row);
    }
    if (result.error) parent.append(el('p', t(friendlyError(result.error.code)) + ' (' + result.error.code + ')'));
    if (result.ttftMs > threshold) parent.append(el('p', t('test.slow')));
  }
  function slotEditor(parent, name) {
    const current = effective.settings.slots[name];
    const previous = current?.followLlm ? effective.settings.slots.llm : current;
    const form = el('form', undefined, { class: 'settings-card', autocomplete: 'off', 'data-slot': name }); parent.append(form);
    form.append(el('h3', t(SLOT_LABELS[name])));
    let follow;
    if (['planner', 'visionFilter', 'surface', 'reflection', 'memoryWriter'].includes(name)) {
      follow = checkbox(form, 'slot.follow', current?.followLlm || (!current && effective.sources['slots.' + name] === 'default'));
    }
    const options = [['', t('slot.unassigned')], ...Object.entries(effective.settings.profiles)
      .filter(([, value]) => value && (name === 'memoryEmbedding' ? value.adapter === 'localEmbedding' : value.adapter !== 'localEmbedding')).map(([id]) => [id, id])];
    const profile = field(form, 'slot.profile', previous?.profile || selected || '', { options });
    const model = field(form, 'slot.model', previous?.model || '', { required: '', maxlength: 256 });
    const models = el('datalist', undefined, { id: 'settings-models-' + name }); form.append(models); model.setAttribute('list', models.id);
    const modelNotice = el('p', '', { 'aria-live': 'polite' }); form.append(modelNotice);
    const advanced = details(form, 'slot.advanced');
    const oneTimeKey = field(advanced, 'provider.key', '', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
    button(t('action.models'), () => withSecret(oneTimeKey, async apiKey => {
      busy = true;
      try {
        const response = await api.write('/models', { profile: profile.value, ...(apiKey && { apiKey }) }, 'POST');
        models.replaceChildren(...response.models.map(name => el('option', name, { value: name })));
        modelNotice.textContent = response.reason ? t('test.missingModels', { code: response.reason }) : '';
      } finally { busy = false; }
    }), form);
    const params = previous?.params || {};
    const samplingBox = el('div', undefined, { class: 'settings-field-grid' }); advanced.append(samplingBox);
    const temperature = name === 'memoryEmbedding' ? { value: '' } : field(samplingBox, 'slot.temperature', params.temperature ?? (name === 'tts' ? DEFAULT_TTS_PARAMS.temperature : ''), { type: 'number', min: 0, max: 2, step: name === 'tts' ? 'any' : 0.1 });
    const maxTokens = name === 'memoryEmbedding' ? { value: '' } : field(samplingBox, 'slot.maxTokens', params.maxTokens ?? '', { type: 'number', min: 1, max: 1000000 });
    if (name === 'memoryEmbedding') form.append(el('p', t('memory.providerHelp')));
    const extra = {};
    const ttsFields = {};
    const elevenLabsFields = {};
    let syncProvider;
    let isElevenLabs = () => false;
    if (name === 'stt') extra.language = field(form, 'slot.language', params.language || 'id');
    if (name === 'tts') {
      extra.voice = field(form, 'slot.voice', params.voice || '');
      const fishVoiceHelp = el('p', t('tts.fishVoiceHelp'), { id: extra.voice.id + '-help' }); form.append(fishVoiceHelp);
      const formats = ['mp3', 'wav', 'opus', ...(params.format === 'pcm' ? ['pcm'] : [])];
      extra.format = field(form, 'slot.format', params.format || 'mp3', { options: formats.map(format => [format, format.toUpperCase()]) });
      const fishBox = el('div', undefined, { 'data-tts-provider': 'fishAudio', class: 'settings-field-grid' }); advanced.append(fishBox);
      const elevenBox = el('div', undefined, { 'data-tts-provider': 'elevenLabs', class: 'settings-field-grid' }); advanced.append(elevenBox);
      const eleven = { ...DEFAULT_ELEVENLABS_PARAMS, ...params.elevenLabs };
      elevenLabsFields.stability = field(elevenBox, 'tts.elevenStability', eleven.stability, { type: 'number', min: 0, max: 1, step: 'any' });
      const v3Stability = field(elevenBox, 'tts.elevenStability', [0, 0.5, 1].includes(eleven.stability) ? eleven.stability : 0.5, { options: [[0, '0'], [0.5, '0.5'], [1, '1']] });
      elevenLabsFields.similarityBoost = field(elevenBox, 'tts.elevenSimilarity', eleven.similarityBoost, { type: 'number', min: 0, max: 1, step: 'any' });
      elevenLabsFields.speed = field(elevenBox, 'tts.speed', eleven.speed, { type: 'number', min: 0.7, max: 1.2, step: 'any' });
      elevenLabsFields.emotionTags = checkbox(elevenBox, 'tts.elevenEmotionTags', eleven.emotionTags);
      const elevenHelp = el('p', t('tts.elevenHelp')); elevenBox.append(elevenHelp);
      const defaults = DEFAULT_TTS_PARAMS;
      const expression = { ...defaults.expression, ...params.expression,
        emotionTagMap: { ...defaults.expression.emotionTagMap, ...params.expression?.emotionTagMap } };
      const merge = { ...defaults.expression.mergeShortSentences, ...params.expression?.mergeShortSentences };
      const inline = { ...defaults.inlineTags, ...params.inlineTags };
      ttsFields.topP = field(fishBox, 'tts.topP', params.topP ?? defaults.topP, { type: 'number', min: 0, max: 1, step: 'any' });
      ttsFields.latency = field(fishBox, 'tts.latency', params.latency ?? defaults.latency, { options: [
        ['normal', t('tts.latencyNormal')], ['balanced', t('tts.latencyBalanced')], ['low', t('tts.latencyLow')],
      ] });
      ttsFields.speed = field(fishBox, 'tts.speed', params.prosody?.speed ?? defaults.prosody.speed, { type: 'number', min: 0.5, max: 2, step: 'any' });
      ttsFields.volume = field(fishBox, 'tts.volume', params.prosody?.volume ?? defaults.prosody.volume, { type: 'number', min: -20, max: 20, step: 'any' });
      const expressionBox = details(form, 'tts.expression');
      const fishExpression = el('div', undefined, { 'data-tts-provider': 'fishAudio' }); expressionBox.append(fishExpression);
      ttsFields.selection = field(fishExpression, 'tts.selection', expression.selection, { options: [
        ['native', t('tts.selectionNative')], ['mapped', t('tts.selectionMapped')],
      ] });
      fishExpression.append(el('p', t('tts.selectionHelp')));
      ttsFields.tagPlacement = field(fishExpression, 'tts.placement', expression.tagPlacement, { options: [
        ['every-sentence', t('tts.everySentence')], ['first-only', t('tts.firstOnly')],
      ] });
      ttsFields.maxTagsPerSentence = field(fishExpression, 'tts.tagCap', expression.maxTagsPerSentence, { type: 'number', min: 0, max: 2, step: 1 });
      ttsFields.earlyFirstSentence = checkbox(expressionBox, 'tts.earlyFirstSentence', expression.earlyFirstSentence);
      ttsFields.segmentPauseMs = field(expressionBox, 'tts.segmentPauseMs', expression.segmentPauseMs, { type: 'number', min: 0, max: 400, step: 1 });
      ttsFields.sentencePauseMs = field(expressionBox, 'tts.sentencePauseMs', expression.sentencePauseMs, { type: 'number', min: 0, max: 400, step: 1 });
      expressionBox.append(el('p', t('tts.sentencePauseHelp')));
      const catalogueBox = details(fishExpression, 'tts.emotionPresets');
      catalogueBox.append(el('p', t('tts.emotionPresetsHelp')));
      const mappingBox = details(fishExpression, 'tts.customEmotionMap');
      ttsFields.emotionTagMap = field(mappingBox, 'tts.emotionMap', JSON.stringify(expression.emotionTagMap, null, 2), { type: 'textarea', rows: 8, maxlength: 8192, spellcheck: 'false' });
      const selectors = new Map();
      const setTagOptions = (input, value) => {
        input.replaceChildren(el('option', t('tts.noTag'), { value: '' }));
        for (const group of FISH_EMOTION_GROUPS) {
          const options = el('optgroup', undefined, { label: t(group.labelKey) });
          for (const tag of group.tags) options.append(el('option', `${t(tag.labelKey)} ${tag.tag}`, { value: tag.tag }));
          input.append(options);
        }
        if (value && !FISH_EMOTION_TAGS.some(tag => tag.tag === value)) {
          input.append(el('option', t('tts.customTag', { tag: value }), { value }));
        }
        input.value = value;
      };
      const syncSelections = map => {
        for (const [emotion, inputs] of selectors) {
          const values = emotionMapSelections(map, emotion);
          inputs.forEach((input, index) => setTagOptions(input, values[index]));
        }
      };
      for (const emotion of Object.keys(defaults.expression.emotionTagMap)) {
        const row = el('fieldset', undefined, { class: 'settings-emotion-row', 'data-avatar-emotion': emotion });
        row.append(el('legend', t('tts.avatarEmotion', { emotion })));
        catalogueBox.append(row);
        const inputs = [field(row, 'tts.firstTag', '', { options: [] }), field(row, 'tts.secondTag', '', { options: [] })];
        selectors.set(emotion, inputs);
        inputs.forEach(input => input.addEventListener('change', () => {
          try {
            const map = JSON.parse(ttsFields.emotionTagMap.value);
            ttsFields.emotionTagMap.value = JSON.stringify(updateEmotionSelection(map, emotion, inputs[0].value, inputs[1].value), null, 2);
          } catch { fail({ code: 'INVALID_SETTINGS' }); }
        }));
      }
      syncSelections(expression.emotionTagMap);
      for (const event of ['input', 'change']) ttsFields.emotionTagMap.addEventListener(event, () => {
        try {
          const map = JSON.parse(ttsFields.emotionTagMap.value);
          if (!map || typeof map !== 'object' || Array.isArray(map)) return;
          syncSelections(map);
        } catch { /* Keep current selections until the JSON editor contains a valid map. */ }
      });
      fishExpression.append(el('p', t('tts.neutralExperimental')));
      ttsFields.mergeEnabled = checkbox(expressionBox, 'tts.mergeEnabled', merge.enabled);
      ttsFields.minChars = field(expressionBox, 'tts.minChars', merge.minChars, { type: 'number', min: 1, max: 1000, step: 1 });
      ttsFields.maxChars = field(expressionBox, 'tts.maxChars', merge.maxChars, { type: 'number', min: 1, max: 4000, step: 1 });
      const styleBox = details(form, 'tts.speechStyle');
      ttsFields.speechStyleEnabled = checkbox(styleBox, 'tts.speechStyleEnabled', params.speechStyle?.enabled ?? defaults.speechStyle.enabled);
      ttsFields.inlineEnabled = checkbox(styleBox, 'tts.inlineEnabled', inline.enabled);
      ttsFields.inlineAllowList = field(styleBox, 'tts.inlineAllowList', inline.allowList.join(', '), { maxlength: 2592 });
      ttsFields.inlineMaxPerSentence = field(styleBox, 'tts.inlineCap', inline.maxPerSentence, { type: 'number', min: 0, max: 2, step: 1 });
      ttsFields.debug = checkbox(styleBox, 'tts.debug', params.debug ?? defaults.debug);
      styleBox.append(el('p', t('tts.debugHelp')));
      isElevenLabs = () => effective.settings.profiles[profile.value]?.adapter === 'elevenLabs';
      let draftProfile = profile.value;
      const voiceDrafts = new Map([[draftProfile, extra.voice.value]]);
      const modelDrafts = new Map([[draftProfile, model.value]]);
      const formatDrafts = new Map([[draftProfile, extra.format.value]]);
      const visibility = (element, hidden) => {
        if (hidden) element.setAttribute('hidden', ''); else element.removeAttribute('hidden');
        const disable = item => {
          if (['input', 'select', 'textarea'].includes(item.tagName.toLowerCase())) item.disabled = hidden;
          for (const child of item.children) disable(child);
        };
        disable(element);
      };
      const labelOf = input => document.getElementById(input.id)?.parentElement || input.parent;
      const updateModelControls = () => {
        const v3 = model.value === 'eleven_v3';
        const inactive = !isElevenLabs();
        visibility(labelOf(elevenLabsFields.stability), inactive || v3);
        visibility(labelOf(v3Stability), inactive || !v3);
        visibility(labelOf(elevenLabsFields.similarityBoost), inactive || v3);
        visibility(labelOf(elevenLabsFields.speed), inactive || v3);
        visibility(labelOf(elevenLabsFields.emotionTags), inactive || !v3);
        elevenHelp.textContent = t(v3 ? 'tts.elevenV3Help' : 'tts.elevenHelp');
      };
      const updateProviderControls = () => {
        const eleven = isElevenLabs();
        const fish = effective.settings.profiles[profile.value]?.adapter === 'fishAudio';
        visibility(fishVoiceHelp, !fish);
        if (fish) extra.voice.setAttribute('aria-describedby', fishVoiceHelp.id); else extra.voice.removeAttribute('aria-describedby');
        for (const box of [samplingBox, fishBox, fishExpression, styleBox]) visibility(box, eleven);
        visibility(elevenBox, !eleven);
        extra.format.replaceChildren(...(eleven ? ['mp3'] : formats).map(format => el('option', format.toUpperCase(), { value: format })));
        extra.format.value = eleven ? 'mp3' : formatDrafts.get(draftProfile) || 'mp3';
        if (eleven) extra.voice.setAttribute('required', ''); else extra.voice.removeAttribute('required');
        if (eleven) models.replaceChildren(...ELEVENLABS_MODELS.map(value => el('option', value, { value })));
        updateModelControls();
      };
      profile.addEventListener('change', () => {
        voiceDrafts.set(draftProfile, extra.voice.value);
        modelDrafts.set(draftProfile, model.value);
        formatDrafts.set(draftProfile, extra.format.value);
        draftProfile = profile.value;
        extra.voice.value = voiceDrafts.get(draftProfile) ?? '';
        model.value = modelDrafts.get(draftProfile) ?? (isElevenLabs() ? 'eleven_flash_v2_5' : '');
        oneTimeKey.value = ''; models.replaceChildren(); modelNotice.textContent = '';
        updateProviderControls();
      });
      for (const event of ['input', 'change']) model.addEventListener(event, updateModelControls);
      if (isElevenLabs() && !model.value) model.value = 'eleven_flash_v2_5';
      updateProviderControls();
      syncProvider = updateProviderControls;
      elevenLabsFields.v3Stability = v3Stability;
    }
    const timeouts = Object.fromEntries(['firstByteMs', 'idleMs', 'totalMs'].map((key, i) => [key,
      field(advanced, ['slot.firstByte', 'slot.idle', 'slot.total'][i], previous?.timeouts?.[key] ?? [20000, 20000, 60000][i], { type: 'number', min: 0, max: 300000 })]));
    const extras = field(advanced, 'slot.extras', JSON.stringify({ bodyExtras: params.bodyExtras || {}, omitParams: params.omitParams || [] }, null, 2), { type: 'textarea', rows: 5, spellcheck: 'false' });
    const extrasWarning = el('p', '', { 'aria-live': 'polite' }); advanced.append(extrasWarning);
    extras.addEventListener('input', () => {
      try {
        extrasWarning.textContent = parseAdvanced(extras.value).credentials ? t('warning.credentials') : '';
        extras.removeAttribute('aria-invalid');
      } catch { extrasWarning.textContent = t('error.invalid'); extras.setAttribute('aria-invalid', 'true'); }
    });
    advanced.remove(); form.append(advanced);
    submit(form, async () => {
      if (follow?.checked) {
        await change(() => write('/slots/' + name, { slot: { followLlm: true } }));
        return;
      }
      const text = extras.value;
      if (/key|token|secret|password|authorization|credential|cookie/i.test(text)) extras.value = '';
      const eleven = isElevenLabs();
      const readFields = fields => Object.fromEntries(Object.entries(fields).map(([key, input]) =>
        [key, input.type === 'checkbox' ? input.checked : input.value]));
      const elevenFields = { ...elevenLabsFields, stability: model.value === 'eleven_v3' ? elevenLabsFields.v3Stability : elevenLabsFields.stability };
      delete elevenFields.v3Stability;
      if (model.value === 'eleven_v3') { delete elevenFields.similarityBoost; delete elevenFields.speed; }
      const timingFields = Object.fromEntries(['earlyFirstSentence', 'segmentPauseMs', 'sentencePauseMs', 'mergeEnabled', 'minChars', 'maxChars'].map(key => [key, ttsFields[key]]));
      const slot = makeSlot({ profile: profile.value, model: model.value, adapter: effective.settings.profiles[profile.value]?.adapter,
        temperature: eleven ? '' : temperature.value, maxTokens: eleven ? '' : maxTokens.value,
        advanced: text, ...Object.fromEntries(Object.entries(extra).map(([name, input]) => [name, input.value])),
        ...(name === 'tts' && (eleven ? { elevenLabs: readFields(elevenFields), ttsTiming: readFields(timingFields) } : { tts: readFields(ttsFields) })),
        ...Object.fromEntries(Object.entries(timeouts).map(([name, input]) => [name, input.value])) }, previous || {});
      await change(async () => {
        await write('/slots/' + name, { slot });
        if (name === 'llm') for (const advancedName of ['planner', 'visionFilter', 'surface', 'reflection', 'memoryWriter']) {
          if (!effective.settings.slots[advancedName] && effective.sources['slots.' + advancedName] === 'default') {
            await write('/slots/' + advancedName, { slot: { followLlm: true } });
          }
        }
      });
    });
    button(t('action.unassign'), async () => {
      if (name === 'llm' && !allowLeave()) return;
      if (confirm(t('confirm.unassign'))) await change(() => write('/slots/' + name, { slot: null }), form);
    }, form).className = 'settings-danger';
    const testOptions = details(form, 'slot.testOptions');
    const timeout = field(testOptions, 'slot.probeTimeout', 20000, { type: 'number', min: 1000, max: 60000 });
    const threshold = field(testOptions, 'slot.threshold', 5000, { type: 'number', min: 100, max: 60000 });
    const result = el('div', '', { 'aria-live': 'polite', role: 'status' }); form.append(result);
    button(t('action.test'), async () => {
      busy = true;
      try {
        const phases = { connecting: 'test.connecting', first_byte: 'test.firstByte', done: 'test.done' };
        const response = await api.test({ slot: name, profile: profile.value, model: model.value, timeoutMs: Number(timeout.value) }, phase => { result.textContent = t(phases[phase]); });
        resultView(result, response, Number(threshold.value));
      } finally { busy = false; }
    }, form);
    if (follow) {
      const syncFollow = () => {
        for (const input of walk(form).filter(item => fieldRecords.has(item))) {
          if (input !== follow) input.disabled = follow.checked;
        }
        model.required = !follow.checked;
      };
      follow.addEventListener('change', syncFollow); syncFollow();
    }
    trackForm(form, () => replaceForm(form, () => slotEditor(parent, name)));
    forms.get(form).syncProvider = syncProvider;
    return form;
  }
  function statusView(parent) {
    parent.append(el('h2', t('tab.status')));
    parent.append(el('p', t('status.backend') + ': ' + status.backendName));
    parent.append(el('p', t('status.version') + ': ' + effective.version));
    for (const [name, value] of Object.entries(status.slots)) {
      const item = el('section', undefined, { class: 'settings-card' }); parent.append(item);
      item.append(el('h3', t(SLOT_LABELS[name])), el('p', t(value.available ? 'status.ready' : 'status.unavailable')));
      if (value.reason) item.append(el('p', t('status.reason', { reason: value.reason })));
    }
    let warning = false;
    for (const code of status.warningCodes || []) if (STATUS_WARNING_KEYS[code]) {
      parent.append(el('p', t(STATUS_WARNING_KEYS[code]))); warning = true;
    }
    if (status.backendName === 'plaintext-file') { parent.append(el('p', t('warning.plaintext'))); warning = true; }
    if (status.backendName === 'env') { parent.append(el('p', t('warning.windowsFirst'))); warning = true; }
    if (Object.values(status.slots).some(value => value.insecureTransport)) { parent.append(el('p', t('warning.http'))); warning = true; }
    if (!warning) parent.append(el('p', t('status.noWarnings')));
  }
  function privacy(parent) {
    parent.append(el('h2', t('tab.privacy')), el('p', t('privacy.intro')));
    for (const flow of privacyFlows(effective.settings)) {
      const item = el('section', undefined, { class: 'settings-card' }); parent.append(item);
      item.append(el('h3', t(flow.label)), el('p', flow.origin || t('slot.unassigned')), el('a', t('privacy.controls'), { href: '/' + flow.toggle }));
    }
    parent.append(el('h3', t('privacy.images')), el('p', t(effective.settings.images?.provider === 'cloud' ? 'images.privacyCloud' : 'privacy.local')));
  }
  function languages(parent) {
    const form = el('form', undefined, { class: 'settings-card' }); parent.append(form);
    const input = field(form, 'language.choose', language, { options: [['id', t('language.id')], ['en', t('language.en')]] });
    submit(form, () => change(() => write('/ui', { ui: { language: input.value } })));
    trackForm(form, () => replaceForm(form, () => { languages(parent); return parent.lastElementChild; }));
    return input;
  }
  function diagnostics(parent) {
    parent.append(el('h2', t('tab.diagnostics')), el('p', t('diagnostics.help')));
    const report = el('div', '', { 'aria-live': 'polite' });
    button(t('diagnostics.run'), async () => {
      busy = true;
      try {
        const data = await api.write('/diagnostics', {}, 'POST');
        report.replaceChildren(el('p', t('status.backend') + ': ' + data.backendName), el('p', t('status.version') + ': ' + data.version));
        report.append(el('h3', t('diagnostics.permissions')), el('p', t(data.permissionNote === 'WINDOWS_ACL_UNVERIFIED' ? 'diagnostics.acl' : 'diagnostics.owner')));
        if (data.writable) report.append(el('p', t('diagnostics.writable')));
        for (const [name, value] of Object.entries(data.locations)) report.append(el('p', name + ': ' + value));
        for (const [name, value] of Object.entries(data.locks)) report.append(el('p', name + ': ' + t('diagnostics.lock', { state: value.state })));
        report.append(el('p', t('diagnostics.backups', { count: data.corruptBackups })), el('p', t(data.selfTest.code === 'READ_ONLY' ? 'diagnostics.readOnly' : data.selfTest.ok ? 'test.success' : 'test.failure')));
        if (data.selfTest.code) report.append(el('code', data.selfTest.code));
      } finally { busy = false; }
    }, parent); parent.append(report);
  }
  function wizardView(parent) {
    const index = WIZARD_STEPS.indexOf(wizard.step);
    const progress = el('ol', undefined, { class: 'settings-wizard-progress', 'aria-label': t('wizard.title') }); parent.append(progress);
    WIZARD_LABELS.forEach((label, number) => {
      const step = el('li', undefined, { 'data-completed': String(number < index) });
      if (number === index) step.setAttribute('aria-current', 'step');
      step.append(el('span', String(number + 1)), el('span', t(label))); progress.append(step);
    });
    parent.append(el('p', t('wizard.step', { number: index + 1, total: WIZARD_STEPS.length })), el('h3', t(WIZARD_LABELS[index])));
    if (wizard.step === 'language') languages(parent);
    else if (['llm', 'tts', 'stt', 'vision'].includes(wizard.step)) { providers(parent); slotEditor(parent, wizard.step); }
    else if (wizard.step === 'privacy') privacy(parent);
    else if (wizard.step === 'images') {
      imageController = mountImageSettings(parent, { document, api, t, fail, onDirtyChange: updateNavigation, onVersion: version => { effective.version = version; } });
      imageController.ready.then(updateNavigation);
      parent.append(el('a', t('wizard.setupDocs'), { href: setupGuide, download: 'setup.md' }));
    } else parent.append(el('p', t('wizard.finished')));
    const nav = el('div', undefined, { class: 'settings-actions' }); parent.append(nav);
    if (index) button(t('action.back'), () => advance('back'), nav);
    if (wizard.step === 'finish') button(t('action.finish'), () => {
      if (!allowLeave()) return;
      wizard = moveWizard(wizard, 'finish'); saveWizard(storage, wizard); showWizard = false; renderContent(); updateNavigation();
    }, nav);
    else {
      const next = button(t(['vision', 'images', 'tts', 'stt'].includes(wizard.step) && !effective.settings.slots[wizard.step]?.profile ? 'action.skip' : 'action.next'), async () => {
        advance('next');
      }, nav);
      next.id = 'settings-wizard-next';
      if (wizard.step === 'llm' && !effective.settings.slots.llm?.profile) { next.disabled = true; parent.append(el('p', t('wizard.chatRequired'))); }
    }
  }
  function advance(action) {
    if (!allowLeave()) return;
    wizard = moveWizard(wizard, action); saveWizard(storage, wizard); renderContent(); updateNavigation();
  }
  const pageHelp = { chat: 'settings.chatHelp', voice: 'settings.voiceHelp', vision: 'settings.visionHelp',
    images: 'settings.imagesHelp', memory: 'settings.memoryHelp', connections: 'settings.providersHelp',
    language: 'settings.languageHelp', status: 'settings.statusHelp', privacy: 'privacy.intro', diagnostics: 'diagnostics.help' };
  function navigate(name) {
    if (busy || !allowLeave()) { if (mobileNavigation) mobileNavigation.value = showWizard ? 'setup' : tab; return; }
    tab = name; showWizard = false; toast.textContent = ''; renderContent(); updateNavigation(); content.focus();
  }
  function updateNavigation() {
    if (!heading) return;
    heading.textContent = t(showWizard ? 'wizard.title' : TAB_LABELS[tab]);
    headingHelp.textContent = t(showWizard ? 'settings.setupHelp' : pageHelp[tab]);
    for (const [name, item] of tabButtons) {
      const selected = !showWizard && tab === name;
      item.setAttribute('aria-selected', String(selected)); item.setAttribute('tabindex', selected ? '0' : '-1');
    }
    if (mobileNavigation) mobileNavigation.value = showWizard ? 'setup' : tab;
    const next = document.getElementById('settings-wizard-next');
    if (next && wizard.step === 'llm') next.disabled = !effective.settings.slots.llm?.profile;
    if (next && ['tts', 'stt', 'vision', 'images'].includes(wizard.step)) {
      const configured = wizard.step === 'images' ? imageController?.savedProvider && imageController.savedProvider !== 'auto' : effective.settings.slots[wizard.step]?.profile;
      next.textContent = t(configured ? 'action.next' : 'action.skip');
    }
  }
  function renderContent() {
    imageController?.dispose(); imageController = undefined;
    memoryController?.dispose(); memoryController = undefined;
    clearSecrets(content); forms.clear(); content.replaceChildren();
    if (showWizard) wizardView(content);
    else if (tab === 'connections') providers(content);
    else if (['chat', 'voice', 'vision'].includes(tab)) {
      const main = { chat: ['llm'], voice: ['tts', 'stt'], vision: ['vision'] };
      const roles = { chat: ['surface', 'reflection', 'router', 'planner'], voice: [], vision: ['visionFilter'] };
      for (const name of main[tab]) slotEditor(content, name);
      if (roles[tab].length) {
        const advanced = details(content, 'slot.advanced');
        advanced.append(el('h3', t('slot.title')));
        for (const name of roles[tab]) slotEditor(advanced, name);
        if (tab === 'chat') advanced.append(el('p', t('slot.conversationRolesHelp')));
      }
      button(t('action.manageProviders'), () => navigate('connections'), content);
    } else if (tab === 'images') imageController = mountImageSettings(content, { document, api, t, fail, onDirtyChange: updateNavigation, onVersion: version => { effective.version = version; } });
    else if (tab === 'memory') {
      memoryController = mountMemorySettings(content, { document, api, t, fail, confirm, onVersion: version => { effective.version = version; } });
      const advanced = details(content, 'slot.advanced');
      for (const name of ['memoryWriter', 'memoryEmbedding']) slotEditor(advanced, name);
    } else if (tab === 'status') statusView(content);
    else if (tab === 'privacy') privacy(content);
    else if (tab === 'diagnostics') diagnostics(content);
    else languages(content);
    updateNavigation();
  }
  function render() {
    imageController?.dispose(); imageController = undefined;
    memoryController?.dispose(); memoryController = undefined;
    document.documentElement.lang = language; document.title = t('app.title');
    forms.clear(); tabButtons.clear();
    const header = el('header', undefined, { class: 'settings-header' });
    const brand = el('div', undefined, { class: 'settings-brand' });
    if (document.createElementNS) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 30 34'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'settings-crystal');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M15 2 28 12 15 32 2 12Z M2 12H28 M15 2V32');
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
      svg.append(path); brand.append(svg);
    }
    brand.append(el('h1', t('app.title'))); header.append(brand);
    const back = el('a', t('app.back'), { href: '/' });
    back.addEventListener('click', event => { if (!allowLeave()) event.preventDefault(); }); header.append(back);
    const controls = el('div', undefined, { class: 'settings-actions' }); header.append(controls);
    button(t('action.refresh'), refresh, controls);
    button(t('wizard.restart'), () => {
      if (!allowLeave()) return;
      wizard = readWizard(null); showWizard = true; saveWizard(storage, wizard); renderContent(); updateNavigation();
    }, controls);
    const layout = el('div', undefined, { class: 'settings-layout' });
    root.replaceChildren(header, toast, layout);
    const sidebar = el('aside', undefined, { class: 'settings-sidebar' }); layout.append(sidebar);
    const tabs = el('div', undefined, { role: 'tablist', 'aria-label': t('app.title'), 'aria-orientation': 'vertical' }); sidebar.append(tabs);
    for (const [groupLabel, names] of [['nav.companion', ['chat', 'voice', 'vision', 'images', 'memory']], ['nav.application', ['connections', 'language', 'status', 'privacy', 'diagnostics']]]) {
      const group = el('section', undefined, { class: 'settings-nav-group' }); tabs.append(group);
      group.append(el('h2', t(groupLabel)));
      const links = el('div', undefined, { class: 'settings-tabs' }); group.append(links);
      for (const name of names) {
      const item = button(t(TAB_LABELS[name]), () => navigate(name), links); tabButtons.set(name, item);
      item.id = 'settings-tab-' + name; item.setAttribute('data-settings-tab', name);
      item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(!showWizard && tab === name)); item.setAttribute('aria-controls', 'settings-content');
      item.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const siblings = [...tabButtons.values()]; const index = siblings.indexOf(item);
        const next = siblings[event.key === 'Home' ? 0 : event.key === 'End' ? siblings.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + siblings.length) % siblings.length];
        for (const sibling of siblings) sibling.setAttribute('tabindex', sibling === next ? '0' : '-1');
        next.focus();
      });
      }
    }
    const workspace = el('div', undefined, { class: 'settings-workspace' }); layout.append(workspace);
    const mobileLabel = el('label', t('nav.section'), { class: 'settings-mobile-nav', for: 'settings-section' });
    mobileNavigation = el('select', undefined, { id: 'settings-section' }); mobileLabel.append(mobileNavigation); workspace.append(mobileLabel);
    mobileNavigation.append(el('option', t('wizard.title'), { value: 'setup', disabled: '' }));
    for (const [name, label] of Object.entries(TAB_LABELS)) mobileNavigation.append(el('option', t(label), { value: name }));
    mobileNavigation.addEventListener('change', () => navigate(mobileNavigation.value));
    const pageHeading = el('div', undefined, { class: 'settings-page-heading' }); workspace.append(pageHeading);
    heading = el('h2', undefined, { id: 'settings-page-title' }); headingHelp = el('p'); pageHeading.append(heading, headingHelp);
    content = el('section', undefined, { id: 'settings-content', role: 'tabpanel', tabindex: '-1', 'aria-labelledby': 'settings-page-title' }); workspace.append(content);
    renderContent();
  }
  document.defaultView?.addEventListener('beforeunload', event => {
    if (!dirty() && !busy && !walk(root).some(item => item.getAttribute?.('aria-busy') === 'true')) return;
    event.preventDefault(); event.returnValue = '';
  });
  try { await load(); showWizard = needsWizard(status, effective.settings) || !wizard.completed && wizard.step !== 'language'; render(); }
  catch (error) { root.replaceChildren(el('h1', t('app.title')), toast); fail(error); button(t('action.refresh'), () => window.location.reload(), root); }
}

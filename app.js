/* FormForge: privacy-first form builder. All data lives in IndexedDB on this device. */
(function () {
  'use strict';
  var FIELD_TYPES = [
    { type: 'text', label: 'Short text' },
    { type: 'email', label: 'Email' },
    { type: 'number', label: 'Number' },
    { type: 'date', label: 'Date' },
    { type: 'select', label: 'Dropdown' },
    { type: 'radio', label: 'Radio buttons' },
    { type: 'checkbox', label: 'Checkboxes' },
    { type: 'textarea', label: 'Long answer' }
  ];
  var CHOICE_TYPES = ['select', 'radio', 'checkbox'];
  var TEXT_TYPES = ['text', 'textarea'];
  var state = { forms: [], responses: [], currentFormId: null, selectedFieldId: null, view: 'dashboard', editingFormId: null, deleteArmedId: null, previewMode: 'desktop' };
  var db = null;

  function uid() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function $ (id) { return document.getElementById(id); }
  function setStatus(msg, isError) { var el = $('statusMsg'); el.textContent = msg || ''; el.className = 'status' + (isError ? ' error' : ''); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  function typeLabel(t) { var f = FIELD_TYPES.find(function (x) { return x.type === t; }); return f ? f.label : t; }
  function getForm(id) { return state.forms.find(function (f) { return f.id === id; }); }
  function currentForm() { return getForm(state.currentFormId) || state.forms[0] || null; }
  function download(name, content, mime) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: mime })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); }

  /* ---------- IndexedDB ---------- */
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('FormForgeDB', 1);
      req.onupgradeneeded = function () { var d = req.result; if (!d.objectStoreNames.contains('forms')) d.createObjectStore('forms', { keyPath: 'id' }); if (!d.objectStoreNames.contains('responses')) { var s = d.createObjectStore('responses', { keyPath: 'id' }); s.createIndex('formId', 'formId', { unique: false }); } };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function txDone(tx) { return new Promise(function (res, rej) { tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error); }; }); }
  function loadAll() {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['forms', 'responses'], 'readonly');
      var fReq = tx.objectStore('forms').getAll(); var rReq = tx.objectStore('responses').getAll();
      tx.oncomplete = function () { resolve({ forms: fReq.result || [], responses: rReq.result || [] }); };
      tx.onerror = function () { reject(tx.error); };
    });
  }
  function putForm(form) { return new Promise(function (res, rej) { var tx = db.transaction('forms', 'readwrite'); tx.objectStore('forms').put(form); tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; }); }
  function deleteFormAndResponses(formId) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['forms', 'responses'], 'readwrite');
      tx.objectStore('forms').delete(formId);
      var idx = tx.objectStore('responses').index('formId'); var cur = idx.openCursor(IDBKeyRange.only(formId));
      cur.onsuccess = function () { var c = cur.result; if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
    });
  }
  function putResponse(resp) { return new Promise(function (res, rej) { var tx = db.transaction('responses', 'readwrite'); tx.objectStore('responses').put(resp); tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; }); }
  function deleteResponse(id) { return new Promise(function (res, rej) { var tx = db.transaction('responses', 'readwrite'); tx.objectStore('responses').delete(id); tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; }); }
  function saveAllForms() { return Promise.all(state.forms.map(putForm)); }

  /* ---------- Validation (shared rules) ---------- */
  function isVisible(field, answers) {
    if (!field.showIf) return true;
    var src = answers[field.showIf.fieldId];
    if (Array.isArray(src)) return src.indexOf(field.showIf.value) !== -1;
    return src === field.showIf.value;
  }
  function validateField(field, value) {
    var empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty) return field.required ? 'This field is required.' : null;
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address.';
    if (field.type === 'number') { var n = Number(value); if (isNaN(n)) return 'Enter a number.'; if (field.min !== null && field.min !== undefined && n < field.min) return 'Must be at least ' + field.min + '.'; if (field.max !== null && field.max !== undefined && n > field.max) return 'Must be at most ' + field.max + '.'; return null; }
    if (TEXT_TYPES.indexOf(field.type) !== -1) {
      if (field.minLength !== null && field.minLength !== undefined && value.length < field.minLength) return 'Must be at least ' + field.minLength + ' characters.';
      if (field.maxLength !== null && field.maxLength !== undefined && value.length > field.maxLength) return 'Must be at most ' + field.maxLength + ' characters.';
    }
    if (field.type === 'date' && isNaN(Date.parse(value))) return 'Enter a valid date.';
    if (CHOICE_TYPES.indexOf(field.type) !== -1) { var vals = Array.isArray(value) ? value : [value]; for (var i = 0; i < vals.length; i++) { if (field.options.indexOf(vals[i]) === -1) return 'Choose one of the listed options.'; } }
    return null;
  }
  function newField(type) {
    var f = { id: uid(), type: type, label: typeLabel(type), description: '', placeholder: '', required: false, options: CHOICE_TYPES.indexOf(type) !== -1 ? ['Option 1', 'Option 2'] : [], minLength: null, maxLength: null, min: null, max: null, showIf: null };
    return f;
  }

  /* ---------- Form rendering (fill + preview) ---------- */
  function readBlockValue(block, field) {
    if (field.type === 'checkbox') { var out = []; block.querySelectorAll('input[type="checkbox"]:checked').forEach(function (c) { out.push(c.value); }); return out; }
    if (field.type === 'radio') { var r = block.querySelector('input[type="radio"]:checked'); return r ? r.value : ''; }
    var inp = block.querySelector('input, select, textarea'); return inp ? inp.value : '';
  }
  function collectAnswers(container, form) {
    var answers = {}; var blocks = container.querySelectorAll('[data-field-id]');
    blocks.forEach(function (block) {
      if (block.classList.contains('hidden')) return;
      var field = form.fields.find(function (f) { return f.id === block.getAttribute('data-field-id'); });
      if (field) answers[field.id] = readBlockValue(block, field);
    });
    return answers;
  }
  function refreshVisibility(container, form) {
    var answers = {}; container.querySelectorAll('[data-field-id]').forEach(function (block) {
      var field = form.fields.find(function (f) { return f.id === block.getAttribute('data-field-id'); });
      if (field) answers[field.id] = readBlockValue(block, field);
    });
    container.querySelectorAll('[data-field-id]').forEach(function (block) {
      var field = form.fields.find(function (f) { return f.id === block.getAttribute('data-field-id'); });
      if (!field) return;
      var show = isVisible(field, answers);
      block.classList.toggle('hidden', !show);
      block.querySelectorAll('input, select, textarea').forEach(function (inp) { inp.disabled = !show; });
      if (!show) block.querySelectorAll('.err').forEach(function (e) { e.textContent = ''; });
    });
  }
  function renderFormInto(container, form, opts) {
    container.innerHTML = '';
    var prefix = opts.prefix;
    if (!form || !form.fields.length) return;
    var title = el('h2', null, form.title); container.appendChild(title);
    if (form.description) container.appendChild(el('p', 'desc', form.description));
    form.fields.forEach(function (field) {
      var block = el('div', 'fieldblock'); block.setAttribute('data-field-id', field.id);
      var lab = el('label', null, field.label + (field.required ? ' *' : ''));
      if (field.type !== 'radio' && field.type !== 'checkbox') lab.setAttribute('for', prefix + '-' + field.id);
      block.appendChild(lab);
      if (field.description) block.appendChild(el('p', 'desc', field.description));
      var input;
      if (field.type === 'select') {
        input = document.createElement('select'); input.id = prefix + '-' + field.id;
        var blank = document.createElement('option'); blank.value = ''; blank.textContent = field.placeholder || 'Choose…'; input.appendChild(blank);
        field.options.forEach(function (o) { var op = document.createElement('option'); op.value = o; op.textContent = o; input.appendChild(op); });
      } else if (field.type === 'radio' || field.type === 'checkbox') {
        var wrap = el('div', 'opts');
        field.options.forEach(function (o, i) {
          var l = el('label'); var inp = document.createElement('input'); inp.type = field.type; inp.name = prefix + '-' + field.id; inp.value = o; inp.id = prefix + '-' + field.id + '-' + i; l.appendChild(inp); l.appendChild(document.createTextNode(o)); wrap.appendChild(l);
        });
        block.appendChild(wrap);
      } else {
        input = document.createElement(field.type === 'textarea' ? 'textarea' : 'input');
        input.id = prefix + '-' + field.id;
        if (field.type !== 'textarea') input.type = field.type;
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.type === 'number') { if (field.min !== null && field.min !== undefined) input.min = field.min; if (field.max !== null && field.max !== undefined) input.max = field.max; }
      }
      if (input) block.appendChild(input);
      var errEl = el('p', 'err', ''); errEl.setAttribute('role', 'alert'); block.appendChild(errEl);
      container.appendChild(block);
    });
    container.addEventListener('change', function () { refreshVisibility(container, form); });
    container.addEventListener('input', function () { refreshVisibility(container, form); });
    refreshVisibility(container, form);
    if (opts.submitLabel) {
      var btn = el('button', 'primary', opts.submitLabel); btn.type = 'submit'; container.appendChild(btn);
    }
  }
  function submitRendered(container, form) {
    var ok = true; var answers = collectAnswers(container, form);
    container.querySelectorAll('[data-field-id]').forEach(function (block) {
      if (block.classList.contains('hidden')) return;
      var field = form.fields.find(function (f) { return f.id === block.getAttribute('data-field-id'); });
      var err = validateField(field, answers[field.id]);
      block.querySelector('.err').textContent = err || '';
      if (err) ok = false;
    });
    return ok ? answers : null;
  }

  /* ---------- Views ---------- */
  function showView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    $('view-' + view).classList.remove('hidden');
    document.querySelectorAll('.navbtn').forEach(function (b) { var active = b.getAttribute('data-view') === view; b.classList.toggle('active', active); if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (view === 'dashboard') renderDashboard();
    if (view === 'builder') renderBuilder();
    if (view === 'fill') renderFill();
    if (view === 'responses') renderResponses();
  }
  function fillSelect(sel, forms, selectedId) {
    sel.innerHTML = '';
    forms.forEach(function (f) { var o = document.createElement('option'); o.value = f.id; o.textContent = f.title; if (f.id === selectedId) o.selected = true; sel.appendChild(o); });
  }

  /* Dashboard */
  function renderDashboard() {
    var q = ($('formSearch').value || '').toLowerCase();
    var list = $('formList'); list.innerHTML = '';
    var shown = state.forms.filter(function (f) { return !q || f.title.toLowerCase().indexOf(q) !== -1; });
    $('formEmpty').classList.toggle('hidden', state.forms.length > 0);
    $('formEmpty').textContent = state.forms.length === 0 ? 'No forms yet. Create your first form to get started.' : 'No forms match that search.';
    shown.forEach(function (form) {
      var card = el('article', 'card');
      if (state.editingFormId === form.id) {
        var inp = document.createElement('input'); inp.value = form.title; inp.setAttribute('aria-label', 'Form title'); card.appendChild(inp);
        var save = el('button', 'primary', 'Save title');
        save.addEventListener('click', function () { var t = inp.value.trim(); if (!t) { setStatus('A form title cannot be empty.', true); return; } form.title = t; form.updatedAt = new Date().toISOString(); state.editingFormId = null; putForm(form).then(renderDashboard); setStatus('Form renamed.'); });
        var cancel = el('button', null, 'Cancel');
        cancel.addEventListener('click', function () { state.editingFormId = null; renderDashboard(); });
        var acts = el('div', 'actions'); acts.appendChild(save); acts.appendChild(cancel); card.appendChild(acts);
      } else {
        card.appendChild(el('h3', null, form.title));
        if (form.description) card.appendChild(el('p', null, form.description));
        card.appendChild(el('p', null, form.fields.length + ' field' + (form.fields.length === 1 ? '' : 's') + ' · ' + state.responses.filter(function (r) { return r.formId === form.id; }).length + ' responses'));
        var acts2 = el('div', 'actions');
        var mk = function (label, fn, cls) { var b = el('button', cls || null, label); b.addEventListener('click', fn); acts2.appendChild(b); };
        mk('Build', function () { state.currentFormId = form.id; showView('builder'); });
        mk('Fill', function () { state.currentFormId = form.id; showView('fill'); });
        mk('Responses', function () { state.currentFormId = form.id; showView('responses'); });
        mk('Duplicate', function () {
          var copy = JSON.parse(JSON.stringify(form)); var oldToNew = {}; copy.fields.forEach(function (fld) { var nid = uid(); oldToNew[fld.id] = nid; fld.id = nid; });
          copy.fields.forEach(function (fld) { if (fld.showIf && oldToNew[fld.showIf.fieldId]) fld.showIf.fieldId = oldToNew[fld.showIf.fieldId]; });
          copy.id = uid(); copy.title = form.title + ' (copy)'; copy.createdAt = new Date().toISOString(); copy.updatedAt = copy.createdAt;
          state.forms.unshift(copy); putForm(copy).then(renderDashboard); setStatus('Form duplicated.');
        });
        mk('Rename', function () { state.editingFormId = form.id; renderDashboard(); });
        var delLabel = state.deleteArmedId === form.id ? 'Confirm delete?' : 'Delete';
        mk(delLabel, function () {
          if (state.deleteArmedId !== form.id) { state.deleteArmedId = form.id; renderDashboard(); return; }
          state.deleteArmedId = null; deleteFormAndResponses(form.id).then(function () { state.forms = state.forms.filter(function (f) { return f.id !== form.id; }); state.responses = state.responses.filter(function (r) { return r.formId !== form.id; }); renderDashboard(); setStatus('Form and its responses deleted.'); });
        }, 'danger');
        card.appendChild(acts2);
      }
      list.appendChild(card);
    });
  }

  /* Builder */
  function renderBuilder() {
    var form = currentForm();
    fillSelect($('builderFormSelect'), state.forms, form ? form.id : null);
    var pal = $('palette'); pal.innerHTML = '';
    FIELD_TYPES.forEach(function (t) { var b = el('button', null, '+ ' + t.label); b.addEventListener('click', function () { if (!form) { setStatus('Create a form first.', true); return; } var f = newField(t.type); form.fields.push(f); form.updatedAt = new Date().toISOString(); state.selectedFieldId = f.id; putForm(form).then(renderBuilder); }); pal.appendChild(b); });
    if (!form) { $('formTitleInput').value = ''; $('formDescInput').value = ''; $('canvas').innerHTML = ''; $('canvasEmpty').classList.remove('hidden'); renderProps(null); renderPreview(null); return; }
    $('formTitleInput').value = form.title; $('formDescInput').value = form.description || '';
    var canvas = $('canvas'); canvas.innerHTML = '';
    $('canvasEmpty').classList.toggle('hidden', form.fields.length > 0);
    form.fields.forEach(function (field, idx) {
      var card = el('article', 'fieldcard' + (state.selectedFieldId === field.id ? ' selected' : ''));
      card.draggable = true; card.setAttribute('data-index', idx); card.setAttribute('data-field-id', field.id);
      card.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', String(idx)); });
      card.addEventListener('dragover', function (e) { e.preventDefault(); });
      card.addEventListener('drop', function (e) { e.preventDefault(); var from = Number(e.dataTransfer.getData('text/plain')); if (isNaN(from) || from === idx) return; var moved = form.fields.splice(from, 1)[0]; form.fields.splice(idx, 0, moved); form.updatedAt = new Date().toISOString(); putForm(form).then(renderBuilder); });
      var head = el('header');
      head.appendChild(el('span', 'drag', '⠿ ' + field.label));
      head.appendChild(el('span', 'mini', typeLabel(field.type) + (field.required ? ' · Required' : '') + (field.showIf ? ' · Conditional' : '')));
      card.appendChild(head);
      if (field.description) card.appendChild(el('p', 'mini', field.description));
      var acts = el('div', 'actions');
      var mk = function (label, fn) { var b = el('button', null, label); b.addEventListener('click', fn); acts.appendChild(b); };
      mk('Edit', function () { state.selectedFieldId = field.id; renderBuilder(); });
      mk('Move up', function () { if (idx === 0) return; var m = form.fields.splice(idx, 1)[0]; form.fields.splice(idx - 1, 0, m); putForm(form).then(renderBuilder); });
      mk('Move down', function () { if (idx === form.fields.length - 1) return; var m = form.fields.splice(idx, 1)[0]; form.fields.splice(idx + 1, 0, m); putForm(form).then(renderBuilder); });
      mk('Duplicate', function () { var c = JSON.parse(JSON.stringify(field)); c.id = uid(); c.label = field.label + ' (copy)'; c.showIf = null; form.fields.splice(idx + 1, 0, c); putForm(form).then(renderBuilder); });
      mk('Delete', function () { form.fields = form.fields.filter(function (f) { return f.id !== field.id; }); form.fields.forEach(function (f) { if (f.showIf && f.showIf.fieldId === field.id) f.showIf = null; }); if (state.selectedFieldId === field.id) state.selectedFieldId = null; putForm(form).then(renderBuilder); });
      card.appendChild(acts); canvas.appendChild(card);
    });
    var sel = form.fields.find(function (f) { return f.id === state.selectedFieldId; }) || null;
    renderProps(sel, form); renderPreview(form);
  }
  function renderProps(field, form) {
    var pf = $('propsForm');
    if (!field || !form) { pf.classList.add('hidden'); $('propsEmpty').classList.remove('hidden'); return; }
    $('propsEmpty').classList.add('hidden'); pf.classList.remove('hidden');
    $('propLabel').value = field.label; $('propDesc').value = field.description || ''; $('propPlaceholder').value = field.placeholder || ''; $('propRequired').checked = !!field.required;
    $('propOptionsWrap').classList.toggle('hidden', CHOICE_TYPES.indexOf(field.type) === -1);
    $('propTextWrap').classList.toggle('hidden', TEXT_TYPES.indexOf(field.type) === -1);
    $('propNumWrap').classList.toggle('hidden', field.type !== 'number');
    if (CHOICE_TYPES.indexOf(field.type) !== -1) $('propOptions').value = field.options.join('\n');
    if (TEXT_TYPES.indexOf(field.type) !== -1) { $('propMinLen').value = field.minLength === null || field.minLength === undefined ? '' : field.minLength; $('propMaxLen').value = field.maxLength === null || field.maxLength === undefined ? '' : field.maxLength; }
    if (field.type === 'number') { $('propMin').value = field.min === null || field.min === undefined ? '' : field.min; $('propMax').value = field.max === null || field.max === undefined ? '' : field.max; }
    var condSel = $('propCondField'); condSel.innerHTML = '';
    var none = document.createElement('option'); none.value = ''; none.textContent = 'Always show'; condSel.appendChild(none);
    form.fields.forEach(function (f) { if (f.id === field.id) return; if (f.type === 'select' || f.type === 'radio') { var o = document.createElement('option'); o.value = f.id; o.textContent = f.label; if (field.showIf && field.showIf.fieldId === f.id) o.selected = true; condSel.appendChild(o); } });
    rebuildCondValues(field, form);
    pf.dataset.fieldId = field.id;
  }
  function rebuildCondValues(field, form) {
    var valSel = $('propCondValue'); valSel.innerHTML = '';
    var srcId = $('propCondField').value;
    if (!srcId) { var o = document.createElement('option'); o.value = ''; o.textContent = '—'; valSel.appendChild(o); return; }
    var src = form.fields.find(function (f) { return f.id === srcId; });
    (src ? src.options : []).forEach(function (opt) { var o = document.createElement('option'); o.value = opt; o.textContent = opt; if (field.showIf && field.showIf.value === opt) o.selected = true; valSel.appendChild(o); });
  }
  function selectedField() { var form = currentForm(); if (!form) return null; return form.fields.find(function (f) { return f.id === state.selectedFieldId; }) || null; }
  function updateSelected(mutator, rerenderCanvas) {
    var form = currentForm(); var field = selectedField(); if (!form || !field) return;
    mutator(field); form.updatedAt = new Date().toISOString();
    putForm(form).then(function () {
      if (rerenderCanvas) { renderBuilder(); return; }
      var card = document.querySelector('.canvas [data-field-id="' + field.id + '"]');
      if (card) { var drag = card.querySelector('.drag'); if (drag) drag.textContent = '⠿ ' + field.label; }
      renderPreview(form);
    });
  }
  function renderPreview(form) {
    var wrap = $('previewWrap'); wrap.className = 'previewwrap ' + state.previewMode;
    var cont = $('previewForm'); cont.innerHTML = '';
    if (!form || !form.fields.length) { cont.appendChild(el('p', 'empty', 'Add fields to see a preview.')); return; }
    renderFormInto(cont, form, { prefix: 'preview' });
  }

  /* Fill */
  function renderFill() {
    var form = currentForm();
    fillSelect($('fillFormSelect'), state.forms, form ? form.id : null);
    var cont = $('fillForm'); cont.innerHTML = '';
    if (!form || !form.fields.length) { $('fillEmpty').classList.remove('hidden'); return; }
    $('fillEmpty').classList.add('hidden');
    renderFormInto(cont, form, { prefix: 'fill', submitLabel: 'Submit response' });
    cont.onsubmit = function (e) {
      e.preventDefault();
      if (!form.fields.length) { setStatus('This form has no fields yet.', true); return; }
      var answers = submitRendered(cont, form);
      if (!answers) { setStatus('Fix the errors above and try again.', true); return; }
      var resp = { id: uid(), formId: form.id, createdAt: new Date().toISOString(), answers: answers };
      putResponse(resp).then(function () { state.responses.push(resp); setStatus('Response saved on this device.'); cont.reset(); refreshVisibility(cont, form); });
    };
  }

  /* Responses + CSV */
  function csvEscape(v) { var s = v === undefined || v === null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function formToCsv(form, responses) {
    var header = form.fields.map(function (f) { return csvEscape(f.label); }).join(',');
    var rows = responses.map(function (r) { return form.fields.map(function (f) { var v = r.answers[f.id]; return csvEscape(Array.isArray(v) ? v.join('; ') : (v === undefined ? '' : v)); }).join(','); });
    return [header].concat(rows).join('\r\n');
  }
  function renderResponses() {
    var form = currentForm();
    fillSelect($('respFormSelect'), state.forms, form ? form.id : null);
    var list = $('respList'); list.innerHTML = '';
    if (!form) { $('respEmpty').classList.remove('hidden'); return; }
    var q = ($('respSearch').value || '').toLowerCase();
    var rows = state.responses.filter(function (r) { return r.formId === form.id; }).filter(function (r) {
      if (!q) return true;
      return Object.keys(r.answers).some(function (k) { var v = r.answers[k]; return String(Array.isArray(v) ? v.join(' ') : v).toLowerCase().indexOf(q) !== -1; }) || r.createdAt.toLowerCase().indexOf(q) !== -1;
    });
    $('respEmpty').classList.toggle('hidden', rows.length > 0);
    rows.slice().reverse().forEach(function (r) {
      var item = el('article', 'respitem');
      item.appendChild(el('p', null, 'Submitted ' + new Date(r.createdAt).toLocaleString()));
      var dl = document.createElement('dl');
      form.fields.forEach(function (f) { var v = r.answers[f.id]; if (v === undefined) return; dl.appendChild(el('dt', null, f.label)); dl.appendChild(el('dd', null, Array.isArray(v) ? v.join(', ') : String(v))); });
      item.appendChild(dl);
      var del = el('button', 'danger', 'Delete response');
      del.addEventListener('click', function () { deleteResponse(r.id).then(function () { state.responses = state.responses.filter(function (x) { return x.id !== r.id; }); renderResponses(); setStatus('Response deleted.'); }); });
      item.appendChild(del); list.appendChild(item);
    });
  }

  /* Backup validation + atomic restore */
  function fail(msg) { throw new Error(msg); }
  function validateBackup(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Backup must be a JSON object.');
    if (data.app !== 'FormForge') fail('This backup is not a FormForge backup.');
    if (data.version !== 1) fail('Unsupported backup version. Expected version 1.');
    if (!Array.isArray(data.forms) || !Array.isArray(data.responses)) fail('Backup must contain forms and responses arrays.');
    var formIds = {}; var respIds = {};
    data.forms.forEach(function (form) {
      if (!form || typeof form.id !== 'string' || !form.id) fail('Each form needs a non-empty id.');
      if (formIds[form.id]) fail('Duplicate form id in backup: ' + form.id); formIds[form.id] = true;
      if (typeof form.title !== 'string' || !form.title.trim()) fail('Each form needs a title.');
      if (typeof form.description !== 'string') fail('Form description must be a string.');
      if (!Array.isArray(form.fields)) fail('Each form needs a fields array.');
      var fieldIds = {};
      form.fields.forEach(function (f) {
        if (!f || typeof f.id !== 'string' || !f.id) fail('Each field needs a non-empty id.');
        if (fieldIds[f.id]) fail('Duplicate field id in backup: ' + f.id); fieldIds[f.id] = true;
        if (FIELD_TYPES.map(function (t) { return t.type; }).indexOf(f.type) === -1) fail('Unknown field type: ' + f.type);
        if (typeof f.label !== 'string' || !f.label.trim()) fail('Each field needs a label.');
        if (!Array.isArray(f.options)) fail('Field options must be an array.');
        if (CHOICE_TYPES.indexOf(f.type) !== -1 && f.options.length === 0) fail('Choice fields need at least one option.');
        if (f.options.some(function (o) { return typeof o !== 'string' || !o; })) fail('Field options must be non-empty strings.');
        if (f.showIf !== null && f.showIf !== undefined) {
          if (!f.showIf || typeof f.showIf.fieldId !== 'string' || typeof f.showIf.value !== 'string') fail('Conditional rule is malformed.');
        }
      });
      form.fields.forEach(function (f) {
        if (f.showIf) { var src = form.fields.find(function (x) { return x.id === f.showIf.fieldId; }); if (!src || (src.type !== 'select' && src.type !== 'radio')) fail('Conditional rule points to a missing or non-choice field.'); if (src.options.indexOf(f.showIf.value) === -1) fail('Conditional value is not one of the source options.'); }
      });
      form.fields.forEach(function (f) {
        function fHas(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
        ['minLength', 'maxLength'].forEach(function (k) { if (fHas(f, k) && f[k] !== null && (!Number.isInteger(f[k]) || f[k] < 0)) fail('Invalid ' + k + '.'); });
        if (fHas(f, 'min') && f.min !== null && typeof f.min !== 'number') fail('Invalid minimum value.');
        if (fHas(f, 'max') && f.max !== null && typeof f.max !== 'number') fail('Invalid maximum value.');
        if (f.min !== null && f.min !== undefined && f.max !== null && f.max !== undefined && f.min > f.max) fail('Minimum cannot exceed maximum.');
        if (f.minLength !== null && f.minLength !== undefined && f.maxLength !== null && f.maxLength !== undefined && f.minLength > f.maxLength) fail('Minimum length cannot exceed maximum length.');
      });
    });
    data.responses.forEach(function (r) {
      if (!r || typeof r.id !== 'string' || !r.id) fail('Each response needs a non-empty id.');
      if (respIds[r.id]) fail('Duplicate response id in backup: ' + r.id); respIds[r.id] = true;
      if (!formIds[r.formId]) fail('Response points to an unknown form.');
      if (typeof r.createdAt !== 'string' || isNaN(Date.parse(r.createdAt))) fail('Response needs a valid date.');
      if (!r.answers || typeof r.answers !== 'object') fail('Response needs an answers object.');
      var form = data.forms.find(function (f) { return f.id === r.formId; });
      Object.keys(r.answers).forEach(function (k) { if (!form.fields.some(function (f) { return f.id === k; })) fail('Response answer points to an unknown field.'); });
    });
    return data;
  }
  function importBackup(data) {
    var valid = validateBackup(data);
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['forms', 'responses'], 'readwrite');
      tx.objectStore('forms').clear(); tx.objectStore('responses').clear();
      valid.forms.forEach(function (f) { tx.objectStore('forms').put(f); });
      valid.responses.forEach(function (r) { tx.objectStore('responses').put(r); });
      tx.oncomplete = function () { state.forms = valid.forms; state.responses = valid.responses; state.currentFormId = state.forms.length ? state.forms[0].id : null; state.selectedFieldId = null; resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('Import aborted.')); };
    });
  }

  /* Standalone form file */
  function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function buildStandalone(form) {
    var fieldsJson = JSON.stringify(form.fields).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    var title = escHtml(form.title); var desc = escHtml(form.description || '');
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + title + '</title>\n<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1c1917}label{display:block;font-weight:700;margin-top:1rem}input,select,textarea{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:12px;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1rem;border-radius:12px;border:0;background:#6d28d9;color:#fff;cursor:pointer}.err{color:#b91c1c;font-weight:600}.hidden{display:none}.opts label{font-weight:400;display:flex;gap:.5rem}.opts input{width:auto}small{color:#57534e}</style>\n</head>\n<body>\n<h1>' + title + '</h1>\n' + (desc ? '<p>' + desc + '</p>\n' : '') + '<p><small>This standalone form runs entirely on your device. It does not send your answers anywhere. Export them below when done.</small></p>\n<form id="f" novalidate></form>\n<button type="button" id="expJson">Download answers (JSON)</button>\n<button type="button" id="expCsv">Download answers (CSV)</button>\n<script>\nvar FIELDS=' + fieldsJson + ';\nvar form=document.getElementById("f");\nfunction esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}\nfunction visible(field,ans){if(!field.showIf)return true;var v=ans[field.showIf.fieldId];return Array.isArray(v)?v.indexOf(field.showIf.value)!==-1:v===field.showIf.value}\nfunction blockVal(b,field){if(field.type==="checkbox"){var o=[];b.querySelectorAll("input:checked").forEach(function(c){o.push(c.value)});return o}if(field.type==="radio"){var r=b.querySelector("input:checked");return r?r.value:""}var i=b.querySelector("input,select,textarea");return i?i.value:""}\nfunction collect(){var a={};document.querySelectorAll("[data-fid]").forEach(function(b){if(b.classList.contains("hidden"))return;a[b.getAttribute("data-fid")]=blockVal(b,FIELDS.find(function(x){return x.id===b.getAttribute("data-fid")}))});return a}\nfunction refresh(){var a=collect();document.querySelectorAll("[data-fid]").forEach(function(b){var fld=FIELDS.find(function(x){return x.id===b.getAttribute("data-fid")});var show=visible(fld,a);b.classList.toggle("hidden",!show);b.querySelectorAll("input,select,textarea").forEach(function(i){i.disabled=!show})})}\nFIELDS.forEach(function(field){var b=document.createElement("div");b.setAttribute("data-fid",field.id);var l=document.createElement("label");l.textContent=field.label+(field.required?" *":"");b.appendChild(l);if(field.description){var d=document.createElement("small");d.textContent=field.description;b.appendChild(d)}\nif(field.type==="select"){var s=document.createElement("select");var bl=document.createElement("option");bl.value="";bl.textContent=field.placeholder||"Choose…";s.appendChild(bl);field.options.forEach(function(o){var op=document.createElement("option");op.value=o;op.textContent=o;s.appendChild(op)});b.appendChild(s)}else if(field.type==="radio"||field.type==="checkbox"){var w=document.createElement("div");w.className="opts";field.options.forEach(function(o){var lb=document.createElement("label");var inp=document.createElement("input");inp.type=field.type;inp.name=field.id;inp.value=o;lb.appendChild(inp);lb.appendChild(document.createTextNode(o));w.appendChild(lb)});b.appendChild(w)}else{var inp2=document.createElement(field.type==="textarea"?"textarea":"input");if(field.type!=="textarea")inp2.type=field.type;if(field.placeholder)inp2.placeholder=field.placeholder;b.appendChild(inp2)}\nvar e=document.createElement("p");e.className="err";e.setAttribute("role","alert");b.appendChild(e);form.appendChild(b)});\nvar sub=document.createElement("button");sub.type="submit";sub.textContent="Check answers";form.appendChild(sub);\nform.addEventListener("input",refresh);form.addEventListener("change",refresh);refresh();\nform.addEventListener("submit",function(ev){ev.preventDefault();var ans=collect();var ok=true;document.querySelectorAll("[data-fid]").forEach(function(b){if(b.classList.contains("hidden"))return;var fld=FIELDS.find(function(x){return x.id===b.getAttribute("data-fid")});var v=ans[fld.id];var empty=v===""||v==null||(Array.isArray(v)&&!v.length);var err="";if(empty&&fld.required)err="This field is required.";else if(fld.type==="email"&&v&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v))err="Enter a valid email address.";else if(fld.type==="number"&&v!==""){var n=Number(v);if(isNaN(n))err="Enter a number.";else if(fld.min!=null&&n<fld.min)err="Must be at least "+fld.min+".";else if(fld.max!=null&&n>fld.max)err="Must be at most "+fld.max+"."}\nb.querySelector(".err").textContent=err;if(err)ok=false});if(ok)alert("All visible answers look valid. Use the export buttons to download them.")});\nfunction dl(name,txt){var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([txt],{type:"text/plain"}));a.download=name;a.click()}\ndocument.getElementById("expJson").onclick=function(){dl("answers.json",JSON.stringify(collect(),null,2))};\ndocument.getElementById("expCsv").onclick=function(){function q(v){var s=v==null?"":String(v);return /[",\\n\\r]/.test(s)?\'"\'+s.replace(/"/g,\'""\')+\'"\':s}var a=collect();var h=FIELDS.map(function(f){return q(f.label)}).join(",");var row=FIELDS.map(function(f){var v=a[f.id];return q(Array.isArray(v)?v.join("; "):(v==null?"":v))}).join(",");dl("answers.csv",h+"\\r\\n"+row)};\n<\/script>\n</body>\n</html>\n';
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    document.querySelectorAll('.navbtn').forEach(function (b) { b.addEventListener('click', function () { showView(b.getAttribute('data-view')); }); });
    $('newFormBtn').addEventListener('click', function () {
      var form = { id: uid(), title: 'Untitled form', description: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), fields: [] };
      state.forms.unshift(form); state.currentFormId = form.id; state.selectedFieldId = null;
      putForm(form).then(function () { setStatus('Form created. Add fields in the builder.'); showView('builder'); });
    });
    $('formSearch').addEventListener('input', renderDashboard);
    $('respSearch').addEventListener('input', renderResponses);
    $('builderFormSelect').addEventListener('change', function (e) { state.currentFormId = e.target.value; state.selectedFieldId = null; renderBuilder(); });
    $('fillFormSelect').addEventListener('change', function (e) { state.currentFormId = e.target.value; renderFill(); });
    $('respFormSelect').addEventListener('change', function (e) { state.currentFormId = e.target.value; renderResponses(); });
    $('formTitleInput').addEventListener('input', function (e) { var form = currentForm(); if (!form) return; form.title = e.target.value; form.updatedAt = new Date().toISOString(); putForm(form); });
    $('formDescInput').addEventListener('input', function (e) { var form = currentForm(); if (!form) return; form.description = e.target.value; form.updatedAt = new Date().toISOString(); putForm(form); });
    $('previewBtn').addEventListener('click', function () { var form = currentForm(); if (!form) { setStatus('Create a form first.', true); return; } showView('fill'); });
    $('previewDesktopBtn').addEventListener('click', function () { state.previewMode = 'desktop'; renderPreview(currentForm()); });
    $('previewMobileBtn').addEventListener('click', function () { state.previewMode = 'mobile'; renderPreview(currentForm()); });
    $('downloadStandaloneBtn').addEventListener('click', function () { var form = currentForm(); if (!form) { setStatus('Create a form first.', true); return; } if (!form.fields.length) { setStatus('Add at least one field before downloading.', true); return; } download(form.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-form.html', buildStandalone(form), 'text/html'); setStatus('Standalone form downloaded.'); });
    $('exportCsvBtn').addEventListener('click', function () { var form = currentForm(); if (!form) { setStatus('No form selected.', true); return; } var rows = state.responses.filter(function (r) { return r.formId === form.id; }); download(form.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-responses.csv', formToCsv(form, rows), 'text/csv'); setStatus('CSV exported (' + rows.length + ' responses).'); });
    $('exportBackupBtn').addEventListener('click', function () { download('formforge-backup.json', JSON.stringify({ app: 'FormForge', version: 1, exportedAt: new Date().toISOString(), forms: state.forms, responses: state.responses }, null, 2), 'application/json'); setStatus('Backup exported.'); });
    $('importBackupInput').addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return; e.target.value = '';
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try { parsed = JSON.parse(reader.result); } catch (err) { setStatus('Import failed: file is not valid JSON. Your data was not changed.', true); return; }
        try { validateBackup(parsed); } catch (err) { setStatus('Import failed: ' + err.message + ' Your data was not changed.', true); return; }
        importBackup(parsed).then(function () { setStatus('Backup restored.'); showView('dashboard'); }).catch(function () { setStatus('Import failed and your existing data was not changed.', true); });
      };
      reader.readAsText(file);
    });
    $('themeBtn').addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
      try { localStorage.setItem('formforge-theme', dark ? 'light' : 'dark'); } catch (err) {}
      $('themeBtn').textContent = dark ? 'Dark mode' : 'Light mode';
    });
    /* Props editing: update field, re-render preview; canvas re-render only on structural changes */
    $('propLabel').addEventListener('input', function (e) { updateSelected(function (f) { f.label = e.target.value; }, false); });
    $('propDesc').addEventListener('input', function (e) { updateSelected(function (f) { f.description = e.target.value; }, false); });
    $('propPlaceholder').addEventListener('input', function (e) { updateSelected(function (f) { f.placeholder = e.target.value; }, false); });
    $('propRequired').addEventListener('change', function (e) { updateSelected(function (f) { f.required = e.target.checked; }, false); });
    $('propOptions').addEventListener('input', function (e) { updateSelected(function (f) { f.options = e.target.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }, false); });
    $('propMinLen').addEventListener('change', function (e) { updateSelected(function (f) { f.minLength = e.target.value === '' ? null : parseInt(e.target.value, 10); }, false); });
    $('propMaxLen').addEventListener('change', function (e) { updateSelected(function (f) { f.maxLength = e.target.value === '' ? null : parseInt(e.target.value, 10); }, false); });
    $('propMin').addEventListener('change', function (e) { updateSelected(function (f) { f.min = e.target.value === '' ? null : Number(e.target.value); }, false); });
    $('propMax').addEventListener('change', function (e) { updateSelected(function (f) { f.max = e.target.value === '' ? null : Number(e.target.value); }, false); });
    $('propCondField').addEventListener('change', function () {
      var form = currentForm(); var field = selectedField(); if (!form || !field) return;
      rebuildCondValues(field, form);
      var val = $('propCondValue').value;
      updateSelected(function (f) { f.showIf = $('propCondField').value ? { fieldId: $('propCondField').value, value: val } : null; }, true);
    });
    $('propCondValue').addEventListener('change', function () {
      updateSelected(function (f) { f.showIf = $('propCondField').value ? { fieldId: $('propCondField').value, value: $('propCondValue').value } : null; }, true);
    });
    $('deleteFieldBtn').addEventListener('click', function () {
      var form = currentForm(); var field = selectedField(); if (!form || !field) return;
      form.fields = form.fields.filter(function (f) { return f.id !== field.id; });
      form.fields.forEach(function (f) { if (f.showIf && f.showIf.fieldId === field.id) f.showIf = null; });
      state.selectedFieldId = null; putForm(form).then(renderBuilder); setStatus('Field deleted.');
    });
  }

  /* ---------- Init ---------- */
  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(function () {}); }
  try { var savedTheme = localStorage.getItem('formforge-theme'); if (savedTheme === 'dark') { document.documentElement.setAttribute('data-theme', 'dark'); $('themeBtn').textContent = 'Light mode'; } } catch (err) {}
  bindEvents();
  openDB().then(function (d) { db = d; return loadAll(); }).then(function (data) {
    state.forms = data.forms; state.responses = data.responses;
    if (state.forms.length) state.currentFormId = state.forms[0].id;
    showView('dashboard'); setStatus('');
  }).catch(function () { setStatus('Storage is unavailable in this browser, so forms cannot be saved. Try a different browser.', true); showView('dashboard'); });
})();

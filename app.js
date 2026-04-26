// ============================================================
// DATABASE (IndexedDB)
// ============================================================

const DB_NAME = 'lernkarten';
const DB_VER  = 2;
let db;

function dbInit() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onerror = () => rej(req.error);
    req.onsuccess = () => { db = req.result; res(); };
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('gruppen'))
        d.createObjectStore('gruppen', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('studenten')) {
        const s = d.createObjectStore('studenten', { keyPath: 'id' });
        s.createIndex('gruppeId', 'gruppeId');
      }
      if (!d.objectStoreNames.contains('sitzungen'))
        d.createObjectStore('sitzungen', { keyPath: 'id' });
    };
  });
}

function dbGetAll(store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror  = () => rej(req.error);
  });
}

function dbPut(store, item) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(item);
    req.onsuccess = () => res();
    req.onerror  = () => rej(req.error);
  });
}

function dbDelete(store, id) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    req.onsuccess = () => res();
    req.onerror  = () => rej(req.error);
  });
}

function dbClear(store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).clear();
    req.onsuccess = () => res();
    req.onerror  = () => rej(req.error);
  });
}

// ============================================================
// STATE
// ============================================================

let gruppen   = [];
let studenten = [];

const urlCache = new Map();
function getFotoUrl(s) {
  if (!urlCache.has(s.id)) urlCache.set(s.id, URL.createObjectURL(s.foto));
  return urlCache.get(s.id);
}
function revokeUrl(id) {
  if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
}

// learning
let lernKarten    = [];
let lernIndex     = 0;
let nameVisible   = false;
let gewusst       = 0;
let nichtGewusst  = 0;
let lernModus     = 'foto'; // 'foto' = Foto→Name, 'name' = Name→Foto
const answeredIds     = new Set();
const gewusstIds      = new Set();
const nichtGewusstIds = new Set();

// edit modal
let editModalMode      = 'edit';
let editModalStudentId = null;

// collapsible groups
const openGruppen = new Set();
function saveOpenGruppen() {
  localStorage.setItem('openGruppen', JSON.stringify([...openGruppen]));
}
function ladeOpenGruppen() {
  try {
    const saved = localStorage.getItem('openGruppen');
    if (saved) JSON.parse(saved).forEach(id => openGruppen.add(id));
  } catch(e) {}
}

// Gruppen-Reihenfolge
let gruppenReihenfolge = [];
function saveGruppenReihenfolge() {
  localStorage.setItem('gruppenReihenfolge', JSON.stringify(gruppenReihenfolge));
}
function ladeGruppenReihenfolge() {
  try {
    const saved = localStorage.getItem('gruppenReihenfolge');
    if (saved) gruppenReihenfolge = JSON.parse(saved);
  } catch(e) {}
}
function getSortierteGruppen() {
  if (!gruppenReihenfolge.length) return gruppen;
  const ordered = [];
  gruppenReihenfolge.forEach(id => {
    const g = gruppen.find(x => x.id === id);
    if (g) ordered.push(g);
  });
  gruppen.forEach(g => { if (!gruppenReihenfolge.includes(g.id)) ordered.push(g); });
  return ordered;
}

// import buffer
let importDatenBuffer = null;

// feedback
function zeigeFeedback(typ) {
  const fb = document.getElementById('lern-feedback');
  fb.textContent = typ === 'gewusst' ? '✓' : '✗';
  fb.className = 'lern-feedback ' + (typ === 'gewusst' ? 'gewusst-ok' : 'nicht-ok');
}

// ============================================================
// PHOTO COMPRESSION
// ============================================================

function compressPhoto(file) {
  return new Promise(resolve => {
    const img = new Image();
    const tmp = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 900;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else       { w = Math.round(w * MAX / h); h = MAX; }
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(tmp);
      c.toBlob(blob => resolve(blob), 'image/jpeg', 0.85);
    };
    img.src = tmp;
  });
}

// ============================================================
// DATA HELPERS
// ============================================================

async function ladeAlles() {
  [gruppen, studenten] = await Promise.all([dbGetAll('gruppen'), dbGetAll('studenten')]);
}

function gruppeKartenAnzahl(gid) {
  return studenten.filter(s => s.gruppeId === gid).length;
}

function getGefilterteStudenten() {
  const suche = (document.getElementById('input-karten-suche')?.value || '').toLowerCase().trim();
  const sort  = document.getElementById('select-karten-sort')?.value || 'neu';
  let result = [...studenten];
  if (suche) result = result.filter(s => s.name.toLowerCase().includes(suche));
  switch (sort) {
    case 'az': result.sort((a, b) => a.name.localeCompare(b.name, 'de')); break;
    case 'za': result.sort((a, b) => b.name.localeCompare(a.name, 'de')); break;
    case 'gruppe': result.sort((a, b) => {
      const ga = gruppen.find(g => g.id === a.gruppeId)?.name || '';
      const gb = gruppen.find(g => g.id === b.gruppeId)?.name || '';
      return ga.localeCompare(gb, 'de') || a.name.localeCompare(b.name, 'de');
    }); break;
    default: result.sort((a, b) => Number(b.id) - Number(a.id)); break;
  }
  return result;
}

async function getSchwacheKarten() {
  const sitzungen = await dbGetAll('sitzungen');
  const nameStats = new Map();
  for (const sitz of sitzungen) {
    for (const detail of (sitz.details || [])) {
      if (!nameStats.has(detail.name)) nameStats.set(detail.name, { gewusst: 0, nachgeschaut: 0 });
      const stat = nameStats.get(detail.name);
      if (detail.status === 'gewusst') stat.gewusst++;
      else if (detail.status === 'nachgeschaut') stat.nachgeschaut++;
    }
  }
  const allNamen = [...nameStats.entries()]
    .filter(([, s]) => s.gewusst + s.nachgeschaut > 0)
    .map(([name, s]) => ({ name, fehlerRate: s.nachgeschaut / (s.gewusst + s.nachgeschaut) }))
    .sort((a, b) => b.fehlerRate - a.fehlerRate);
  if (!allNamen.length) return [];
  const anzahl = Math.max(5, Math.ceil(allNamen.length * 0.2));
  const schwacheNamen = new Set(allNamen.slice(0, anzahl).map(x => x.name));
  return studenten.filter(s => schwacheNamen.has(s.name));
}

// ============================================================
// RENDER – VERWALTUNG
// ============================================================

function karteItemHtml(s) {
  const isText = s.modus === 'text';
  const thumb = isText
    ? `<div class="karte-text-thumb">${esc((s.vorderseite || '').substring(0, 40))}${(s.vorderseite || '').length > 40 ? '…' : ''}</div>`
    : `<img src="${getFotoUrl(s)}" alt="${esc(s.name)}" loading="lazy">
       <div class="karte-foto-overlay">📷</div>
       <input type="file" accept="image/*" class="karte-foto-input" data-id="${s.id}">`;
  return `
    <div class="karte-item">
      <div class="karte-foto-wrapper">
        ${thumb}
      </div>
      <span class="karte-name">${esc(s.name)}${s.notiz ? ' <span style="opacity:.45;font-size:.7rem">📝</span>' : ''}</span>
      <button class="btn-karte-ren"  data-id="${s.id}" title="Bearbeiten">✏️</button>
      <button class="btn-karte-copy" data-id="${s.id}" title="Kopieren">📋</button>
      <button class="btn-karte-del"  data-id="${s.id}" title="Löschen">✕</button>
    </div>`;
}

function renderVerwaltung() {
  // Gruppen-Liste
  const gList = document.getElementById('gruppen-liste');
  const sortedG = getSortierteGruppen();
  gList.innerHTML = sortedG.length === 0
    ? '<p class="hinweis" style="padding:0.5rem 0">Noch keine Gruppen.</p>'
    : sortedG.map((g, i) => `
      <div class="gruppe-item">
        <span class="gruppe-dot"></span>
        <span class="gruppe-name">${esc(g.name)}</span>
        <span class="gruppe-count">${gruppeKartenAnzahl(g.id)} Karte(n)</span>
        <button class="btn-gruppe-move" data-id="${g.id}" data-dir="up" title="Nach oben"${i === 0 ? ' disabled' : ''}>▲</button>
        <button class="btn-gruppe-move" data-id="${g.id}" data-dir="down" title="Nach unten"${i === sortedG.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="btn-gruppe-ren" data-id="${g.id}" title="Umbenennen">✏️</button>
        <button class="btn-gruppe-del" data-id="${g.id}" title="Löschen">✕</button>
      </div>`).join('');

  // Gruppen-Select (letzte Gruppe merken)
  const sel     = document.getElementById('select-gruppe');
  const savedId = localStorage.getItem('lastGruppeId') || sel.value;
  sel.innerHTML = '<option value="">Gruppe wählen…</option>' +
    gruppen.map(g => `<option value="${g.id}"${g.id === savedId ? ' selected' : ''}>${esc(g.name)}</option>`).join('');

  // Karten-Anzeige
  const container = document.getElementById('karten-nach-gruppen');
  const hinweis   = document.getElementById('keine-karten-hinweis');
  document.getElementById('karten-gesamt').textContent = studenten.length;

  if (studenten.length === 0) {
    container.innerHTML = '';
    hinweis.classList.remove('hidden');
    return;
  }
  hinweis.classList.add('hidden');

  const gefiltert = getGefilterteStudenten();
  const suche     = (document.getElementById('input-karten-suche')?.value || '').trim();
  const sort      = document.getElementById('select-karten-sort')?.value || 'neu';
  const flach     = suche || sort === 'az' || sort === 'za';

  const toggleBtn = document.getElementById('btn-toggle-alle-gruppen');

  if (flach) {
    if (toggleBtn) toggleBtn.style.visibility = 'hidden';
    if (!gefiltert.length) {
      container.innerHTML = '<p class="hinweis" style="padding:0.5rem 0">Keine Karten gefunden.</p>';
    } else {
      container.innerHTML = gefiltert.map(s => karteItemHtml(s)).join('');
    }
    return;
  }

  if (toggleBtn) toggleBtn.style.visibility = 'visible';

  // Gruppiert mit aufklappbaren Sektionen
  const sortiertGruppen = sort === 'gruppe'
    ? [...gruppen].sort((a, b) => a.name.localeCompare(b.name, 'de'))
    : getSortierteGruppen();

  const byGruppe = new Map();
  sortiertGruppen.forEach(g => byGruppe.set(g.id, []));
  const ohneGruppe = [];
  gefiltert.forEach(s => {
    if (byGruppe.has(s.gruppeId)) byGruppe.get(s.gruppeId).push(s);
    else ohneGruppe.push(s);
  });

  function gruppeSection(gid, name, arr) {
    const isOpen = openGruppen.has(gid);
    return `<div class="gruppe-karten-section">
      <div class="gruppe-karten-header" data-gid="${gid}">
        <span class="gruppe-toggle-arrow">${isOpen ? '▼' : '▶'}</span>
        <span class="gruppe-karten-title-text">${esc(name)}</span>
        <span class="gruppe-karten-count">${arr.length} Karte${arr.length !== 1 ? 'n' : ''}</span>
      </div>
      <div id="gruppe-body-${gid}" class="gruppe-karten-body${isOpen ? '' : ' hidden'}">
        ${arr.map(s => karteItemHtml(s)).join('')}
      </div>
    </div>`;
  }

  let html = '';
  sortiertGruppen.forEach(g => {
    const arr = byGruppe.get(g.id);
    if (!arr.length) return;
    html += gruppeSection(g.id, g.name, arr);
  });
  if (ohneGruppe.length) {
    html += gruppeSection('ohne', 'Ohne Gruppe', ohneGruppe);
  }
  container.innerHTML = html || '<p class="hinweis" style="padding:0.5rem 0">Keine Karten gefunden.</p>';

  // Toggle-Button-Text aktualisieren
  if (toggleBtn) {
    const anyOpen = sortiertGruppen.some(g => byGruppe.get(g.id)?.length && openGruppen.has(g.id))
                 || (ohneGruppe.length && openGruppen.has('ohne'));
    toggleBtn.textContent = anyOpen ? 'Alle schließen' : 'Alle öffnen';
  }
}

// ============================================================
// RENDER – LERNEN (Gruppenauswahl)
// ============================================================

function renderLernAuswahl() {
  const container = document.getElementById('gruppen-checkboxen');
  if (!gruppen.length) {
    container.innerHTML = '<p class="hinweis">Bitte zuerst Gruppen und Karten anlegen.</p>';
    document.getElementById('btn-lernen-start').disabled = true;
    return;
  }
  container.innerHTML = getSortierteGruppen().map(g => {
    const n = gruppeKartenAnzahl(g.id);
    return `
      <div class="gruppe-check-item" data-gid="${g.id}">
        <div class="check-box">✓</div>
        <div class="check-label">
          <strong>${esc(g.name)}</strong>
          <span>${n} Karte${n !== 1 ? 'n' : ''}</span>
        </div>
      </div>`;
  }).join('');
  updateLernStartBtn();
}

function getSelectedGids() {
  return [...document.querySelectorAll('.gruppe-check-item.selected')].map(el => el.dataset.gid);
}

function updateLernStartBtn() {
  const total = getSelectedGids().reduce((s, gid) => s + gruppeKartenAnzahl(gid), 0);
  const btn = document.getElementById('btn-lernen-start');
  btn.disabled = total === 0;
  btn.textContent = total > 0 ? `Lernen starten (${total} Karte${total !== 1 ? 'n' : ''})` : 'Lernen starten';
}

// ============================================================
// RENDER – STATISTIK
// ============================================================

async function renderStatistik() {
  const sitzungen = await dbGetAll('sitzungen');
  sitzungen.sort((a, b) => new Date(b.datum) - new Date(a.datum));

  // Übersicht
  document.getElementById('stat-total-sitzungen').textContent = sitzungen.length;
  if (!sitzungen.length) {
    document.getElementById('stat-avg-score').textContent = '—';
    document.getElementById('stat-total-abgefragt').textContent = '0';
  } else {
    document.getElementById('stat-avg-score').textContent =
      Math.round(sitzungen.reduce((s, x) => s + x.score, 0) / sitzungen.length) + '%';
    document.getElementById('stat-total-abgefragt').textContent =
      sitzungen.reduce((s, x) => s + x.total, 0);
  }

  // Schwierigste Namen
  const nameStats = new Map();
  for (const sitz of sitzungen) {
    for (const detail of (sitz.details || [])) {
      if (!nameStats.has(detail.name)) nameStats.set(detail.name, { gewusst: 0, nachgeschaut: 0 });
      const stat = nameStats.get(detail.name);
      if (detail.status === 'gewusst') stat.gewusst++;
      else if (detail.status === 'nachgeschaut') stat.nachgeschaut++;
    }
  }

  const schwierigEl = document.getElementById('schwierigste-namen');
  const keineSchEl  = document.getElementById('keine-schwierig-hinweis');
  const schwaeBtn   = document.getElementById('btn-schwaeche-ueben');

  const nameArr = [...nameStats.entries()]
    .filter(([, s]) => s.nachgeschaut > 0)
    .map(([name, s]) => {
      const total = s.gewusst + s.nachgeschaut;
      return { name, rate: Math.round((s.nachgeschaut / total) * 100), total };
    })
    .sort((a, b) => b.rate - a.rate || b.total - a.total)
    .slice(0, 8);

  if (!nameArr.length) {
    schwierigEl.innerHTML = '';
    keineSchEl.classList.remove('hidden');
    schwaeBtn.classList.add('hidden');
  } else {
    keineSchEl.classList.add('hidden');
    schwierigEl.innerHTML = nameArr.map((item, i) => `
      <div class="schwierig-item">
        <span class="schwierig-rank">${i + 1}</span>
        <span class="schwierig-name">${esc(item.name)}</span>
        <span class="schwierig-rate">${item.rate}% ✗</span>
      </div>`).join('');

    const schwacheKarten = await getSchwacheKarten();
    if (schwacheKarten.length) {
      schwaeBtn.textContent = `⟳ Schwächste ${schwacheKarten.length} Karte${schwacheKarten.length !== 1 ? 'n' : ''} jetzt üben`;
      schwaeBtn.classList.remove('hidden');
      schwaeBtn.onclick = () => {
        showView('lernen');
        document.getElementById('lernen-auswahl').classList.add('hidden');
        starteSession(schwacheKarten);
        toast(`${schwacheKarten.length} schwächste Karte${schwacheKarten.length !== 1 ? 'n' : ''} ausgewählt`);
      };
    } else {
      schwaeBtn.classList.add('hidden');
    }
  }

  // Letzte Sitzungen
  const verlaufEl   = document.getElementById('sitzungen-verlauf');
  const keineVerlEl = document.getElementById('keine-verlauf-hinweis');
  if (!sitzungen.length) {
    verlaufEl.innerHTML = '';
    keineVerlEl.classList.remove('hidden');
  } else {
    keineVerlEl.classList.add('hidden');
    verlaufEl.innerHTML = sitzungen.slice(0, 10).map(sitz => {
      const d = new Date(sitz.datum);
      const datum   = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      const uhrzeit = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const cls = sitz.score >= 75 ? 'gut' : sitz.score >= 50 ? 'mitte' : 'schlecht';
      return `
        <div class="sitzung-item">
          <span class="sitzung-datum">${datum} ${uhrzeit}</span>
          <span class="sitzung-info">${sitz.total} Karte${sitz.total !== 1 ? 'n' : ''}</span>
          <span class="sitzung-score ${cls}">${sitz.score}%</span>
        </div>`;
    }).join('');
  }
}

// ============================================================
// STATISTICS – SESSION SAVING
// ============================================================

async function speichereSitzung() {
  if (!lernKarten.length) return;
  const details = lernKarten.map(s => ({
    name: s.name,
    status: gewusstIds.has(s.id) ? 'gewusst' : nichtGewusstIds.has(s.id) ? 'nachgeschaut' : 'übersprungen'
  }));
  const answeredCount = gewusst + nichtGewusst;
  const score = answeredCount > 0 ? Math.round((gewusst / answeredCount) * 100) : 0;
  await dbPut('sitzungen', {
    id: Date.now().toString(),
    datum: new Date().toISOString(),
    total: lernKarten.length,
    gewusst, nichtGewusst, score, details
  });
}

// ============================================================
// FLASHCARD LOGIC
// ============================================================

function zeigeKarte() {
  nameVisible = false;
  document.getElementById('lern-name-overlay').classList.add('hidden');
  document.getElementById('lern-feedback').className = 'lern-feedback hidden';
  document.getElementById('btn-aufdecken').style.visibility = '';

  const s           = lernKarten[lernIndex];
  const gruppe      = gruppen.find(g => g.id === s.gruppeId);
  const gName       = gruppe ? gruppe.name : '';
  const kartenModus = s.modus || 'foto';

  document.getElementById('lern-name-text').textContent         = s.name;
  document.getElementById('lern-gruppe-text').textContent       = gName;
  document.getElementById('lern-name-karte-gruppe').textContent = gName;
  document.getElementById('lern-position').textContent          = `${lernIndex + 1} / ${lernKarten.length}`;
  document.getElementById('btn-zurueck').classList.toggle('invisible', lernIndex === 0);
  document.getElementById('btn-weiter').classList.toggle('invisible', lernIndex === lernKarten.length - 1);

  // Alle Anzeigebereiche zurücksetzen
  document.getElementById('lernkarte-foto-wrapper').classList.add('hidden');
  document.getElementById('lernkarte-text-vorderseite').classList.add('hidden');
  document.getElementById('lern-name-karte').classList.add('hidden');

  const aufdeckBtn = document.getElementById('btn-aufdecken');
  aufdeckBtn.style.visibility = '';

  if (kartenModus === 'text') {
    document.getElementById('lern-vorderseite-text').textContent = s.vorderseite || '';
    document.getElementById('lernkarte-text-vorderseite').classList.remove('hidden');
    aufdeckBtn.textContent = 'Begriff zeigen';
  } else if (lernModus === 'name') {
    document.getElementById('lern-name-karte').classList.remove('hidden');
    document.getElementById('lern-name-karte-text').textContent = s.name;
    aufdeckBtn.textContent = 'Bild zeigen';
  } else {
    document.getElementById('lern-foto').src = getFotoUrl(s);
    document.getElementById('lernkarte-foto-wrapper').classList.remove('hidden');
    aufdeckBtn.textContent = 'Begriff zeigen';
  }
}

function zeigeName(wertung) {
  nameVisible = true;
  const s           = lernKarten[lernIndex];
  const kartenModus = s.modus || 'foto';
  if (!answeredIds.has(s.id)) {
    if (wertung === 'gewusst') { gewusst++; gewusstIds.add(s.id); }
    else                       { nichtGewusst++; nichtGewusstIds.add(s.id); }
    answeredIds.add(s.id);
  }
  if (kartenModus === 'text') {
    document.getElementById('lernkarte-text-vorderseite').classList.add('hidden');
    document.getElementById('lern-name-overlay').classList.remove('hidden');
  } else if (lernModus === 'name') {
    document.getElementById('lern-foto').src = getFotoUrl(s);
    document.getElementById('lernkarte-foto-wrapper').classList.remove('hidden');
    document.getElementById('lern-name-karte').classList.add('hidden');
  } else {
    document.getElementById('lern-name-overlay').classList.remove('hidden');
  }
  // Notiz anzeigen falls vorhanden
  const notizEl = document.getElementById('lern-notiz-text');
  if (s.notiz) {
    notizEl.textContent = s.notiz;
    notizEl.classList.remove('hidden');
  } else {
    notizEl.classList.add('hidden');
  }
  document.getElementById('btn-aufdecken').style.visibility = 'hidden';
  zeigeFeedback(wertung === 'gewusst' ? 'gewusst' : 'nicht');
}

function naechsteKarteOderEnde() {
  if (lernIndex < lernKarten.length - 1) { lernIndex++; zeigeKarte(); }
  else { zeigeEnde(); }
}

async function zeigeEnde() {
  await speichereSitzung();
  document.getElementById('lernen-flashcard').classList.add('hidden');
  document.getElementById('lernen-ende').classList.remove('hidden');
  const total = lernKarten.length;
  document.getElementById('stat-gewusst').textContent  = gewusst;
  document.getElementById('stat-nicht').textContent    = nichtGewusst;
  document.getElementById('ende-subtitle').textContent = `${total} Karte${total !== 1 ? 'n' : ''} abgefragt`;
}

function starteSession(karten) {
  lernKarten   = mischen([...karten]);
  lernIndex    = 0;
  gewusst      = 0;
  nichtGewusst = 0;
  answeredIds.clear();
  gewusstIds.clear();
  nichtGewusstIds.clear();
  document.getElementById('lernen-ende').classList.add('hidden');
  document.getElementById('lernen-flashcard').classList.remove('hidden');
  zeigeKarte();
}

// ============================================================
// KARTE EDIT MODAL
// ============================================================

function openKarteEditModal(studentId, mode) {
  editModalMode      = mode;
  editModalStudentId = studentId;
  const s = studenten.find(x => x.id === studentId);

  document.getElementById('karte-edit-titel').textContent = mode === 'copy' ? 'Karte kopieren' : 'Karte bearbeiten';
  document.getElementById('karte-edit-name').value  = s.name;
  document.getElementById('karte-edit-notiz').value = s.notiz || '';

  // Vorderseite nur für Text-Karten anzeigen
  const vGruppe = document.getElementById('karte-edit-vorderseite-gruppe');
  if (s.modus === 'text') {
    document.getElementById('karte-edit-vorderseite').value = s.vorderseite || '';
    vGruppe.classList.remove('hidden');
  } else {
    vGruppe.classList.add('hidden');
  }

  const sel = document.getElementById('karte-edit-gruppe');
  sel.innerHTML = gruppen.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  if (mode === 'copy') {
    const other = gruppen.find(g => g.id !== s.gruppeId);
    sel.value = other ? other.id : (gruppen[0]?.id || '');
  } else {
    sel.value = s.gruppeId;
  }

  document.getElementById('karte-edit-modal').classList.remove('hidden');
  setTimeout(() => {
    const inp = document.getElementById('karte-edit-name');
    inp.focus(); inp.select();
  }, 80);
}

// ============================================================
// VIEW NAVIGATION
// ============================================================

function showView(name) {
  ['verwaltung', 'lernen', 'statistik', 'sicherung'].forEach(v =>
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name));
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
  if (name === 'lernen') {
    document.getElementById('lernen-auswahl').classList.remove('hidden');
    document.getElementById('lernen-flashcard').classList.add('hidden');
    document.getElementById('lernen-ende').classList.add('hidden');
    renderLernAuswahl();
  }
  if (name === 'statistik') renderStatistik();
}

// ============================================================
// EXPORT / IMPORT
// ============================================================

function blobToDataUrl(blob) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime  = header.match(/:(.*?);/)[1];
  const bytes = atob(b64);
  const arr   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ============================================================
// UTILITY
// ============================================================

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

function mischen(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============================================================
// EVENTS – VERWALTUNG
// ============================================================

document.querySelectorAll('.nav-item').forEach(btn =>
  btn.addEventListener('click', () => showView(btn.dataset.view)));

// Info-Modal
document.getElementById('btn-info').addEventListener('click', () =>
  document.getElementById('info-modal').classList.remove('hidden'));
document.getElementById('btn-info-close').addEventListener('click', () =>
  document.getElementById('info-modal').classList.add('hidden'));
document.getElementById('info-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

// Karte-Edit-Modal
document.getElementById('btn-karte-edit-close').addEventListener('click', () =>
  document.getElementById('karte-edit-modal').classList.add('hidden'));
document.getElementById('karte-edit-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});
document.getElementById('karte-edit-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-karte-edit-save').click();
});
document.getElementById('btn-karte-edit-save').addEventListener('click', async () => {
  const name     = document.getElementById('karte-edit-name').value.trim();
  const gruppeId = document.getElementById('karte-edit-gruppe').value;
  const notiz    = document.getElementById('karte-edit-notiz').value.trim();
  if (!name || !gruppeId) return;

  if (editModalMode === 'copy') {
    const orig = studenten.find(x => x.id === editModalStudentId);
    let newS;
    if (orig.modus === 'text') {
      newS = { id: Date.now().toString(), name, gruppeId, modus: 'text',
               foto: null, vorderseite: orig.vorderseite || '', notiz,
               erstellt: new Date().toISOString() };
    } else {
      const fotoBuf = await orig.foto.arrayBuffer();
      newS = { id: Date.now().toString(), name, gruppeId, modus: 'foto',
               foto: new Blob([fotoBuf], { type: orig.foto.type }),
               vorderseite: '', notiz, erstellt: new Date().toISOString() };
    }
    await dbPut('studenten', newS);
    studenten.push(newS);
    toast(`Karte kopiert: „${name}"`);
  } else {
    const s    = studenten.find(x => x.id === editModalStudentId);
    const foto = s.foto;
    s.name     = name;
    s.gruppeId = gruppeId;
    s.notiz    = notiz;
    if (s.modus === 'text') {
      s.vorderseite = document.getElementById('karte-edit-vorderseite').value.trim();
    }
    await dbPut('studenten', s);
    s.foto = foto;
    toast(`Karte aktualisiert: „${name}"`);
  }
  document.getElementById('karte-edit-modal').classList.add('hidden');
  renderVerwaltung();
});

// Gruppe hinzufügen
document.getElementById('btn-gruppe-add').addEventListener('click', async () => {
  const input = document.getElementById('input-neue-gruppe');
  const name  = input.value.trim();
  if (!name) return;
  const g = { id: Date.now().toString(), name, erstellt: new Date().toISOString() };
  await dbPut('gruppen', g);
  gruppen.push(g);
  input.value = '';
  renderVerwaltung();
  toast(`Gruppe „${name}" erstellt`);
});
document.getElementById('input-neue-gruppe').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-gruppe-add').click();
});

// Gruppe verschieben / umbenennen / löschen
document.getElementById('gruppen-liste').addEventListener('click', async e => {
  const moveBtn = e.target.closest('.btn-gruppe-move');
  if (moveBtn && !moveBtn.disabled) {
    const id  = moveBtn.dataset.id;
    const dir = moveBtn.dataset.dir;
    const sorted = getSortierteGruppen();
    const idx = sorted.findIndex(x => x.id === id);
    if (dir === 'up' && idx > 0)
      [sorted[idx - 1], sorted[idx]] = [sorted[idx], sorted[idx - 1]];
    else if (dir === 'down' && idx < sorted.length - 1)
      [sorted[idx], sorted[idx + 1]] = [sorted[idx + 1], sorted[idx]];
    gruppenReihenfolge = sorted.map(x => x.id);
    saveGruppenReihenfolge();
    renderVerwaltung();
    return;
  }
  const renBtn = e.target.closest('.btn-gruppe-ren');
  if (renBtn) {
    const g = gruppen.find(x => x.id === renBtn.dataset.id);
    const newName = prompt('Neuer Gruppenname:', g.name);
    if (newName && newName.trim() && newName.trim() !== g.name) {
      g.name = newName.trim();
      await dbPut('gruppen', g);
      renderVerwaltung();
      toast(`Gruppe umbenannt in „${g.name}"`);
    }
    return;
  }
  const delBtn = e.target.closest('.btn-gruppe-del');
  if (!delBtn) return;
  const id = delBtn.dataset.id;
  const g  = gruppen.find(x => x.id === id);
  const n  = gruppeKartenAnzahl(id);
  if (!confirm(n > 0 ? `Gruppe „${g.name}" und ${n} Karte(n) löschen?` : `Gruppe „${g.name}" löschen?`)) return;
  const zuLoeschen = studenten.filter(s => s.gruppeId === id);
  for (const s of zuLoeschen) { await dbDelete('studenten', s.id); revokeUrl(s.id); }
  await dbDelete('gruppen', id);
  gruppen   = gruppen.filter(x => x.id !== id);
  studenten = studenten.filter(s => s.gruppeId !== id);
  gruppenReihenfolge = gruppenReihenfolge.filter(x => x !== id);
  saveGruppenReihenfolge();
  renderVerwaltung();
  toast('Gruppe gelöscht');
});

// Letzte Gruppe merken
document.getElementById('select-gruppe').addEventListener('change', e => {
  if (e.target.value) localStorage.setItem('lastGruppeId', e.target.value);
});

// Modus-Chips (Foto / Text)
document.getElementById('chip-foto').addEventListener('click', () => {
  document.getElementById('chip-foto').classList.add('active');
  document.getElementById('chip-text').classList.remove('active');
  document.getElementById('foto-bereich').classList.remove('hidden');
  document.getElementById('text-bereich').classList.add('hidden');
});
document.getElementById('chip-text').addEventListener('click', () => {
  document.getElementById('chip-text').classList.add('active');
  document.getElementById('chip-foto').classList.remove('active');
  document.getElementById('text-bereich').classList.remove('hidden');
  document.getElementById('foto-bereich').classList.add('hidden');
});

// Foto Vorschau (Karte hinzufügen)
document.getElementById('input-foto').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('foto-vorschau').src = ev.target.result;
    document.getElementById('foto-vorschau').classList.remove('hidden');
    document.getElementById('upload-placeholder').classList.add('hidden');
  };
  reader.readAsDataURL(file);
});

// Karte speichern
document.getElementById('form-karte').addEventListener('submit', async e => {
  e.preventDefault();
  const name     = document.getElementById('input-name').value.trim();
  const gruppeId = document.getElementById('select-gruppe').value;
  const modus    = document.getElementById('chip-foto').classList.contains('active') ? 'foto' : 'text';
  const notiz    = document.getElementById('input-notiz').value.trim();
  if (!name || !gruppeId) return;
  const btn = document.getElementById('btn-karte-speichern');
  btn.disabled = true; btn.textContent = 'Wird gespeichert…';
  try {
    let s;
    if (modus === 'foto') {
      const file = document.getElementById('input-foto').files[0];
      if (!file) { toast('Bitte ein Foto auswählen'); return; }
      const blob = await compressPhoto(file);
      s = { id: Date.now().toString(), name, gruppeId, modus: 'foto', foto: blob, vorderseite: '', notiz, erstellt: new Date().toISOString() };
    } else {
      const vorderseite = document.getElementById('input-vorderseite').value.trim();
      if (!vorderseite) { toast('Bitte einen Text eingeben'); return; }
      s = { id: Date.now().toString(), name, gruppeId, modus: 'text', foto: null, vorderseite, notiz, erstellt: new Date().toISOString() };
    }
    await dbPut('studenten', s);
    studenten.push(s);
    document.getElementById('input-name').value       = '';
    document.getElementById('input-notiz').value      = '';
    document.getElementById('input-foto').value       = '';
    document.getElementById('input-vorderseite').value = '';
    document.getElementById('foto-vorschau').classList.add('hidden');
    document.getElementById('upload-placeholder').classList.remove('hidden');
    renderVerwaltung();
    toast(`Karte „${name}" gespeichert`);
  } catch (err) {
    toast('Fehler: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Karte speichern';
  }
});

// Gruppe aufklappen / zuklappen
document.getElementById('karten-nach-gruppen').addEventListener('click', e => {
  const header = e.target.closest('.gruppe-karten-header');
  if (!header) return;
  // Wenn ein Button innerhalb des Headers geklickt wurde, ignorieren
  if (e.target.closest('button')) return;
  const gid  = header.dataset.gid;
  const body = document.getElementById(`gruppe-body-${gid}`);
  const arrow = header.querySelector('.gruppe-toggle-arrow');
  if (openGruppen.has(gid)) {
    openGruppen.delete(gid);
    body.classList.add('hidden');
    arrow.textContent = '▶';
  } else {
    openGruppen.add(gid);
    body.classList.remove('hidden');
    arrow.textContent = '▼';
  }
  saveOpenGruppen();
  // Toggle-Button-Text aktualisieren
  const anyOpen = [...openGruppen].some(id => document.getElementById(`gruppe-body-${id}`));
  const tb = document.getElementById('btn-toggle-alle-gruppen');
  if (tb) tb.textContent = anyOpen ? 'Alle schließen' : 'Alle öffnen';
});

// Alle öffnen / schließen
document.getElementById('btn-toggle-alle-gruppen').addEventListener('click', () => {
  const anyOpen = gruppen.some(g => openGruppen.has(g.id)) || openGruppen.has('ohne');
  if (anyOpen) {
    openGruppen.clear();
  } else {
    gruppen.forEach(g => openGruppen.add(g.id));
    openGruppen.add('ohne');
  }
  saveOpenGruppen();
  renderVerwaltung();
});

// Karte bearbeiten / kopieren / löschen
document.getElementById('karten-nach-gruppen').addEventListener('click', async e => {
  const renBtn  = e.target.closest('.btn-karte-ren');
  if (renBtn)  { openKarteEditModal(renBtn.dataset.id, 'edit'); return; }
  const copyBtn = e.target.closest('.btn-karte-copy');
  if (copyBtn) { openKarteEditModal(copyBtn.dataset.id, 'copy'); return; }
  const delBtn  = e.target.closest('.btn-karte-del');
  if (!delBtn) return;
  const id = delBtn.dataset.id;
  const s  = studenten.find(x => x.id === id);
  if (!confirm(`Karte „${s.name}" löschen?`)) return;
  await dbDelete('studenten', id);
  revokeUrl(id);
  studenten = studenten.filter(x => x.id !== id);
  renderVerwaltung();
  toast('Karte gelöscht');
});

// Foto tauschen (per Klick aufs Thumbnail)
document.getElementById('karten-nach-gruppen').addEventListener('change', async e => {
  const fotoInput = e.target.closest('.karte-foto-input');
  if (!fotoInput) return;
  const file = fotoInput.files[0];
  if (!file) return;
  const id = fotoInput.dataset.id;
  const s  = studenten.find(x => x.id === id);
  try {
    const blob = await compressPhoto(file);
    revokeUrl(id);
    s.foto = blob;
    await dbPut('studenten', s);
    renderVerwaltung();
    toast('Foto aktualisiert');
  } catch (err) {
    toast('Fehler: ' + err.message);
  }
});

// Suchen + Sortieren
document.getElementById('input-karten-suche').addEventListener('input', () => renderVerwaltung());
document.getElementById('select-karten-sort').addEventListener('change', () => renderVerwaltung());

// ============================================================
// EVENTS – LERNEN
// ============================================================

// Lernmodus-Toggle
document.querySelectorAll('.lernmodus-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    lernModus = btn.dataset.modus;
    document.querySelectorAll('.lernmodus-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('gruppen-checkboxen').addEventListener('click', e => {
  const item = e.target.closest('.gruppe-check-item');
  if (!item) return;
  item.classList.toggle('selected');
  updateLernStartBtn();
});

document.getElementById('btn-alle-waehlen').addEventListener('click', () => {
  document.querySelectorAll('.gruppe-check-item').forEach(el => el.classList.add('selected'));
  updateLernStartBtn();
});
document.getElementById('btn-keine-waehlen').addEventListener('click', () => {
  document.querySelectorAll('.gruppe-check-item').forEach(el => el.classList.remove('selected'));
  updateLernStartBtn();
});

// Schwächste starten
document.getElementById('btn-schwaeche-waehlen').addEventListener('click', async () => {
  const schwacheKarten = await getSchwacheKarten();
  if (!schwacheKarten.length) {
    toast('Noch keine Statistikdaten vorhanden');
    return;
  }
  document.getElementById('lernen-auswahl').classList.add('hidden');
  starteSession(schwacheKarten);
  toast(`${schwacheKarten.length} schwächste Karte${schwacheKarten.length !== 1 ? 'n' : ''} ausgewählt`);
});

document.getElementById('btn-lernen-start').addEventListener('click', () => {
  const karten = studenten.filter(s => getSelectedGids().includes(s.gruppeId));
  if (!karten.length) return;
  document.getElementById('lernen-auswahl').classList.add('hidden');
  starteSession(karten);
});

// Foto / Name-Karte klicken = Gewusst → weiter
// 1. Klick = Name + ✓ (gewusst), 2. Klick = weiter
document.getElementById('lernkarte').addEventListener('click', () => {
  if (!nameVisible) {
    zeigeName('gewusst');       // Name + grüner Haken sofort
  } else {
    naechsteKarteOderEnde();   // 2. Klick = direkt weiter
  }
});

// Button: Name zeigen = Nicht gewusst ✗ (rotes Kreuz)
document.getElementById('btn-aufdecken').addEventListener('click', e => {
  e.stopPropagation();
  if (!nameVisible) {
    zeigeName('nicht-gewusst'); // Name + rotes ✗, zählt als nicht gewusst
  }
});

// Pfeile
document.getElementById('btn-weiter').addEventListener('click', () => {
  if (lernIndex < lernKarten.length - 1) { lernIndex++; zeigeKarte(); }
});
document.getElementById('btn-zurueck').addEventListener('click', () => {
  if (lernIndex > 0) { lernIndex--; zeigeKarte(); }
});

document.getElementById('btn-mischen').addEventListener('click', () => {
  mischen(lernKarten); lernIndex = 0; zeigeKarte(); toast('Karten gemischt');
});
document.getElementById('btn-beenden').addEventListener('click', () => {
  document.getElementById('lernen-flashcard').classList.add('hidden');
  document.getElementById('lernen-auswahl').classList.remove('hidden');
  renderLernAuswahl();
});
document.getElementById('btn-neue-uebung').addEventListener('click', () => {
  document.getElementById('lernen-ende').classList.add('hidden');
  starteSession(lernKarten);
});
document.getElementById('btn-ende-auswahl').addEventListener('click', () => {
  document.getElementById('lernen-ende').classList.add('hidden');
  document.getElementById('lernen-auswahl').classList.remove('hidden');
  renderLernAuswahl();
});

// Tastatur (Desktop)
document.addEventListener('keydown', e => {
  if (!document.getElementById('lernen-flashcard').classList.contains('hidden')) {
    if (e.key === 'ArrowRight') document.getElementById('btn-weiter').click();
    if (e.key === 'ArrowLeft')  document.getElementById('btn-zurueck').click();
    if (e.key === ' ')          { e.preventDefault(); document.getElementById('btn-aufdecken').click(); }
  }
});

// ============================================================
// EVENTS – STATISTIK
// ============================================================

document.getElementById('btn-statistik-loeschen').addEventListener('click', async () => {
  if (!confirm('Alle Statistikdaten löschen? Die Karten bleiben erhalten.')) return;
  await dbClear('sitzungen');
  renderStatistik();
  toast('Statistik gelöscht');
});

// ============================================================
// EVENTS – SICHERUNG (Export- und Import-Modals)
// ============================================================

// Export Modal öffnen
document.getElementById('btn-export').addEventListener('click', () => {
  if (!gruppen.length) { toast('Keine Gruppen vorhanden'); return; }
  const container = document.getElementById('export-gruppen-liste');
  container.innerHTML = getSortierteGruppen().map(g => `
    <div class="gruppe-check-item selected" data-gid="${g.id}">
      <div class="check-box" style="background:var(--accent);border-color:var(--accent);color:#000">✓</div>
      <div class="check-label">
        <strong>${esc(g.name)}</strong>
        <span>${gruppeKartenAnzahl(g.id)} Karte${gruppeKartenAnzahl(g.id) !== 1 ? 'n' : ''}</span>
      </div>
    </div>`).join('');

  container.querySelectorAll('.gruppe-check-item').forEach(item => {
    item.addEventListener('click', () => {
      item.classList.toggle('selected');
      const cb = item.querySelector('.check-box');
      if (item.classList.contains('selected')) {
        Object.assign(cb.style, { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#000' });
      } else {
        Object.assign(cb.style, { background: '', borderColor: '', color: 'transparent' });
      }
    });
  });
  document.getElementById('export-modal').classList.remove('hidden');
});

document.getElementById('btn-export-modal-close').addEventListener('click', () =>
  document.getElementById('export-modal').classList.add('hidden'));
document.getElementById('export-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('btn-export-alle').addEventListener('click', () => {
  document.querySelectorAll('#export-gruppen-liste .gruppe-check-item').forEach(item => {
    item.classList.add('selected');
    const cb = item.querySelector('.check-box');
    Object.assign(cb.style, { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#000' });
  });
});
document.getElementById('btn-export-keine').addEventListener('click', () => {
  document.querySelectorAll('#export-gruppen-liste .gruppe-check-item').forEach(item => {
    item.classList.remove('selected');
    const cb = item.querySelector('.check-box');
    Object.assign(cb.style, { background: '', borderColor: '', color: 'transparent' });
  });
});

document.getElementById('btn-export-start').addEventListener('click', async () => {
  const selectedGids = [...document.querySelectorAll('#export-gruppen-liste .gruppe-check-item.selected')]
    .map(el => el.dataset.gid);
  if (!selectedGids.length) { toast('Keine Gruppe ausgewählt'); return; }

  const exportGruppen  = gruppen.filter(g => selectedGids.includes(g.id));
  const exportStudenten = studenten.filter(s => selectedGids.includes(s.gruppeId));
  const studExport = await Promise.all(exportStudenten.map(async s => ({
    ...s, foto: (s.modus === 'text' || !s.foto) ? null : await blobToDataUrl(s.foto)
  })));

  const payload = {
    version: 1, exportiert: new Date().toISOString(),
    gruppen: exportGruppen, studenten: studExport
  };
  // Dateiname: Gruppenname(n) einbauen
  function sanitize(str) {
    return str
      .replace(/[äÄ]/g,'ae').replace(/[öÖ]/g,'oe').replace(/[üÜ]/g,'ue').replace(/ß/g,'ss')
      .replace(/[^a-zA-Z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
  }
  const datum = new Date().toISOString().slice(0,10);
  let gruppenTeil;
  if (selectedGids.length === gruppen.length) {
    gruppenTeil = 'alle';
  } else if (selectedGids.length === 1) {
    gruppenTeil = sanitize(exportGruppen[0].name);
  } else {
    gruppenTeil = `${selectedGids.length}-Gruppen`;
  }

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), {
    href: url,
    download: `memopix-${gruppenTeil}-${datum}.json`
  }).click();
  URL.revokeObjectURL(url);
  document.getElementById('export-modal').classList.add('hidden');
  toast(`${exportGruppen.length} Gruppe${exportGruppen.length !== 1 ? 'n' : ''} exportiert`);
});

// Import Modal
document.getElementById('btn-import-trigger').addEventListener('click', () =>
  document.getElementById('input-import').click());

document.getElementById('input-import').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  try {
    const data = JSON.parse(await file.text());
    if (!data.gruppen || !data.studenten) throw new Error('Ungültiges Format');
    importDatenBuffer = data;

    document.getElementById('import-gruppen-info').innerHTML = data.gruppen.map(g => {
      const count    = data.studenten.filter(s => s.gruppeId === g.id).length;
      const existing = gruppen.find(x => x.name === g.name);
      return `<div class="import-gruppe-zeile">
        <span class="import-gruppe-name">${esc(g.name)}</span>
        <span class="import-gruppe-details">${count} Karte${count !== 1 ? 'n' : ''}${existing ? ' · <span class="import-gruppe-vorhanden">vorhanden</span>' : ' · neu'}</span>
      </div>`;
    }).join('');

    document.querySelectorAll('.import-modus-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.import-modus-btn[data-modus="hinzufuegen"]').classList.add('active');
    document.getElementById('import-modal').classList.remove('hidden');
  } catch (err) {
    toast('Fehler beim Lesen: ' + err.message);
  }
});

document.getElementById('btn-import-modal-close').addEventListener('click', () => {
  document.getElementById('import-modal').classList.add('hidden');
  importDatenBuffer = null;
});
document.getElementById('import-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.add('hidden');
    importDatenBuffer = null;
  }
});

document.querySelectorAll('.import-modus-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.import-modus-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('btn-import-start').addEventListener('click', async () => {
  if (!importDatenBuffer) return;
  const modus = document.querySelector('.import-modus-btn.active')?.dataset.modus || 'hinzufuegen';
  try {
    if (modus === 'ersetzen') {
      studenten.forEach(s => revokeUrl(s.id));
      await dbClear('gruppen');
      await dbClear('studenten');
      for (const g of importDatenBuffer.gruppen) await dbPut('gruppen', g);
      for (const s of importDatenBuffer.studenten)
        await dbPut('studenten', { ...s, foto: (s.modus === 'text' || !s.foto) ? null : dataUrlToBlob(s.foto) });
    } else {
      // Hinzufügen: merge, bestehende unberührt
      for (const importGruppe of importDatenBuffer.gruppen) {
        const existing = gruppen.find(g => g.name === importGruppe.name);
        const targetId = existing ? existing.id : importGruppe.id;
        if (!existing) await dbPut('gruppen', importGruppe);

        // Bestehende Karten dieser Gruppe ersetzen
        const toRemove = studenten.filter(s => s.gruppeId === targetId);
        for (const s of toRemove) { await dbDelete('studenten', s.id); revokeUrl(s.id); }

        // Importierte Karten einfügen
        const importStudents = importDatenBuffer.studenten.filter(s => s.gruppeId === importGruppe.id);
        for (const s of importStudents)
          await dbPut('studenten', { ...s, gruppeId: targetId, foto: (s.modus === 'text' || !s.foto) ? null : dataUrlToBlob(s.foto) });
      }
    }
    await ladeAlles();
    renderVerwaltung();
    document.getElementById('import-modal').classList.add('hidden');
    importDatenBuffer = null;
    toast(`Import erfolgreich – ${studenten.length} Karten geladen`);
  } catch (err) {
    toast('Fehler beim Import: ' + err.message);
  }
});

// ============================================================
// SERVICE WORKER
// ============================================================

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ============================================================
// TUTORIAL GRUPPE
// ============================================================

async function erstelleTutorialGruppeWennNeu() {
  if (localStorage.getItem('memopix-tutorial-created') || localStorage.getItem('snapmatch-tutorial-created')) return;

  const gruppeId = 'tutorial-' + Date.now();

  const svgKarten = [
    {
      id: 'tut-1', name: 'Willkommen!',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/><circle cx="130" cy="130" r="38" fill="#2a2a2a"/><path d="M72 230 Q72 185 130 185 Q188 185 188 230 L188 255 Q188 265 178 265 L82 265 Q72 265 72 255 Z" fill="#2a2a2a"/><circle cx="230" cy="120" r="32" fill="#383838"/><path d="M178 215 Q178 175 230 175 Q282 175 282 215 L282 240 Q282 248 274 248 L186 248 Q178 248 178 240 Z" fill="#383838"/><text x="180" y="310" text-anchor="middle" font-size="36" fill="#555">👋</text><line x1="30" y1="340" x2="330" y2="340" stroke="#222" stroke-width="1"/><text x="180" y="372" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="13" font-weight="700" fill="#f0f0f0">Willkommen!</text><text x="180" y="394" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Diese App hilft dir, Bilder</text><text x="180" y="412" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">und Begriffe zu lernen.</text><text x="180" y="438" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">Tippe auf das Bild → Begriff</text><text x="180" y="456" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">erscheint. Los geht's! →</text></svg>`
    },
    {
      id: 'tut-2', name: 'Tippen · Werten · Weiter',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/><g transform="translate(180,155)"><ellipse cx="0" cy="-60" rx="22" ry="28" fill="#333"/><rect x="-22" y="-35" width="44" height="55" rx="8" fill="#333"/><rect x="-40" y="8" width="80" height="14" rx="7" fill="#2a2a2a"/><circle cx="0" cy="-60" r="38" fill="none" stroke="#444" stroke-width="2" opacity="0.6"/><circle cx="0" cy="-60" r="52" fill="none" stroke="#333" stroke-width="1.5" opacity="0.4"/></g><text x="100" y="220" text-anchor="middle" font-size="28" fill="#4caf50">✓</text><text x="260" y="220" text-anchor="middle" font-size="28" fill="#cc4444">✗</text><line x1="30" y1="250" x2="330" y2="250" stroke="#222" stroke-width="1"/><text x="180" y="278" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="12" font-weight="700" fill="#f0f0f0">So lernst du:</text><text x="50" y="304" font-family="-apple-system,sans-serif" font-size="11" fill="#4caf50">①</text><text x="68" y="304" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Bild/Text tippen → Begriff + ✓</text><text x="50" y="326" font-family="-apple-system,sans-serif" font-size="11" fill="#cc4444">②</text><text x="68" y="326" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">„Begriff zeigen" → ✗ nachgeschaut</text><text x="50" y="348" font-family="-apple-system,sans-serif" font-size="11" fill="#888">③</text><text x="68" y="348" font-family="-apple-system,sans-serif" font-size="11" fill="#666">← → Pfeile = Blättern ohne Wertung</text><text x="180" y="386" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" fill="#555">Nochmal tippen = nächste Karte</text></svg>`
    },
    {
      id: 'tut-3', name: 'Gruppen & Karten',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/><rect x="80" y="90" width="200" height="140" rx="10" fill="#2a2a2a"/><rect x="80" y="75" width="90" height="25" rx="6" fill="#2a2a2a"/><rect x="100" y="110" width="75" height="95" rx="6" fill="#1a1a1a" stroke="#333" stroke-width="1"/><rect x="185" y="110" width="75" height="95" rx="6" fill="#1a1a1a" stroke="#333" stroke-width="1"/><circle cx="137" cy="138" r="14" fill="#333"/><rect x="117" y="155" width="40" height="30" rx="5" fill="#333"/><text x="222" y="148" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="9" fill="#666">Def.</text><rect x="202" y="155" width="40" height="20" rx="3" fill="#2a2a2a"/><rect x="202" y="178" width="40" height="8" rx="2" fill="#222"/><circle cx="260" cy="215" r="20" fill="#fff"/><text x="260" y="222" text-anchor="middle" font-size="24" fill="#000" font-weight="900">+</text><line x1="30" y1="255" x2="330" y2="255" stroke="#222" stroke-width="1"/><text x="180" y="283" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="12" font-weight="700" fill="#f0f0f0">Eigene Gruppen anlegen:</text><text x="180" y="308" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">VERWALTUNG → Gruppe anlegen</text><text x="180" y="328" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">→ 📷 Foto-Karte oder 📝 Text-Karte</text><text x="180" y="356" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">Notiz ergänzt den Begriff beim</text><text x="180" y="374" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">Aufdecken als Zusatzinfo.</text><text x="180" y="400" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#555">Gruppen per ▲▼ sortieren.</text></svg>`
    },
    {
      id: 'tut-4', name: 'App installieren & offline nutzen',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/><rect x="120" y="60" width="120" height="200" rx="16" fill="#1a1a1a" stroke="#333" stroke-width="2"/><rect x="130" y="75" width="100" height="155" rx="4" fill="#0a0a0a"/><circle cx="180" cy="248" r="8" fill="#2a2a2a"/><rect x="155" y="100" width="50" height="50" rx="10" fill="#222" stroke="#444" stroke-width="1"/><circle cx="170" cy="118" r="8" fill="#444"/><circle cx="190" cy="118" r="8" fill="#3a3a3a"/><g transform="translate(180,165)"><line x1="0" y1="10" x2="0" y2="-15" stroke="#fff" stroke-width="3" stroke-linecap="round"/><polyline points="-10,-5 0,-18 10,-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g><line x1="30" y1="280" x2="330" y2="280" stroke="#222" stroke-width="1"/><text x="180" y="308" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="12" font-weight="700" fill="#f0f0f0">App installieren:</text><text x="180" y="330" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">iPhone: Safari → □↑ → „Zum</text><text x="180" y="348" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Home-Bildschirm" hinzufügen</text><text x="180" y="370" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Android: Chrome → ⋮ →</text><text x="180" y="388" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">„App installieren"</text><text x="180" y="414" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" fill="#555">Tab offen lassen → offline nutzbar!</text></svg>`
    },
    {
      id: 'tut-5', name: 'Gruppen teilen',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/><rect x="40" y="80" width="90" height="140" rx="12" fill="#1a1a1a" stroke="#333" stroke-width="2"/><rect x="50" y="93" width="70" height="105" rx="4" fill="#0a0a0a"/><circle cx="85" cy="232" r="6" fill="#2a2a2a"/><rect x="56" y="99" width="28" height="36" rx="4" fill="#252525" stroke="#333" stroke-width="1"/><circle cx="70" cy="111" r="7" fill="#333"/><rect x="90" y="99" width="28" height="36" rx="4" fill="#252525" stroke="#333" stroke-width="1"/><circle cx="104" cy="111" r="7" fill="#2e2e2e"/><rect x="230" y="80" width="90" height="140" rx="12" fill="#1a1a1a" stroke="#333" stroke-width="2"/><rect x="240" y="93" width="70" height="105" rx="4" fill="#0a0a0a"/><circle cx="275" cy="232" r="6" fill="#2a2a2a"/><rect x="246" y="99" width="28" height="36" rx="4" fill="#252525" stroke="#333" stroke-width="1"/><circle cx="260" cy="111" r="7" fill="#333"/><rect x="280" y="99" width="28" height="36" rx="4" fill="#252525" stroke="#333" stroke-width="1"/><circle cx="294" cy="111" r="7" fill="#2e2e2e"/><line x1="148" y1="148" x2="198" y2="148" stroke="#4caf50" stroke-width="3" stroke-linecap="round"/><polyline points="188,138 200,148 188,158" fill="none" stroke="#4caf50" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><line x1="148" y1="172" x2="198" y2="172" stroke="#6a8fff" stroke-width="3" stroke-linecap="round"/><polyline points="158,162 146,172 158,182" fill="none" stroke="#6a8fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><line x1="30" y1="260" x2="330" y2="260" stroke="#222" stroke-width="1"/><text x="180" y="288" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="12" font-weight="700" fill="#f0f0f0">Gruppen teilen:</text><text x="180" y="312" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Unter SICHERUNG kannst du</text><text x="180" y="330" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Gruppen als Datei exportieren</text><text x="180" y="348" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">und an andere weitergeben.</text><text x="180" y="374" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">Empfänger importieren die Datei</text><text x="180" y="392" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">– fertig, keine Tipparbeit!</text><text x="180" y="420" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" fill="#444">Ideal zum Weitergeben von Sammlungen.</text></svg>`
    },
    {
      id: 'tut-6', name: 'Jetzt loslegen! 🎉',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/><circle cx="180" cy="160" r="80" fill="#1a1a1a" stroke="#2a2a2a" stroke-width="2"/><circle cx="180" cy="160" r="65" fill="#161616"/><polyline points="145,160 168,185 218,132" fill="none" stroke="#4caf50" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="90" cy="90" r="5" fill="#4caf50" opacity="0.5"/><circle cx="270" cy="80" r="4" fill="#cc4444" opacity="0.5"/><circle cx="60" cy="200" r="3" fill="#fff" opacity="0.3"/><circle cx="300" cy="210" r="5" fill="#4caf50" opacity="0.4"/><circle cx="110" cy="240" r="4" fill="#cc4444" opacity="0.3"/><line x1="30" y1="265" x2="330" y2="265" stroke="#222" stroke-width="1"/><text x="180" y="293" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="13" font-weight="700" fill="#f0f0f0">Bereit! 🎉</text><text x="180" y="318" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Tutorial-Gruppe löschen unter</text><text x="180" y="336" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">VERWALTUNG → eigene anlegen.</text><text x="180" y="362" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">Backups regelmäßig erstellen</text><text x="180" y="380" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">unter SICHERUNG!</text><text x="180" y="410" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" fill="#444">Daten bleiben lokal im Browser.</text></svg>`
    }
  ];

  await dbPut('gruppen', { id: gruppeId, name: '🎓 Tutorial' });

  const now = new Date().toISOString();
  for (let i = 0; i < svgKarten.length; i++) {
    const k = svgKarten[i];
    const blob = new Blob([k.svg], { type: 'image/svg+xml' });
    await dbPut('studenten', {
      id: k.id,
      name: k.name,
      gruppeId,
      foto: blob,
      erstellt: now
    });
  }

  localStorage.setItem('memopix-tutorial-created', '1');
}

// ============================================================
// INIT
// ============================================================

(async () => {
  await dbInit();
  await erstelleTutorialGruppeWennNeu();
  await ladeAlles();
  ladeOpenGruppen();
  ladeGruppenReihenfolge();
  renderVerwaltung();
})();

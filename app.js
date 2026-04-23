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

// import buffer
let importDatenBuffer = null;

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
  return `
    <div class="karte-item">
      <div class="karte-foto-wrapper">
        <img src="${getFotoUrl(s)}" alt="${esc(s.name)}" loading="lazy">
        <div class="karte-foto-overlay">📷</div>
        <input type="file" accept="image/*" class="karte-foto-input" data-id="${s.id}">
      </div>
      <span class="karte-name">${esc(s.name)}</span>
      <button class="btn-karte-ren"  data-id="${s.id}" title="Bearbeiten">✏️</button>
      <button class="btn-karte-copy" data-id="${s.id}" title="Kopieren">📋</button>
      <button class="btn-karte-del"  data-id="${s.id}" title="Löschen">✕</button>
    </div>`;
}

function renderVerwaltung() {
  // Gruppen-Liste
  const gList = document.getElementById('gruppen-liste');
  gList.innerHTML = gruppen.length === 0
    ? '<p class="hinweis" style="padding:0.5rem 0">Noch keine Gruppen.</p>'
    : gruppen.map(g => `
      <div class="gruppe-item">
        <span class="gruppe-dot"></span>
        <span class="gruppe-name">${esc(g.name)}</span>
        <span class="gruppe-count">${gruppeKartenAnzahl(g.id)} Karte(n)</span>
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
    : gruppen;

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
  container.innerHTML = gruppen.map(g => {
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

  const s      = lernKarten[lernIndex];
  const gruppe = gruppen.find(g => g.id === s.gruppeId);
  const gName  = gruppe ? gruppe.name : '';

  document.getElementById('lern-name-text').textContent        = s.name;
  document.getElementById('lern-gruppe-text').textContent      = gName;
  document.getElementById('lern-name-karte-gruppe').textContent = gName;
  document.getElementById('lern-position').textContent         = `${lernIndex + 1} / ${lernKarten.length}`;
  document.getElementById('btn-zurueck').classList.toggle('invisible', lernIndex === 0);
  document.getElementById('btn-weiter').classList.toggle('invisible', lernIndex === lernKarten.length - 1);

  if (lernModus === 'name') {
    document.getElementById('lernkarte-foto-wrapper').classList.add('hidden');
    document.getElementById('lern-name-karte').classList.remove('hidden');
    document.getElementById('lern-name-karte-text').textContent = s.name;
    document.getElementById('btn-aufdecken').textContent = 'Gesicht zeigen';
  } else {
    document.getElementById('lern-foto').src = getFotoUrl(s);
    document.getElementById('lernkarte-foto-wrapper').classList.remove('hidden');
    document.getElementById('lern-name-karte').classList.add('hidden');
    document.getElementById('btn-aufdecken').textContent = 'Name zeigen';
  }
}

function zeigeName() {
  const s = lernKarten[lernIndex];
  if (!answeredIds.has(s.id)) {
    nichtGewusst++;
    nichtGewusstIds.add(s.id);
    answeredIds.add(s.id);
  }
  nameVisible = true;
  const istLetzte = lernIndex === lernKarten.length - 1;
  if (lernModus === 'name') {
    document.getElementById('lern-foto').src = getFotoUrl(s);
    document.getElementById('lernkarte-foto-wrapper').classList.remove('hidden');
    document.getElementById('lern-name-karte').classList.add('hidden');
  } else {
    document.getElementById('lern-name-overlay').classList.remove('hidden');
  }
  document.getElementById('btn-aufdecken').textContent = istLetzte ? 'Fertig ✓' : 'Weiter →';
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
  document.getElementById('karte-edit-name').value = s.name;

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
  if (!name || !gruppeId) return;

  if (editModalMode === 'copy') {
    const orig    = studenten.find(x => x.id === editModalStudentId);
    const fotoBuf = await orig.foto.arrayBuffer();
    const newS    = {
      id: Date.now().toString(), name, gruppeId,
      foto: new Blob([fotoBuf], { type: orig.foto.type }),
      erstellt: new Date().toISOString()
    };
    await dbPut('studenten', newS);
    studenten.push(newS);
    toast(`Karte kopiert: „${name}"`);
  } else {
    const s    = studenten.find(x => x.id === editModalStudentId);
    const foto = s.foto;        // Blob-Referenz sichern (Safari-Bug: dbPut kann Blob invalidieren)
    s.name     = name;
    s.gruppeId = gruppeId;
    await dbPut('studenten', s);
    s.foto = foto;              // Referenz wiederherstellen
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

// Gruppe umbenennen / löschen
document.getElementById('gruppen-liste').addEventListener('click', async e => {
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
  renderVerwaltung();
  toast('Gruppe gelöscht');
});

// Letzte Gruppe merken
document.getElementById('select-gruppe').addEventListener('change', e => {
  if (e.target.value) localStorage.setItem('lastGruppeId', e.target.value);
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
  const file     = document.getElementById('input-foto').files[0];
  if (!name || !gruppeId || !file) return;
  const btn = document.getElementById('btn-karte-speichern');
  btn.disabled = true; btn.textContent = 'Wird gespeichert…';
  try {
    const blob = await compressPhoto(file);
    const s = { id: Date.now().toString(), name, gruppeId, foto: blob, erstellt: new Date().toISOString() };
    await dbPut('studenten', s);
    studenten.push(s);
    document.getElementById('input-name').value = '';
    document.getElementById('input-foto').value = '';
    document.getElementById('foto-vorschau').classList.add('hidden');
    document.getElementById('upload-placeholder').classList.remove('hidden');
    renderVerwaltung();
    toast(`Karte für „${name}" gespeichert`);
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
document.getElementById('lernkarte').addEventListener('click', () => {
  const s = lernKarten[lernIndex];
  if (!answeredIds.has(s.id)) {
    gewusst++;
    gewusstIds.add(s.id);
    answeredIds.add(s.id);
  }
  naechsteKarteOderEnde();
});

// Button: aufdecken ODER weiter
document.getElementById('btn-aufdecken').addEventListener('click', e => {
  e.stopPropagation();
  if (!nameVisible) zeigeName();
  else naechsteKarteOderEnde();
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
  container.innerHTML = gruppen.map(g => `
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
    ...s, foto: await blobToDataUrl(s.foto)
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
    download: `lernkarten-${gruppenTeil}-${datum}.json`
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
        await dbPut('studenten', { ...s, foto: dataUrlToBlob(s.foto) });
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
          await dbPut('studenten', { ...s, gruppeId: targetId, foto: dataUrlToBlob(s.foto) });
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
// INIT
// ============================================================

(async () => {
  await dbInit();
  await ladeAlles();
  ladeOpenGruppen();
  renderVerwaltung();
})();

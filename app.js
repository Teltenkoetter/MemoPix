// ============================================================
// DATABASE (IndexedDB)
// ============================================================

const DB_NAME = 'lernkarten';
const DB_VER  = 3;
let db;

function dbInit() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onerror = () => rej(req.error);
    req.onsuccess = () => { db = req.result; res(); };
    req.onupgradeneeded = e => {
      const d = e.target.result;
      const tx = e.target.transaction;
      if (!d.objectStoreNames.contains('gruppen'))
        d.createObjectStore('gruppen', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('studenten')) {
        const s = d.createObjectStore('studenten', { keyPath: 'id' });
        s.createIndex('gruppeId', 'gruppeId');
      }
      if (!d.objectStoreNames.contains('sitzungen'))
        d.createObjectStore('sitzungen', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('sammlungen')) {
        d.createObjectStore('sammlungen', { keyPath: 'id' });
        // Migration: bestehende Gruppen einer Standard-Sammlung zuweisen
        if (e.oldVersion >= 1) {
          const defaultId = 'sammlung-allgemein';
          tx.objectStore('sammlungen').put({
            id: defaultId, name: 'Allgemein', erstellt: new Date().toISOString()
          });
          tx.objectStore('gruppen').getAll().onsuccess = ev => {
            ev.target.result.forEach(g => {
              if (!g.sammlungId) {
                g.sammlungId = defaultId;
                tx.objectStore('gruppen').put(g);
              }
            });
          };
        }
      }
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

let gruppen    = [];
let studenten  = [];
let sammlungen = [];

const urlCache = new Map();
function getFotoUrl(s) {
  if (!urlCache.has(s.id)) urlCache.set(s.id, URL.createObjectURL(s.foto));
  return urlCache.get(s.id);
}
function revokeUrl(id) {
  if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
}

// learning
let lernKarten         = [];
let lernIndex          = 0;
let nameVisible        = false;
let gewusst            = 0;
let nichtGewusst       = 0;
let lernModus          = 'foto'; // 'foto' = Foto→Name, 'name' = Name→Foto
let aktuelleWertung    = null;   // 'gewusst' | 'nicht' – aktuell angezeigte Karte
let isAnimating        = false;  // verhindert Doppel-Klick während Flip/Fly-out
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

// sammlung ordering + open state (Verwaltung)
let sammlungenReihenfolge = [];
const openSammlungen = new Set();

// open state for sammlungen in Lernen-Auswahl
const openLernSammlungen = new Set();
function saveOpenLernSammlungen() {
  localStorage.setItem('openLernSammlungen', JSON.stringify([...openLernSammlungen]));
}
function ladeOpenLernSammlungen() {
  try {
    const s = localStorage.getItem('openLernSammlungen');
    if (s) JSON.parse(s).forEach(id => openLernSammlungen.add(id));
    else {
      // Default: alle offen
      sammlungen.forEach(s => openLernSammlungen.add(s.id));
      openLernSammlungen.add('__orphan__');
    }
  } catch(e) {}
}
function saveSammlungenReihenfolge() {
  localStorage.setItem('sammlungenReihenfolge', JSON.stringify(sammlungenReihenfolge));
}
function ladeSammlungenReihenfolge() {
  try { const s = localStorage.getItem('sammlungenReihenfolge'); if (s) sammlungenReihenfolge = JSON.parse(s); } catch(e) {}
}
function saveOpenSammlungen() {
  localStorage.setItem('openSammlungen', JSON.stringify([...openSammlungen]));
}
function ladeOpenSammlungen() {
  try { const s = localStorage.getItem('openSammlungen'); if (s) JSON.parse(s).forEach(id => openSammlungen.add(id)); } catch(e) {}
}
function getSortierteSammlungen() {
  if (!sammlungenReihenfolge.length) return [...sammlungen];
  const ordered = [];
  sammlungenReihenfolge.forEach(id => { const s = sammlungen.find(x => x.id === id); if (s) ordered.push(s); });
  sammlungen.forEach(s => { if (!sammlungenReihenfolge.includes(s.id)) ordered.push(s); });
  return ordered;
}
function sammlungKartenAnzahl(sid) {
  const gids = new Set(gruppen.filter(g => g.sammlungId === sid).map(g => g.id));
  return studenten.filter(s => gids.has(s.gruppeId)).length;
}
function getSortierteGruppenInSammlung(sid) {
  const inSam = gruppen.filter(g => g.sammlungId === sid);
  if (!gruppenReihenfolge.length) return inSam;
  const ordered = [];
  gruppenReihenfolge.forEach(id => { const g = inSam.find(x => x.id === id); if (g) ordered.push(g); });
  inSam.forEach(g => { if (!gruppenReihenfolge.includes(g.id)) ordered.push(g); });
  return ordered;
}
// Repariert Gruppen ohne gültige Sammlung (Migration-Fallback)
async function repairOrphanGruppen() {
  const orphans = gruppen.filter(g => !g.sammlungId || !sammlungen.find(s => s.id === g.sammlungId));
  if (!orphans.length) return;
  // Bestehende "Allgemein"-Sammlung suchen oder neu anlegen
  let allgemein = sammlungen.find(s => s.name === 'Allgemein');
  if (!allgemein) {
    allgemein = { id: 'sammlung-allgemein', name: 'Allgemein', erstellt: new Date().toISOString() };
    await dbPut('sammlungen', allgemein);
    sammlungen.push(allgemein);
  }
  for (const g of orphans) {
    g.sammlungId = allgemein.id;
    await dbPut('gruppen', g);
  }
}

async function addGruppeInSammlung(sid, inputEl) {
  const name = inputEl.value.trim();
  if (!name) return;
  const g = { id: Date.now().toString(), name, sammlungId: sid, erstellt: new Date().toISOString() };
  await dbPut('gruppen', g);
  gruppen.push(g);
  inputEl.value = '';
  renderVerwaltung();
  toast(`Gruppe „${name}" erstellt`);
}

// gruppe verschieben
let gruppeVerschiebenId = null;

// import buffer
let importDatenBuffer = null;

// feedback
function zeigeFeedback(typ) {
  const fb = document.getElementById('lern-feedback');
  fb.textContent = typ === 'gewusst' ? '✓' : '✗';
  fb.className = 'lern-feedback ' + (typ === 'gewusst' ? 'gewusst-ok' : 'nicht-ok');
}

// 3D-Flip: Karte faltet zur Kante (90°), Content-Tausch, zurück (0°)
function triggerFlip(wertung) {
  if (isAnimating || nameVisible) return;
  isAnimating = true;
  const card = document.getElementById('lernkarte');
  card.style.transition = 'transform 0.32s cubic-bezier(0.4, 0, 0.2, 1)';
  card.style.transform  = 'perspective(1600px) rotateY(90deg)';
  card.addEventListener('transitionend', function handler() {
    card.removeEventListener('transitionend', handler);
    zeigeName(wertung);                                   // Content-Tausch am unsichtbaren Punkt
    card.style.transform = 'perspective(1600px) rotateY(0deg)';
    setTimeout(() => { isAnimating = false; }, 320);      // Rückseite fertig eingedreht
  }, { once: true });
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
  [gruppen, studenten, sammlungen] = await Promise.all([
    dbGetAll('gruppen'), dbGetAll('studenten'), dbGetAll('sammlungen')
  ]);
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

async function getSchwacheKarten(gruppeIds = null) {
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
  const basis = gruppeIds ? studenten.filter(s => gruppeIds.includes(s.gruppeId)) : studenten;
  return basis.filter(s => schwacheNamen.has(s.name));
}

// ============================================================
// RENDER – VERWALTUNG
// ============================================================

// Mehrzeiligen Text als Bullet-Liste oder einfachen Absatz rendern
function renderVorderseiteHtml(text) {
  if (!text) return '';
  const zeilen = text.split('\n').map(z => z.trim()).filter(z => z.length > 0);
  if (zeilen.length <= 1) return `<p>${esc(text.trim())}</p>`;
  return `<ul class="lern-vorderseite-liste">${zeilen.map(z => `<li>${esc(z)}</li>`).join('')}</ul>`;
}

// ── Karte Detail Overlay ──────────────────────────────
let detailIds   = [];   // sichtbare Karten-IDs in aktueller Reihenfolge
let detailIndex = 0;    // aktuelle Position

function fillKarteDetail(s) {
  const isText = s.modus === 'text';
  const fotoWrap = document.getElementById('karte-detail-foto-wrap');
  const textWrap = document.getElementById('karte-detail-text-wrap');
  document.getElementById('karte-detail-foto').src = isText ? '' : getFotoUrl(s);
  document.getElementById('karte-detail-text').innerHTML = isText ? renderVorderseiteHtml(s.vorderseite || '') : '';
  fotoWrap.classList.toggle('hidden', isText);
  textWrap.classList.toggle('hidden', !isText);
  document.getElementById('karte-detail-name').textContent   = s.name;
  document.getElementById('karte-detail-gruppe').textContent = gruppen.find(g => g.id === s.gruppeId)?.name || '';
  const notizEl = document.getElementById('karte-detail-notiz');
  if (s.notiz) { notizEl.textContent = s.notiz; notizEl.classList.remove('hidden'); }
  else { notizEl.classList.add('hidden'); }
  const counterEl = document.getElementById('karte-detail-counter');
  if (counterEl) counterEl.textContent = detailIds.length > 1 ? `${detailIndex + 1} / ${detailIds.length}` : '';
}

function openKarteDetailOverlay(id) {
  detailIds = [...document.querySelectorAll('.karte-detail-trigger.karte-name')].map(el => el.dataset.id);
  if (!detailIds.length) detailIds = [id];
  detailIndex = detailIds.indexOf(id);
  if (detailIndex < 0) { detailIds = [id]; detailIndex = 0; }

  const s = studenten.find(x => x.id === detailIds[detailIndex]);
  if (!s) return;
  fillKarteDetail(s);

  const overlay = document.getElementById('karte-detail-overlay');
  overlay.classList.remove('hidden');

  const hint = document.getElementById('karte-detail-swipe-hint');
  if (hint) {
    if (detailIds.length > 1 && !localStorage.getItem('swipeHintSeen')) {
      hint.classList.remove('hidden');
      setTimeout(() => {
        hint.classList.add('fade-out');
        setTimeout(() => { hint.classList.add('hidden'); hint.classList.remove('fade-out'); }, 500);
      }, 2000);
      localStorage.setItem('swipeHintSeen', '1');
    } else {
      hint.classList.add('hidden');
    }
  }
}

function detailNavigate(dir) {
  if (!detailIds.length) return;
  const next = detailIndex + dir;
  if (next < 0 || next >= detailIds.length) return;
  detailIndex = next;
  const s = studenten.find(x => x.id === detailIds[detailIndex]);
  if (s) fillKarteDetail(s);
}


function karteItemHtml(s) {
  const isText = s.modus === 'text';
  const thumb = isText
    ? `<div class="karte-text-thumb karte-detail-trigger" data-id="${s.id}">${esc((s.vorderseite || '').substring(0, 40))}${(s.vorderseite || '').length > 40 ? '…' : ''}</div>`
    : `<img src="${getFotoUrl(s)}" alt="${esc(s.name)}" loading="lazy">
       <div class="karte-foto-overlay">📷</div>
       <input type="file" accept="image/*" class="karte-foto-input" data-id="${s.id}">`;
  return `
    <div class="karte-item">
      <div class="karte-foto-wrapper">
        ${thumb}
      </div>
      <span class="karte-name karte-detail-trigger" data-id="${s.id}">${esc(s.name)}${s.notiz ? ' <span style="opacity:.45;font-size:.7rem">📝</span>' : ''}</span>
      <button class="btn-karte-ren"  data-id="${s.id}" title="Bearbeiten">✏️</button>
      <button class="btn-karte-copy" data-id="${s.id}" title="Kopieren">📋</button>
      <button class="btn-karte-del"  data-id="${s.id}" title="Löschen">✕</button>
    </div>`;
}

function renderVerwaltung() {
  const sortierteSammlungen = getSortierteSammlungen();

  // ── Sammlungen + Gruppen ──────────────────────────────
  const sammlListEl  = document.getElementById('sammlungen-liste');
  const keinHinweis  = document.getElementById('keine-sammlungen-hinweis');
  document.getElementById('sammlungen-badge').textContent = sammlungen.length;

  if (!sortierteSammlungen.length) {
    sammlListEl.innerHTML = '';
    keinHinweis.classList.remove('hidden');
  } else {
    keinHinweis.classList.add('hidden');
    sammlListEl.innerHTML = sortierteSammlungen.map((sam, si) => {
      const gs    = getSortierteGruppenInSammlung(sam.id);
      const isOpen = openSammlungen.has(sam.id);
      const kCount = sammlungKartenAnzahl(sam.id);
      return `
        <div class="sammlung-section">
          <div class="sammlung-header" data-sid="${sam.id}">
            <span class="sammlung-toggle-icon">${isOpen ? '▼' : '▶'}</span>
            <span class="sammlung-name-text">${esc(sam.name)}</span>
            <span class="sammlung-count">${gs.length} Gr. · ${kCount} K.</span>
            <div class="sammlung-btns">
              <button class="btn-sammlung-move" data-id="${sam.id}" data-dir="up"${si === 0 ? ' disabled' : ''}>▲</button>
              <button class="btn-sammlung-move" data-id="${sam.id}" data-dir="down"${si === sortierteSammlungen.length - 1 ? ' disabled' : ''}>▼</button>
              <button class="btn-sammlung-ren" data-id="${sam.id}">✏️</button>
              <button class="btn-sammlung-del" data-id="${sam.id}">✕</button>
            </div>
          </div>
          <div class="sammlung-body${isOpen ? '' : ' hidden'}" id="sammlung-body-${sam.id}">
            ${gs.map((g, gi) => `
              <div class="gruppe-item">
                <span class="gruppe-dot"></span>
                <span class="gruppe-name">${esc(g.name)}</span>
                <span class="gruppe-count">${gruppeKartenAnzahl(g.id)} K.</span>
                <button class="btn-gruppe-move" data-id="${g.id}" data-dir="up" data-sid="${sam.id}"${gi === 0 ? ' disabled' : ''}>▲</button>
                <button class="btn-gruppe-move" data-id="${g.id}" data-dir="down" data-sid="${sam.id}"${gi === gs.length - 1 ? ' disabled' : ''}>▼</button>
                <button class="btn-gruppe-move-sammlung" data-id="${g.id}" title="Sammlung wechseln">📁</button>
                <button class="btn-gruppe-ren" data-id="${g.id}">✏️</button>
                <button class="btn-gruppe-del" data-id="${g.id}">✕</button>
              </div>`).join('')}
            <div class="neue-gruppe-row">
              <input type="text" class="input-neue-gruppe-sammlung" data-sid="${sam.id}" placeholder="Neue Gruppe…" maxlength="60">
              <button class="btn-gruppe-add-sammlung btn-icon" data-sid="${sam.id}">+</button>
            </div>
          </div>
        </div>`;
    }).join('');

    // ── Orphan-Gruppen: "Ohne Sammlung" Abschnitt ────────
    const orphanGs = gruppen.filter(g => !g.sammlungId || !sammlungen.find(s => s.id === g.sammlungId));
    if (orphanGs.length) {
      sammlListEl.innerHTML += `
        <div class="sammlung-section sammlung-section--orphan">
          <div class="sammlung-header" data-sid="__orphan__">
            <span class="sammlung-toggle-icon">${openSammlungen.has('__orphan__') ? '▼' : '▶'}</span>
            <span class="sammlung-name-text" style="opacity:.65">Ohne Sammlung</span>
            <span class="sammlung-count">${orphanGs.length} Gr.</span>
            <div class="sammlung-btns"></div>
          </div>
          <div class="sammlung-body${openSammlungen.has('__orphan__') ? '' : ' hidden'}" id="sammlung-body-__orphan__">
            ${orphanGs.map(g => `
              <div class="gruppe-item">
                <span class="gruppe-dot"></span>
                <span class="gruppe-name">${esc(g.name)}</span>
                <span class="gruppe-count">${gruppeKartenAnzahl(g.id)} K.</span>
                <button class="btn-gruppe-move-sammlung" data-id="${g.id}" title="Sammlung zuweisen">📁</button>
                <button class="btn-gruppe-ren" data-id="${g.id}">✏️</button>
                <button class="btn-gruppe-del" data-id="${g.id}">✕</button>
              </div>`).join('')}
          </div>
        </div>`;
    }
  }

  // ── Gruppe-Select mit Optgroups ───────────────────────
  const sel     = document.getElementById('select-gruppe');
  const savedId = localStorage.getItem('lastGruppeId') || sel.value;
  sel.innerHTML = '<option value="">Gruppe wählen…</option>' +
    sortierteSammlungen.map(sam => {
      const gs = getSortierteGruppenInSammlung(sam.id);
      if (!gs.length) return '';
      return `<optgroup label="${esc(sam.name)}">` +
        gs.map(g => `<option value="${g.id}"${g.id === savedId ? ' selected' : ''}>${esc(g.name)}</option>`).join('') +
        `</optgroup>`;
    }).join('');

  // ── Alle Karten ───────────────────────────────────────
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
    container.innerHTML = gefiltert.length
      ? gefiltert.map(s => karteItemHtml(s)).join('')
      : '<p class="hinweis" style="padding:0.5rem 0">Keine Karten gefunden.</p>';
    return;
  }

  if (toggleBtn) toggleBtn.style.visibility = 'visible';

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
  if (sort !== 'gruppe') {
    // Sammlung-Trennlinien einfügen
    sortierteSammlungen.forEach(sam => {
      const gs = getSortierteGruppenInSammlung(sam.id)
        .filter(g => (byGruppe.get(g.id) || []).length > 0);
      if (!gs.length) return;
      html += `<div class="karten-sammlung-header">${esc(sam.name)}</div>`;
      gs.forEach(g => html += gruppeSection(g.id, g.name, byGruppe.get(g.id)));
    });
    // Orphan-Gruppen
    const orphans = sortiertGruppen.filter(g =>
      !g.sammlungId || !sammlungen.find(s => s.id === g.sammlungId));
    orphans.forEach(g => {
      const arr = byGruppe.get(g.id);
      if (arr && arr.length) html += gruppeSection(g.id, g.name, arr);
    });
  } else {
    sortiertGruppen.forEach(g => {
      const arr = byGruppe.get(g.id);
      if (arr && arr.length) html += gruppeSection(g.id, g.name, arr);
    });
  }
  if (ohneGruppe.length) html += gruppeSection('ohne', 'Ohne Gruppe', ohneGruppe);

  container.innerHTML = html || '<p class="hinweis" style="padding:0.5rem 0">Keine Karten gefunden.</p>';

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
    container.innerHTML = '<p class="hinweis">Bitte zuerst Sammlungen, Gruppen und Karten anlegen.</p>';
    document.getElementById('btn-lernen-start').disabled = true;
    return;
  }
  const sortierteSammlungen = getSortierteSammlungen();
  let html = '';

  function lernGruppenHtml(gs, showIcon = true) {
    return gs.map(g => {
      const n     = gruppeKartenAnzahl(g.id);
      const fotoC = studenten.filter(s => s.gruppeId === g.id && s.modus !== 'text').length;
      const textC = studenten.filter(s => s.gruppeId === g.id && s.modus === 'text').length;
      const icon  = showIcon
        ? (fotoC > 0 && textC > 0 ? '📷 · 📖' : textC > 0 ? '📖' : '📷')
        : '';
      return `
        <div class="gruppe-check-item" data-gid="${g.id}">
          <div class="check-box">✓</div>
          <div class="check-label">
            <strong>${esc(g.name)}</strong>
            <span>${n} Karte${n !== 1 ? 'n' : ''}${icon ? ' · ' + icon : ''}</span>
          </div>
        </div>`;
    }).join('');
  }

  sortierteSammlungen.forEach(sam => {
    const gs = getSortierteGruppenInSammlung(sam.id);
    if (!gs.length) return;
    const isOpen = openLernSammlungen.has(sam.id);
    html += `<div class="lern-sammlung-header" data-lern-sid="${sam.id}">
      <span class="lern-sammlung-toggle">${isOpen ? '▼' : '▶'}</span>
      <span>${esc(sam.name)}</span>
    </div>
    <div class="lern-sammlung-body${isOpen ? '' : ' hidden'}" data-lern-sid="${sam.id}">
      ${lernGruppenHtml(gs)}
    </div>`;
  });
  // Orphan-Gruppen
  const orphans = gruppen.filter(g => !g.sammlungId || !sammlungen.find(s => s.id === g.sammlungId));
  if (orphans.length) {
    const isOpen = openLernSammlungen.has('__orphan__');
    html += `<div class="lern-sammlung-header" data-lern-sid="__orphan__">
      <span class="lern-sammlung-toggle">${isOpen ? '▼' : '▶'}</span>
      <span>Ohne Sammlung</span>
    </div>
    <div class="lern-sammlung-body${isOpen ? '' : ' hidden'}" data-lern-sid="__orphan__">
      ${lernGruppenHtml(orphans, false)}
    </div>`;
  }
  container.innerHTML = html;
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
        <div class="schwierig-name-wrap">
          <span class="schwierig-name">${esc(item.name)}</span>
          <div class="schwierig-bar-track">
            <div class="schwierig-bar-fill" style="width:${item.rate}%"></div>
          </div>
        </div>
        <span class="schwierig-rate">${item.rate}%</span>
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
      const gruppenText = sitz.gruppenNamen?.length
        ? sitz.gruppenNamen.join(', ')
        : null;
      return `
        <div class="sitzung-item">
          <span class="sitzung-datum">${datum} ${uhrzeit}</span>
          <div class="sitzung-info">
            <span>${sitz.total} Karte${sitz.total !== 1 ? 'n' : ''}</span>
            ${gruppenText ? `<span class="sitzung-gruppe">${esc(gruppenText)}</span>` : ''}
          </div>
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
  // Beteiligte Gruppen ermitteln
  const gidsInSession = [...new Set(lernKarten.map(s => s.gruppeId).filter(Boolean))];
  const gruppenNamen  = gidsInSession
    .map(gid => gruppen.find(g => g.id === gid)?.name)
    .filter(Boolean);
  await dbPut('sitzungen', {
    id: Date.now().toString(),
    datum: new Date().toISOString(),
    total: lernKarten.length,
    gewusst, nichtGewusst, score, details,
    gruppenNamen
  });
}

// ============================================================
// FLASHCARD LOGIC
// ============================================================

function zeigeKarte() {
  nameVisible     = false;
  aktuelleWertung = null;
  isAnimating     = false;

  // Karte zurücksetzen (Flip + Fly-out entfernen, ohne sichtbare Transition)
  const card = document.getElementById('lernkarte');
  card.style.transition = 'none';
  card.style.transform  = '';
  card.classList.remove('fly-out-up', 'fly-out-down');
  document.getElementById('stack-card-1').classList.remove('stack-advance-1');
  document.getElementById('stack-card-2').classList.remove('stack-advance-2');
  void card.offsetWidth; // force reflow
  card.style.transition = '';

  document.getElementById('lern-name-overlay').classList.add('hidden');
  document.getElementById('lern-feedback').className = 'lern-feedback hidden';
  document.getElementById('btn-aufdecken').style.visibility = '';
  document.getElementById('lern-hint-pill').classList.remove('hidden');

  const s           = lernKarten[lernIndex];
  const gruppe      = gruppen.find(g => g.id === s.gruppeId);
  const gName       = gruppe ? gruppe.name : '';
  const kartenModus = s.modus || 'foto';
  const total       = lernKarten.length;

  document.getElementById('lern-name-text').textContent         = s.name;
  document.getElementById('lern-gruppe-text').textContent       = gName;
  document.getElementById('lern-name-karte-gruppe').textContent = gName;

  // Fortschrittsbalken + Counter
  const answered = answeredIds.size;
  document.getElementById('lern-progress-fill').style.width = total > 0 ? (answered / total * 100) + '%' : '0%';
  document.getElementById('lern-position').innerHTML =
    `${lernIndex + 1}<span class="counter-total"> / ${total}</span>`;

  // Stapel: Ghost-Karten nur wenn Karten dahinter vorhanden
  document.getElementById('stack-card-1').style.display = lernIndex + 1 < total ? '' : 'none';
  document.getElementById('stack-card-2').style.display = lernIndex + 2 < total ? '' : 'none';

  document.getElementById('btn-zurueck').classList.toggle('invisible', lernIndex === 0);
  document.getElementById('btn-weiter').classList.toggle('invisible', lernIndex === total - 1);

  // Alle Anzeigebereiche zurücksetzen
  document.getElementById('lernkarte-foto-wrapper').classList.add('hidden');
  document.getElementById('lernkarte-text-vorderseite').classList.add('hidden');
  document.getElementById('lern-name-karte').classList.add('hidden');

  const aufdeckBtn = document.getElementById('btn-aufdecken');
  aufdeckBtn.style.visibility = '';

  if (kartenModus === 'text' && lernModus === 'name') {
    // Begriff-Karte UMGEKEHRT: Info/Definition vorne → Begriff aufdecken
    document.getElementById('lern-vorderseite-text').innerHTML = renderVorderseiteHtml(s.vorderseite || '');
    document.getElementById('lernkarte-text-vorderseite').classList.remove('hidden');
    aufdeckBtn.textContent = 'Begriff zeigen';
  } else if (kartenModus === 'text') {
    // Begriff-Karte NORMAL (Default): Begriff vorne → Info/Definition aufdecken
    document.getElementById('lern-name-karte').classList.remove('hidden');
    document.getElementById('lern-name-karte-text').textContent = s.name;
    aufdeckBtn.textContent = 'Info zeigen';
  } else if (lernModus === 'name') {
    // Foto-Karte umgekehrt: Begriff vorne → Bild hinten
    document.getElementById('lern-name-karte').classList.remove('hidden');
    document.getElementById('lern-name-karte-text').textContent = s.name;
    aufdeckBtn.textContent = 'Bild zeigen';
  } else {
    // Foto-Karte normal: Bild vorne → Begriff hinten
    document.getElementById('lern-foto').src = getFotoUrl(s);
    document.getElementById('lernkarte-foto-wrapper').classList.remove('hidden');
    aufdeckBtn.textContent = 'Begriff zeigen';
  }
}

function zeigeName(wertung) {
  nameVisible     = true;
  aktuelleWertung = wertung;
  const s           = lernKarten[lernIndex];
  const kartenModus = s.modus || 'foto';
  if (!answeredIds.has(s.id)) {
    if (wertung === 'gewusst') { gewusst++; gewusstIds.add(s.id); }
    else                       { nichtGewusst++; nichtGewusstIds.add(s.id); }
    answeredIds.add(s.id);
  }
  if (kartenModus === 'text' && lernModus === 'name') {
    // Begriff-Karte umgekehrt aufdecken: Begriff im Overlay zeigen (Info/Definition war vorne)
    document.getElementById('lernkarte-text-vorderseite').classList.add('hidden');
    document.getElementById('lern-name-overlay').classList.remove('hidden');
    const notizEl = document.getElementById('lern-notiz-text');
    if (s.notiz) { notizEl.textContent = s.notiz; notizEl.classList.remove('hidden'); }
    else { notizEl.classList.add('hidden'); }
  } else if (kartenModus === 'text') {
    // Begriff-Karte normal aufdecken: Info/Definition anzeigen (Begriff war vorne)
    document.getElementById('lern-name-karte').classList.add('hidden');
    document.getElementById('lern-vorderseite-text').innerHTML = renderVorderseiteHtml(s.vorderseite || '');
    document.getElementById('lernkarte-text-vorderseite').classList.remove('hidden');
    const notizRueck = document.getElementById('lern-notiz-text-rueck');
    if (s.notiz) { notizRueck.textContent = s.notiz; notizRueck.classList.remove('hidden'); }
    else { notizRueck.classList.add('hidden'); }
  } else if (lernModus === 'name') {
    // Foto-Karte umgekehrt aufdecken: Bild anzeigen
    document.getElementById('lern-foto').src = getFotoUrl(s);
    document.getElementById('lernkarte-foto-wrapper').classList.remove('hidden');
    document.getElementById('lern-name-karte').classList.add('hidden');
    const notizEl = document.getElementById('lern-notiz-text');
    if (s.notiz) { notizEl.textContent = s.notiz; notizEl.classList.remove('hidden'); }
    else { notizEl.classList.add('hidden'); }
  } else {
    // Foto-Karte normal aufdecken: Begriff im Overlay
    document.getElementById('lern-name-overlay').classList.remove('hidden');
    const notizEl = document.getElementById('lern-notiz-text');
    if (s.notiz) { notizEl.textContent = s.notiz; notizEl.classList.remove('hidden'); }
    else { notizEl.classList.add('hidden'); }
  }
  // Hint Pill verstecken, Fortschrittsbalken aktualisieren
  document.getElementById('lern-hint-pill').classList.add('hidden');
  const total = lernKarten.length;
  document.getElementById('lern-progress-fill').style.width =
    total > 0 ? (answeredIds.size / total * 100) + '%' : '0%';

  document.getElementById('btn-aufdecken').style.visibility = 'hidden';
  zeigeFeedback(wertung === 'gewusst' ? 'gewusst' : 'nicht');
}

function naechsteKarteOderEnde() {
  if (lernIndex < lernKarten.length - 1) {
    if (aktuelleWertung && !isAnimating) {
      isAnimating = true;
      const card = document.getElementById('lernkarte');
      const animClass = aktuelleWertung === 'gewusst' ? 'fly-out-up' : 'fly-out-down';
      card.classList.add(animClass);
      document.getElementById('stack-card-1').classList.add('stack-advance-1');
      document.getElementById('stack-card-2').classList.add('stack-advance-2');
      setTimeout(() => { lernIndex++; zeigeKarte(); }, 450);
    } else if (!isAnimating) {
      lernIndex++; zeigeKarte();
    }
  } else {
    zeigeEnde();
  }
}

async function zeigeEnde() {
  await speichereSitzung();
  document.getElementById('lernen-flashcard').classList.add('hidden');
  document.getElementById('lernen-ende').classList.remove('hidden');
  const total = lernKarten.length;
  document.getElementById('stat-gewusst').textContent  = gewusst;
  document.getElementById('stat-nicht').textContent    = nichtGewusst;
  document.getElementById('ende-subtitle').textContent = `${total} Karte${total !== 1 ? 'n' : ''} abgefragt`;
  // „Nachgeschaut üben" nur zeigen, wenn mind. 1 Karte nachgeschaut
  const nachBtn = document.getElementById('btn-nachgeschaut-ueben');
  if (nachBtn) nachBtn.classList.toggle('hidden', nichtGewusst === 0);
}

function starteSession(karten, shuffle = true) {
  lernKarten   = shuffle ? mischen([...karten]) : [...karten];
  document.getElementById('btn-mischen').style.visibility = shuffle ? '' : 'hidden';
  lernIndex    = 0;
  gewusst      = 0;
  nichtGewusst = 0;
  isAnimating  = false;
  answeredIds.clear();
  gewusstIds.clear();
  nichtGewusstIds.clear();
  document.getElementById('lern-progress-fill').style.width = '0%';
  document.getElementById('lernen-ende').classList.add('hidden');
  document.getElementById('lernen-flashcard').classList.remove('hidden');
  zeigeKarte();

  // Swipe-Hint einmalig anzeigen
  const hint = document.getElementById('lern-swipe-hint');
  if (!localStorage.getItem('swipeLearnHintSeen')) {
    hint.classList.remove('hidden');
    setTimeout(() => {
      hint.classList.add('fade-out');
      setTimeout(() => { hint.classList.add('hidden'); hint.classList.remove('fade-out'); }, 500);
    }, 2500);
    localStorage.setItem('swipeLearnHintSeen', '1');
  } else {
    hint.classList.add('hidden');
  }
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

  // Typ-Chips setzen
  const isFoto = s.modus !== 'text';
  document.getElementById('karte-edit-chip-foto').classList.toggle('active', isFoto);
  document.getElementById('karte-edit-chip-text').classList.toggle('active', !isFoto);
  document.getElementById('karte-edit-name-label').textContent = isFoto ? 'Name' : 'Begriff';

  // Felder ein-/ausblenden
  document.getElementById('karte-edit-foto-gruppe').classList.toggle('hidden', !isFoto);
  document.getElementById('karte-edit-vorderseite-gruppe').classList.toggle('hidden', isFoto);

  // Foto-Vorschau zurücksetzen
  document.getElementById('karte-edit-foto-input').value = '';
  const vorschau = document.getElementById('karte-edit-foto-vorschau');
  if (isFoto && s.foto) {
    vorschau.src = getFotoUrl(s);
    vorschau.classList.remove('hidden');
  } else {
    vorschau.src = '';
    vorschau.classList.add('hidden');
  }
  if (s.modus === 'text') {
    document.getElementById('karte-edit-vorderseite').value = s.vorderseite || '';
  }

  const sel = document.getElementById('karte-edit-gruppe');
  const sortierteSamml = getSortierteSammlungen();
  sel.innerHTML = sortierteSamml.map(sam => {
    const gs = getSortierteGruppenInSammlung(sam.id);
    if (!gs.length) return '';
    return `<optgroup label="${esc(sam.name)}">` +
      gs.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('') +
      `</optgroup>`;
  }).join('');
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

// Karte-Edit-Modal – Typ-Chips
function karteEditSetModus(isFoto) {
  document.getElementById('karte-edit-chip-foto').classList.toggle('active', isFoto);
  document.getElementById('karte-edit-chip-text').classList.toggle('active', !isFoto);
  document.getElementById('karte-edit-name-label').textContent = isFoto ? 'Name' : 'Begriff';
  document.getElementById('karte-edit-foto-gruppe').classList.toggle('hidden', !isFoto);
  document.getElementById('karte-edit-vorderseite-gruppe').classList.toggle('hidden', isFoto);
}
document.getElementById('karte-edit-chip-foto').addEventListener('click', () => karteEditSetModus(true));
document.getElementById('karte-edit-chip-text').addEventListener('click', () => karteEditSetModus(false));
document.getElementById('karte-edit-foto-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const v = document.getElementById('karte-edit-foto-vorschau');
    v.src = ev.target.result;
    v.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

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
    const s       = studenten.find(x => x.id === editModalStudentId);
    const newModus = document.getElementById('karte-edit-chip-foto').classList.contains('active') ? 'foto' : 'text';
    const fotoFile = document.getElementById('karte-edit-foto-input').files[0];

    // Moduswechsel text → foto: Foto erforderlich (oder noch kein Foto vorhanden)
    if (newModus === 'foto' && !fotoFile && !s.foto) {
      toast('Bitte ein Foto auswählen.'); return;
    }

    s.name     = name;
    s.gruppeId = gruppeId;
    s.notiz    = notiz;

    if (newModus === 'text') {
      s.modus       = 'text';
      s.vorderseite = document.getElementById('karte-edit-vorderseite').value.trim();
      s.foto        = null;
      if (urlCache.has(s.id)) { URL.revokeObjectURL(urlCache.get(s.id)); urlCache.delete(s.id); }
    } else {
      s.modus       = 'foto';
      s.vorderseite = '';
      if (fotoFile) {
        const blob = await new Promise(res => {
          const r = new FileReader();
          r.onload = ev => res(new Blob([ev.target.result], { type: fotoFile.type }));
          r.readAsArrayBuffer(fotoFile);
        });
        if (urlCache.has(s.id)) { URL.revokeObjectURL(urlCache.get(s.id)); urlCache.delete(s.id); }
        s.foto = blob;
      }
    }

    await dbPut('studenten', s);
    toast(`Karte aktualisiert: „${name}"`);
  }
  document.getElementById('karte-edit-modal').classList.add('hidden');
  renderVerwaltung();
});

// Sammlung hinzufügen
document.getElementById('btn-sammlung-add').addEventListener('click', async () => {
  const input = document.getElementById('input-neue-sammlung');
  const name  = input.value.trim();
  if (!name) return;
  const sam = { id: 'sammlung-' + Date.now(), name, erstellt: new Date().toISOString() };
  await dbPut('sammlungen', sam);
  sammlungen.push(sam);
  openSammlungen.add(sam.id);
  saveOpenSammlungen();
  input.value = '';
  renderVerwaltung();
  toast(`Sammlung „${name}" erstellt`);
});
document.getElementById('input-neue-sammlung').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-sammlung-add').click();
});

// Sammlungen-Liste: Delegation für alle Sammlung- und Gruppen-Aktionen
document.getElementById('sammlungen-liste').addEventListener('click', async e => {
  // Sammlung-Header aufklappen/zuklappen
  const sammlHeader = e.target.closest('.sammlung-header');
  if (sammlHeader && !e.target.closest('button')) {
    const sid = sammlHeader.dataset.sid;
    if (openSammlungen.has(sid)) openSammlungen.delete(sid); else openSammlungen.add(sid);
    saveOpenSammlungen();
    renderVerwaltung();
    return;
  }
  // Sammlung verschieben
  const sammlMoveBtn = e.target.closest('.btn-sammlung-move');
  if (sammlMoveBtn && !sammlMoveBtn.disabled) {
    const id = sammlMoveBtn.dataset.id, dir = sammlMoveBtn.dataset.dir;
    const sorted = getSortierteSammlungen();
    const idx = sorted.findIndex(x => x.id === id);
    if (dir === 'up'   && idx > 0)                [sorted[idx-1], sorted[idx]]   = [sorted[idx], sorted[idx-1]];
    if (dir === 'down' && idx < sorted.length - 1) [sorted[idx],   sorted[idx+1]] = [sorted[idx+1], sorted[idx]];
    sammlungenReihenfolge = sorted.map(x => x.id);
    saveSammlungenReihenfolge();
    renderVerwaltung();
    return;
  }
  // Sammlung umbenennen
  const sammlRenBtn = e.target.closest('.btn-sammlung-ren');
  if (sammlRenBtn) {
    const sam = sammlungen.find(x => x.id === sammlRenBtn.dataset.id);
    const newName = prompt('Neuer Sammlungsname:', sam.name);
    if (newName && newName.trim() && newName.trim() !== sam.name) {
      sam.name = newName.trim();
      await dbPut('sammlungen', sam);
      renderVerwaltung();
      toast(`Sammlung umbenannt in „${sam.name}"`);
    }
    return;
  }
  // Sammlung löschen
  const sammlDelBtn = e.target.closest('.btn-sammlung-del');
  if (sammlDelBtn) {
    const sid = sammlDelBtn.dataset.id;
    const sam = sammlungen.find(x => x.id === sid);
    const inSam = gruppen.filter(g => g.sammlungId === sid);
    if (inSam.length) { toast(`Erst alle ${inSam.length} Gruppe${inSam.length !== 1 ? 'n' : ''} löschen`); return; }
    if (!confirm(`Sammlung „${sam.name}" löschen?`)) return;
    await dbDelete('sammlungen', sid);
    sammlungen = sammlungen.filter(x => x.id !== sid);
    sammlungenReihenfolge = sammlungenReihenfolge.filter(x => x !== sid);
    saveSammlungenReihenfolge();
    renderVerwaltung();
    toast('Sammlung gelöscht');
    return;
  }
  // Gruppe hinzufügen (Button)
  const addGrpBtn = e.target.closest('.btn-gruppe-add-sammlung');
  if (addGrpBtn) {
    const inp = document.querySelector(`.input-neue-gruppe-sammlung[data-sid="${addGrpBtn.dataset.sid}"]`);
    if (inp) await addGruppeInSammlung(addGrpBtn.dataset.sid, inp);
    return;
  }
  // Gruppe in andere Sammlung verschieben (📁)
  const moveSammlBtn = e.target.closest('.btn-gruppe-move-sammlung');
  if (moveSammlBtn) {
    gruppeVerschiebenId = moveSammlBtn.dataset.id;
    const g = gruppen.find(x => x.id === gruppeVerschiebenId);
    document.getElementById('gruppe-verschieben-info').textContent = `„${esc(g.name)}" verschieben nach:`;
    const andere = getSortierteSammlungen().filter(s => s.id !== g.sammlungId);
    document.getElementById('sammlung-auswahl-liste').innerHTML = andere.length
      ? andere.map(s => `
          <div class="sammlung-ziel-item" data-sid="${s.id}">
            <span class="sammlung-ziel-name">${esc(s.name)}</span>
            <span class="sammlung-ziel-count">${sammlungKartenAnzahl(s.id)} K.</span>
          </div>`).join('')
      : '<p class="hinweis" style="padding:0.75rem 0">Keine anderen Sammlungen vorhanden.</p>';
    document.getElementById('gruppe-verschieben-modal').classList.remove('hidden');
    return;
  }

  // Gruppe verschieben (innerhalb Sammlung)
  const moveBtn = e.target.closest('.btn-gruppe-move');
  if (moveBtn && !moveBtn.disabled) {
    const id = moveBtn.dataset.id, dir = moveBtn.dataset.dir, sid = moveBtn.dataset.sid;
    const inSam = getSortierteGruppenInSammlung(sid);
    const idx   = inSam.findIndex(x => x.id === id);
    const all   = getSortierteGruppen();
    const swapAll = (a, b) => {
      const ai = all.findIndex(x => x.id === a), bi = all.findIndex(x => x.id === b);
      [all[ai], all[bi]] = [all[bi], all[ai]];
    };
    if (dir === 'up'   && idx > 0)              swapAll(inSam[idx-1].id, id);
    if (dir === 'down' && idx < inSam.length-1) swapAll(id, inSam[idx+1].id);
    gruppenReihenfolge = all.map(x => x.id);
    saveGruppenReihenfolge();
    renderVerwaltung();
    return;
  }
  // Gruppe umbenennen
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
  // Gruppe löschen
  const delBtn = e.target.closest('.btn-gruppe-del');
  if (!delBtn) return;
  const id = delBtn.dataset.id;
  const g  = gruppen.find(x => x.id === id);
  const n  = gruppeKartenAnzahl(id);
  if (!confirm(n > 0 ? `Gruppe „${g.name}" und ${n} Karte(n) löschen?` : `Gruppe „${g.name}" löschen?`)) return;
  for (const s of studenten.filter(x => x.gruppeId === id)) { await dbDelete('studenten', s.id); revokeUrl(s.id); }
  await dbDelete('gruppen', id);
  gruppen   = gruppen.filter(x => x.id !== id);
  studenten = studenten.filter(s => s.gruppeId !== id);
  gruppenReihenfolge = gruppenReihenfolge.filter(x => x !== id);
  saveGruppenReihenfolge();
  renderVerwaltung();
  toast('Gruppe gelöscht');
});

// Gruppe via Enter-Taste innerhalb Sammlung hinzufügen
document.getElementById('sammlungen-liste').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const inp = e.target.closest('.input-neue-gruppe-sammlung');
  if (inp) await addGruppeInSammlung(inp.dataset.sid, inp);
});

// Gruppe verschieben – Modal
document.getElementById('btn-gruppe-verschieben-close').addEventListener('click', () => {
  document.getElementById('gruppe-verschieben-modal').classList.add('hidden');
  gruppeVerschiebenId = null;
});
document.getElementById('gruppe-verschieben-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) { e.currentTarget.classList.add('hidden'); gruppeVerschiebenId = null; }
});
document.getElementById('sammlung-auswahl-liste').addEventListener('click', async e => {
  const item = e.target.closest('.sammlung-ziel-item');
  if (!item || !gruppeVerschiebenId) return;
  const sid = item.dataset.sid;
  const g   = gruppen.find(x => x.id === gruppeVerschiebenId);
  const sam = sammlungen.find(x => x.id === sid);
  g.sammlungId = sid;
  await dbPut('gruppen', g);
  document.getElementById('gruppe-verschieben-modal').classList.add('hidden');
  gruppeVerschiebenId = null;
  renderVerwaltung();
  toast(`„${g.name}" → ${sam.name}`);
});

// Letzte Gruppe merken
document.getElementById('select-gruppe').addEventListener('change', e => {
  if (e.target.value) localStorage.setItem('lastGruppeId', e.target.value);
});

// Modus-Chips (Foto / Begriff)
document.getElementById('chip-foto').addEventListener('click', () => {
  document.getElementById('chip-foto').classList.add('active');
  document.getElementById('chip-text').classList.remove('active');
  document.getElementById('foto-bereich').classList.remove('hidden');
  document.getElementById('text-bereich').classList.add('hidden');
  document.getElementById('label-input-name').textContent = 'Name';
});
document.getElementById('chip-text').addEventListener('click', () => {
  document.getElementById('chip-text').classList.add('active');
  document.getElementById('chip-foto').classList.remove('active');
  document.getElementById('text-bereich').classList.remove('hidden');
  document.getElementById('foto-bereich').classList.add('hidden');
  document.getElementById('label-input-name').textContent = 'Begriff';
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
// Karte Detail Overlay öffnen (Thumbnail oder Kartenname)
document.getElementById('karten-nach-gruppen').addEventListener('click', e => {
  const trigger = e.target.closest('.karte-detail-trigger');
  if (trigger && !e.target.closest('button')) {
    openKarteDetailOverlay(trigger.dataset.id);
    return;
  }
});

// Overlay: Swipe-Navigation + Tippen zum Schließen
(function() {
  const overlay = document.getElementById('karte-detail-overlay');
  let touchStartX = 0, touchStartY = 0, touchMoved = false;

  overlay.addEventListener('touchstart', e => {
    if (!e.touches.length) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchMoved  = false;
  }, { passive: true });

  overlay.addEventListener('touchmove', e => {
    if (!e.touches.length) return;
    if (Math.abs(e.touches[0].clientX - touchStartX) > 8) touchMoved = true;
  }, { passive: true });

  overlay.addEventListener('touchend', e => {
    if (!e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      detailNavigate(dx < 0 ? 1 : -1);
    } else if (!touchMoved) {
      overlay.classList.add('hidden');
    }
  }, { passive: true });

  overlay.addEventListener('click', () => {
    if (!('ontouchstart' in window)) overlay.classList.add('hidden');
  });
})();

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
  // Sammlung auf-/zuklappen
  const sammlHdr = e.target.closest('.lern-sammlung-header');
  if (sammlHdr) {
    const sid = sammlHdr.dataset.lernSid;
    if (openLernSammlungen.has(sid)) openLernSammlungen.delete(sid); else openLernSammlungen.add(sid);
    saveOpenLernSammlungen();
    const body = document.querySelector(`.lern-sammlung-body[data-lern-sid="${sid}"]`);
    const icon = sammlHdr.querySelector('.lern-sammlung-toggle');
    if (body) body.classList.toggle('hidden', !openLernSammlungen.has(sid));
    if (icon) icon.textContent = openLernSammlungen.has(sid) ? '▼' : '▶';
    return;
  }
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

// Schwächste starten – aus aktueller Gruppen-Auswahl (oder alle wenn nichts gewählt)
document.getElementById('btn-schwaeche-waehlen').addEventListener('click', async () => {
  const selectedGids  = getSelectedGids();
  const schwacheKarten = await getSchwacheKarten(selectedGids.length ? selectedGids : null);
  if (!schwacheKarten.length) {
    toast(selectedGids.length ? 'Noch keine Statistikdaten für diese Auswahl' : 'Noch keine Statistikdaten vorhanden');
    return;
  }
  document.getElementById('lernen-auswahl').classList.add('hidden');
  starteSession(schwacheKarten);
  const label = selectedGids.length ? 'aus Auswahl' : 'ausgewählt';
  toast(`${schwacheKarten.length} schwächste Karte${schwacheKarten.length !== 1 ? 'n' : ''} ${label}`);
});

document.getElementById('btn-lernen-start').addEventListener('click', () => {
  const selectedGids = getSelectedGids();
  const karten = studenten.filter(s => selectedGids.includes(s.gruppeId));
  if (!karten.length) return;
  // Tutorial-Gruppen immer in Reihenfolge (nicht mischen)
  const isTutorial = selectedGids.length === 1 &&
    gruppen.find(g => g.id === selectedGids[0])?.id.startsWith('tutorial-');
  document.getElementById('lernen-auswahl').classList.add('hidden');
  starteSession(karten, !isTutorial);
});

// Karte antippen: 1. Klick = 3D-Flip + ✓ (gewusst), 2. Klick = Fly-out + weiter
// Swipe-Navigation auf der Lernkarte (vor/zurück wie Pfeile)
(function() {
  const card = document.getElementById('lernkarte');
  let tx = 0, ty = 0, swiped = false;

  card.addEventListener('touchstart', e => {
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
    swiped = false;
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    if (swiped || isAnimating) return;
    const dx = e.touches[0].clientX - tx;
    const dy = e.touches[0].clientY - ty;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      card.style.transition = 'none';
      card.style.transform  = `translateX(${dx * 0.3}px) rotate(${dx * 0.02}deg)`;
    }
  }, { passive: true });

  card.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    const dy = e.changedTouches[0].clientY - ty;
    card.style.transition = '';
    card.style.transform  = '';
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && !isAnimating) {
      swiped = true;
      if (dx < 0 && lernIndex < lernKarten.length - 1) { lernIndex++; zeigeKarte(); }
      else if (dx > 0 && lernIndex > 0)                { lernIndex--; zeigeKarte(); }
    }
  }, { passive: true });
})();

document.getElementById('lernkarte').addEventListener('click', e => {
  if (!nameVisible) {
    triggerFlip('gewusst');
  } else if (!isAnimating) {
    naechsteKarteOderEnde();
  }
});

// Button „Begriff zeigen" = Flip + ✗ (nicht gewusst)
document.getElementById('btn-aufdecken').addEventListener('click', e => {
  e.stopPropagation();
  if (!nameVisible) {
    triggerFlip('nicht-gewusst');
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

// Toggle ✓ ↔ ✗ wenn auf Feedback-Symbol geklickt wird
document.getElementById('lern-feedback').addEventListener('click', e => {
  e.stopPropagation();
  if (!nameVisible || !aktuelleWertung) return;
  const s = lernKarten[lernIndex];
  if (aktuelleWertung === 'gewusst') {
    gewusst--;          gewusstIds.delete(s.id);
    nichtGewusst++;     nichtGewusstIds.add(s.id);
    aktuelleWertung = 'nicht';
    zeigeFeedback('nicht');
  } else {
    nichtGewusst--;     nichtGewusstIds.delete(s.id);
    gewusst++;          gewusstIds.add(s.id);
    aktuelleWertung = 'gewusst';
    zeigeFeedback('gewusst');
  }
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
document.getElementById('btn-nachgeschaut-ueben').addEventListener('click', () => {
  const nachKarten = lernKarten.filter(s => nichtGewusstIds.has(s.id));
  if (!nachKarten.length) return;
  document.getElementById('lernen-ende').classList.add('hidden');
  starteSession(nachKarten);
  toast(`${nachKarten.length} nachgeschaute Karte${nachKarten.length !== 1 ? 'n' : ''} nochmal`);
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

  function gruppeItemHtml(g) {
    const n = gruppeKartenAnzahl(g.id);
    return `<div class="gruppe-check-item selected" data-gid="${g.id}">
      <div class="check-box" style="background:var(--accent);border-color:var(--accent);color:#000">✓</div>
      <div class="check-label">
        <strong>${esc(g.name)}</strong>
        <span>${n} Karte${n !== 1 ? 'n' : ''}</span>
      </div>
    </div>`;
  }

  // Nach Sammlungen gegliedert
  let html = '';
  getSortierteSammlungen().forEach(sam => {
    const gs = getSortierteGruppenInSammlung(sam.id);
    if (!gs.length) return;
    html += `<div class="export-sammlung-header">${esc(sam.name)}</div>`;
    html += gs.map(gruppeItemHtml).join('');
  });
  // Orphan-Gruppen
  const orphans = gruppen.filter(g => !g.sammlungId || !sammlungen.find(s => s.id === g.sammlungId));
  if (orphans.length) {
    html += `<div class="export-sammlung-header" style="opacity:.55">Ohne Sammlung</div>`;
    html += orphans.map(gruppeItemHtml).join('');
  }
  container.innerHTML = html;

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
  document.getElementById('export-ios-hinweis').classList.toggle('hidden', !!window.showSaveFilePicker);
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

  const exportSammlIds = new Set(exportGruppen.map(g => g.sammlungId).filter(Boolean));
  const exportSammlungen = sammlungen.filter(s => exportSammlIds.has(s.id));
  const payload = {
    version: 2, exportiert: new Date().toISOString(),
    sammlungen: exportSammlungen, gruppen: exportGruppen, studenten: studExport
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

  const filename = `memofix-${gruppenTeil}-${datum}.json`;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'MemoFix Backup', accept: { 'application/json': ['.json'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      if (err.name === 'AbortError') return; // Nutzer hat abgebrochen
      // Fallback bei unerwartetem Fehler
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: filename }).click();
      URL.revokeObjectURL(url);
    }
  } else {
    // Fallback: Standard-Download (Safari, iOS, Firefox)
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
  }

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
      await dbClear('sammlungen');
      for (const sam of (importDatenBuffer.sammlungen || [])) await dbPut('sammlungen', sam);
      for (const g of importDatenBuffer.gruppen) await dbPut('gruppen', g);
      for (const s of importDatenBuffer.studenten)
        await dbPut('studenten', { ...s, foto: (s.modus === 'text' || !s.foto) ? null : dataUrlToBlob(s.foto) });
    } else {
      // Hinzufügen: merge, bestehende unberührt
      for (const sam of (importDatenBuffer.sammlungen || [])) {
        if (!sammlungen.find(x => x.id === sam.id)) await dbPut('sammlungen', sam);
      }
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
  if (localStorage.getItem('memofix-tutorial-created') || localStorage.getItem('memopix-tutorial-created') || localStorage.getItem('snapmatch-tutorial-created')) return;

  const gruppeId     = 'tutorial-' + Date.now();
  const tutSammlungId = 'sammlung-tutorial-' + Date.now();
  await dbPut('sammlungen', { id: tutSammlungId, name: '🎓 Tutorial', erstellt: new Date().toISOString() });

  const svgKarten = [
    {
      id: 'tut-1', name: 'Willkommen!',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/><circle cx="130" cy="130" r="38" fill="#2a2a2a"/><path d="M72 230 Q72 185 130 185 Q188 185 188 230 L188 255 Q188 265 178 265 L82 265 Q72 265 72 255 Z" fill="#2a2a2a"/><circle cx="230" cy="120" r="32" fill="#383838"/><path d="M178 215 Q178 175 230 175 Q282 175 282 215 L282 240 Q282 248 274 248 L186 248 Q178 248 178 240 Z" fill="#383838"/><text x="180" y="310" text-anchor="middle" font-size="36" fill="#555">👋</text><line x1="30" y1="340" x2="330" y2="340" stroke="#222" stroke-width="1"/><text x="180" y="372" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="13" font-weight="700" fill="#f0f0f0">Willkommen!</text><text x="180" y="394" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Diese App hilft dir, Bilder</text><text x="180" y="412" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">und Begriffe zu lernen.</text><text x="180" y="438" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">Tippe auf das Bild → Begriff</text><text x="180" y="456" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">erscheint. Los geht's! →</text></svg>`
    },
    {
      id: 'tut-2', name: 'Tippen · Werten · Wischen',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/>
        <rect x="100" y="55" width="160" height="110" rx="14" fill="#1a1a1a" stroke="#2a2a2a" stroke-width="1.5"/>
        <rect x="115" y="67" width="60" height="86" rx="6" fill="#252525"/>
        <circle cx="145" cy="93" r="14" fill="#333"/>
        <rect x="186" y="67" width="60" height="86" rx="6" fill="#333"/>
        <text x="216" y="103" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="9" fill="#888">Begriff</text>
        <line x1="192" y1="112" x2="240" y2="112" stroke="#444" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="192" y1="123" x2="230" y2="123" stroke="#333" stroke-width="1" stroke-linecap="round"/>
        <path d="M180 110 Q180 100 172 97" fill="none" stroke="#4a4a4a" stroke-width="2" stroke-linecap="round"/>
        <text x="180" y="188" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" fill="#555">↻ dreht sich um</text>
        <line x1="30" y1="204" x2="330" y2="204" stroke="#1e1e1e" stroke-width="1"/>
        <text x="180" y="228" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="12" font-weight="700" fill="#f0f0f0">So lernst du:</text>
        <text x="50" y="252" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">①</text>
        <text x="68" y="252" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Karte antippen → dreht sich um → ✓</text>
        <text x="50" y="274" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">②</text>
        <text x="68" y="274" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">„Begriff zeigen" → Flip → ✗ nachgeschaut</text>
        <text x="50" y="296" font-family="-apple-system,sans-serif" font-size="11" fill="#666">③</text>
        <text x="68" y="296" font-family="-apple-system,sans-serif" font-size="11" fill="#666">✓ oder ✗ antippen → Wertung korrigieren</text>
        <text x="50" y="318" font-family="-apple-system,sans-serif" font-size="11" fill="#666">④</text>
        <text x="68" y="318" font-family="-apple-system,sans-serif" font-size="11" fill="#666">← → Pfeile oder Wischen = vor/zurück</text>
        <text x="50" y="340" font-family="-apple-system,sans-serif" font-size="11" fill="#555">⑤</text>
        <text x="68" y="340" font-family="-apple-system,sans-serif" font-size="11" fill="#555">↺ Nachgeschaut üben nach der Runde</text>
        <text x="180" y="372" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" fill="#444">Nochmal tippen = nächste Karte</text>
      </svg>`
    },
    {
      id: 'tut-3', name: 'Sammlungen · Gruppen · Karten',
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/>
        <!-- Ebene 1: Sammlung -->
        <rect x="40" y="55" width="280" height="32" rx="8" fill="#1e1e28" stroke="#333" stroke-width="1"/>
        <text x="58" y="76" font-family="-apple-system,sans-serif" font-size="11" fill="#888">📂 Hochschule</text>
        <!-- Ebene 2: Gruppen -->
        <rect x="60" y="102" width="120" height="28" rx="6" fill="#252530" stroke="#333" stroke-width="1"/>
        <text x="74" y="120" font-family="-apple-system,sans-serif" font-size="10" fill="#999">Biologie Kap. 3</text>
        <rect x="195" y="102" width="105" height="28" rx="6" fill="#252530" stroke="#333" stroke-width="1"/>
        <text x="209" y="120" font-family="-apple-system,sans-serif" font-size="10" fill="#999">Anatomie</text>
        <!-- Verbindungslinien -->
        <line x1="180" y1="87" x2="120" y2="102" stroke="#333" stroke-width="1"/>
        <line x1="180" y1="87" x2="247" y2="102" stroke="#333" stroke-width="1"/>
        <!-- Ebene 3: Karten -->
        <rect x="60" y="146" width="52" height="66" rx="6" fill="#1a1a1a" stroke="#2a2a2a" stroke-width="1"/>
        <circle cx="86" cy="166" r="12" fill="#333"/>
        <rect x="68" y="182" width="36" height="22" rx="3" fill="#2a2a2a"/>
        <rect x="122" y="146" width="52" height="66" rx="6" fill="#1a1a1a" stroke="#2a2a2a" stroke-width="1"/>
        <circle cx="148" cy="166" r="12" fill="#333"/>
        <rect x="130" y="182" width="36" height="22" rx="3" fill="#2a2a2a"/>
        <!-- Pfeil 📁 -->
        <text x="245" y="175" font-family="-apple-system,sans-serif" font-size="22" fill="#555">📁</text>
        <text x="242" y="198" font-family="-apple-system,sans-serif" font-size="9" fill="#444">verschieben</text>
        <line x1="30" y1="232" x2="330" y2="232" stroke="#222" stroke-width="1"/>
        <text x="180" y="258" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="12" font-weight="700" fill="#f0f0f0">3 Ebenen:</text>
        <text x="180" y="280" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Sammlung → Gruppe → Karte</text>
        <text x="180" y="306" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">VERWALTUNG → Sammlung anlegen</text>
        <text x="180" y="324" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">→ Gruppe → 📷 Foto oder 📖 Text</text>
        <text x="180" y="352" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">📁 verschiebt eine Gruppe in</text>
        <text x="180" y="370" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">eine andere Sammlung.</text>
        <text x="180" y="396" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#555">Im Lernen: Sammlungen auf-/</text>
        <text x="180" y="414" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#555">zuklappen per Antippen.</text>
      </svg>`
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
      svg: `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="#111"/><circle cx="180" cy="150" r="80" fill="#1a1a1a" stroke="#2a2a2a" stroke-width="2"/><circle cx="180" cy="150" r="65" fill="#161616"/><polyline points="145,150 168,175 218,122" fill="none" stroke="#4caf50" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="90" cy="80" r="5" fill="#4caf50" opacity="0.5"/><circle cx="270" cy="70" r="4" fill="#cc4444" opacity="0.5"/><circle cx="60" cy="190" r="3" fill="#fff" opacity="0.3"/><circle cx="300" cy="200" r="5" fill="#4caf50" opacity="0.4"/><line x1="30" y1="252" x2="330" y2="252" stroke="#222" stroke-width="1"/><text x="180" y="278" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="13" font-weight="700" fill="#f0f0f0">Bereit! 🎉</text><text x="180" y="302" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Tutorial löschen: VERWALTUNG →</text><text x="180" y="320" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#aaa">Sammlung 🎓 Tutorial → ✕</text><text x="180" y="346" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">Karten-Namen antippen →</text><text x="180" y="364" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#666">Großansicht + links/rechts wischen</text><text x="180" y="390" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" fill="#555">Backups unter SICHERUNG!</text><text x="180" y="416" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" fill="#444">Daten bleiben lokal im Browser.</text></svg>`
    }
  ];

  await dbPut('gruppen', { id: gruppeId, name: '🎓 Tutorial', sammlungId: tutSammlungId, erstellt: new Date().toISOString() });

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

  localStorage.setItem('memofix-tutorial-created', '1');
}

// ============================================================
// INIT
// ============================================================

(async () => {
  await dbInit();
  await erstelleTutorialGruppeWennNeu();
  await ladeAlles();
  await repairOrphanGruppen();
  ladeOpenGruppen();
  ladeGruppenReihenfolge();
  ladeSammlungenReihenfolge();
  ladeOpenSammlungen();
  ladeOpenLernSammlungen();
  renderVerwaltung();
})();

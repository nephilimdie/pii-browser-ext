const $ = id => document.getElementById(id);
const MAX_BYTES = 10 * 1024 * 1024;
let inputBytes = null;
let inputFormat = '';
let inputName = 'immagine';
let protectedImage = null;
let reviewImage = null;
let regions = [];
let manualCovers = [];
let drawing = false;
let start = null;
let draft = null;
const targetTab = Number(new URLSearchParams(location.search).get('tab'));
if (Number.isSafeInteger(targetTab) && targetTab > 0) $('attach').hidden = false;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function formatOf(bytes) {
  if (bytes.length > 12 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'jpeg';
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'webp';
  return '';
}

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

async function bitmap(data, format) {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: `image/${format}` }));
}

async function setInput(bytes, name) {
  const format = formatOf(bytes);
  if (!format || !bytes.length || bytes.length > MAX_BYTES) throw new Error('Usa PNG, JPEG o WebP, massimo 10 MB.');
  inputBytes = bytes;
  inputFormat = format;
  inputName = name || 'immagine';
  $('file-name').textContent = inputName;
  $('protect').disabled = false;
  $('result').hidden = true;
  status('Pronta per la protezione.');
}

$('image-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try { await setInput(new Uint8Array(await file.arrayBuffer()), file.name); }
  catch (error) { inputBytes = null; $('protect').disabled = true; status(error.message, true); }
});

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(response);
  }));
}

$('protect').addEventListener('click', async () => {
  if (!inputBytes) return;
  $('protect').disabled = true;
  $('result').hidden = true;
  status('Analisi in corso…');
  try {
    const result = await send({ type: 'REDACT_IMAGE', data: base64(inputBytes), format: inputFormat, review: true });
    if (result?.safe !== true || !result.image_base64 || result.review_default !== 'cover') throw new Error(result?.error || 'Protezione non confermata.');
    const protectedBitmap = await bitmap(result.image_base64, result.format);
    const reviewBitmap = result.review_image_base64 ? await bitmap(result.review_image_base64, result.format) : null;
    if (reviewBitmap && (reviewBitmap.width !== protectedBitmap.width || reviewBitmap.height !== protectedBitmap.height)) throw new Error('Immagine di revisione non valida.');
    if (result.review_regions > 0 && !reviewBitmap) throw new Error('Aree dubbie senza revisione.');
    protectedImage?.close();
    reviewImage?.close();
    protectedImage = protectedBitmap;
    reviewImage = reviewBitmap;
    regions = (result.review_regions_detail || []).map(r => ({ ...r, visible: false }));
    manualCovers = [];
    $('image').width = protectedBitmap.width;
    $('image').height = protectedBitmap.height;
    $('summary').textContent = `${result.entity_count} elementi protetti · ${regions.length} aree dubbie`;
    renderControls();
    render();
    $('result').hidden = false;
    status('Protezione completata.');
  } catch (error) { status(`${error.message} L'immagine originale non è stata condivisa.`, true); }
  finally { $('protect').disabled = false; }
});

function renderControls() {
  $('regions').replaceChildren();
  regions.forEach((region, index) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !region.visible;
    checkbox.addEventListener('change', () => { region.visible = !checkbox.checked; render(); });
    const span = document.createElement('span');
    span.textContent = `Area ${index + 1} · ${checkbox.checked ? 'coperta' : 'visibile'}`;
    checkbox.addEventListener('change', () => { span.textContent = `Area ${index + 1} · ${checkbox.checked ? 'coperta' : 'visibile'}`; });
    label.append(checkbox, span);
    $('regions').append(label);
  });
}

function paintBox(ctx, bbox, color) {
  const [x0, y0, x1, y1] = bbox;
  ctx.fillStyle = color;
  ctx.fillRect(Math.floor(x0 * ctx.canvas.width), Math.floor(y0 * ctx.canvas.height),
    Math.ceil((x1 - x0) * ctx.canvas.width), Math.ceil((y1 - y0) * ctx.canvas.height));
}

function render() {
  const canvas = $('image');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(protectedImage, 0, 0);
  if (reviewImage) regions.filter(region => region.visible).forEach(region => {
    const [x0, y0, x1, y1] = region.bbox;
    const x = Math.floor(x0 * canvas.width), y = Math.floor(y0 * canvas.height);
    const w = Math.ceil((x1 - x0) * canvas.width), h = Math.ceil((y1 - y0) * canvas.height);
    ctx.drawImage(reviewImage, x, y, w, h, x, y, w, h);
  });
  manualCovers.forEach(box => paintBox(ctx, box, '#000'));
  if (draft) paintBox(ctx, draft, 'rgba(0,0,0,.7)');
}

function point(event) {
  const rect = $('image').getBoundingClientRect();
  return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
}
function box(a, b) { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; }
$('add-cover').addEventListener('click', () => {
  drawing = !drawing;
  $('add-cover').setAttribute('aria-pressed', String(drawing));
  $('image').classList.toggle('drawing', drawing);
  status(drawing ? 'Trascina sull’immagine per aggiungere una copertura.' : '');
});
$('image').addEventListener('pointerdown', event => { if (!drawing || !protectedImage) return; start = point(event); $('image').setPointerCapture(event.pointerId); });
$('image').addEventListener('pointermove', event => { if (!start) return; draft = box(start, point(event)); render(); });
$('image').addEventListener('pointerup', event => {
  if (!start) return;
  const area = box(start, point(event));
  if ((area[2] - area[0]) * $('image').width >= 3 && (area[3] - area[1]) * $('image').height >= 3) manualCovers.push(area);
  start = null; draft = null; render();
});
$('image').addEventListener('pointercancel', () => { start = null; draft = null; render(); });
$('clear-covers').addEventListener('click', () => { manualCovers = []; render(); });
$('download').addEventListener('click', () => {
  if (!protectedImage) return;
  if (regions.some(region => region.visible) && !confirm('Alcune aree dubbie sono visibili. Scaricare comunque?')) return;
  $('image').toBlob(blob => {
    if (!blob) { status('Impossibile creare il file.', true); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${inputName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')}-protetta.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, 'image/png');
});

$('attach').addEventListener('click', async () => {
  if (!protectedImage || !Number.isSafeInteger(targetTab) || targetTab <= 0) return;
  if (regions.some(region => region.visible) && !confirm('Alcune aree dubbie sono visibili. Allegare comunque?')) return;
  $('attach').disabled = true;
  status('Invio della copia protetta alla chat…');
  try {
    const blob = await new Promise(resolve => $('image').toBlob(resolve, 'image/png'));
    if (!blob || blob.size > MAX_BYTES) throw new Error('Immagine protetta troppo grande per la chat. Scaricala.');
    const response = await chrome.tabs.sendMessage(targetTab, {
      type: 'PSEUDORA_ATTACH_PROTECTED_IMAGE', data: base64(new Uint8Array(await blob.arrayBuffer())),
    });
    if (response?.ok !== true) throw new Error('Questa chat non supporta l’allegato automatico. Scarica l’immagine.');
    status('Copia protetta allegata alla chat.');
  } catch (error) { status(error.message, true); }
  finally { $('attach').disabled = false; }
});

let contextImageUrl = '';
async function loadContextImage() {
  const id = new URLSearchParams(location.search).get('image');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
  const key = `contextImage:${id}`;
  const { [key]: pending } = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  if (!pending) return;
  contextImageUrl = pending;
  $('import-url').hidden = false;
  status('Immagine selezionata dal browser. Premi Importa per continuare.');
}
$('import-url').addEventListener('click', async () => {
  if (!contextImageUrl) return;
  $('import-url').disabled = true;
  try {
    const url = new URL(contextImageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Questa immagine non può essere letta dal menu. Scegli il file dal computer.');
    const origin = `${url.origin}/*`;
    if (!await chrome.permissions.contains({ origins: [origin] })
        && !await chrome.permissions.request({ origins: [origin] })) throw new Error('Accesso all’immagine non autorizzato.');
    status('Caricamento immagine…');
    const response = await fetch(url.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Immagine non accessibile o troppo grande.');
    await setInput(new Uint8Array(await response.arrayBuffer()), 'immagine-dal-browser');
    $('import-url').hidden = true;
    contextImageUrl = '';
  } catch (error) { status(`${error.message} Salva l’immagine e caricala qui.`, true); }
  finally { $('import-url').disabled = false; }
});
loadContextImage();

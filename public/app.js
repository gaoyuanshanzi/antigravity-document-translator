'use strict';

// ── Constants ──
const CHUNK_SIZE = 3000;
const INTER_CHUNK_DELAY = 2000;
const MAX_RETRIES = 4;

const LANG_MAP = {
  ko: '\ud55c\uad6d\uc5b4(Korean)',
  en: 'English',
  ja: '\u65e5\u672c\u8a9e(Japanese)',
  zh: '\u4e2d\u6587(Chinese Simplified)',
};

const LANG_NAME_KO = {
  ko: '\ud55c\uad6d\uc5b4',
  en: '\uc601\uc5b4',
  ja: '\uc77c\ubcf8\uc5b4',
  zh: '\uc911\uad6d\uc5b4',
};

// ── State ──
let selectedFile = null;
let parsedContent = null;
let isTranslating = false;
let stopRequested = false;
let hardResetRequested = false;

// ── DOM Ready ──
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupUI();
});

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

async function checkAuth() {
  try {
    const res = await fetch('/api/status');
    const d = await res.json();
    d.loggedIn ? showApp() : showLogin();
  } catch {
    showLogin();
  }
}

function showApp() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  loadApiKeys();

  // Load model preference from localStorage
  const savedModel = localStorage.getItem('gemini_model') || 'gemini-1.5-flash';
  document.getElementById('model-select').value = savedModel;
}
function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
}

// ─────────────────────────────────────────────
// API KEY STORAGE (localStorage)
// ─────────────────────────────────────────────

function getStoredKeys() {
  try { return JSON.parse(localStorage.getItem('gemini_api_keys') || '[]'); }
  catch { return []; }
}

function loadApiKeys() {
  const keys = getStoredKeys();
  const container = document.getElementById('keys-inputs-container');
  container.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const val = keys[i] || '';
    const row = document.createElement('div');
    row.className = 'key-input-row';
    row.innerHTML =
      '<label>API KEY ' + (i + 1) + '</label>' +
      '<input type="password" class="key-input" value="' + val + '" placeholder="AIzaSy...">' +
      '<div class="key-status-dot ' + (val ? 'active' : '') + '"></div>';
    container.appendChild(row);
  }
}

// ─────────────────────────────────────────────
// UI SETUP
// ─────────────────────────────────────────────

function setupUI() {
  // Login
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    const err = document.getElementById('login-error');
    err.textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p }),
      });
      const d = await res.json();
      if (res.ok && d.success) { showApp(); }
      else { err.textContent = d.error || '\ub85c\uadf8\uc778 \uc2e4\ud328'; }
    } catch { err.textContent = '\uc11c\ubc84 \uc5f0\uacb0 \uc624\ub958'; }
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // Save keys
  document.getElementById('keys-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const keys = Array.from(document.querySelectorAll('.key-input'))
      .map(i => i.value.trim()).filter(Boolean);
    localStorage.setItem('gemini_api_keys', JSON.stringify(keys));

    // Save model preference
    const selectedModel = document.getElementById('model-select').value;
    localStorage.setItem('gemini_model', selectedModel);

    const s = document.getElementById('keys-status');
    s.textContent = '\u2705 ' + keys.length + '\uac1c\uc758 API \ud0a4\uc640 \ubaa8\ubc78\uc774 \uc800\uc7a5\ub418\uc5c8\uc2b5\ub2c8\ub2e4.';
    s.style.color = 'var(--success)';
    loadApiKeys();
    setTimeout(() => { s.textContent = ''; }, 3000);
  });

  // Clear logs
  document.getElementById('clear-logs-btn').addEventListener('click', () => {
    document.getElementById('logs-console').innerHTML = '';
  });

  // Drop zone
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
  });

  // Clear file
  document.getElementById('clear-file-btn').addEventListener('click', resetFileSelection);

  // Translation buttons (ko, en, ja, zh)
  document.querySelectorAll('.btn-lang').forEach(btn => {
    btn.addEventListener('click', () => startTranslation(btn.dataset.lang));
  });

  // Pause button
  document.getElementById('stop-translation-btn').addEventListener('click', () => {
    stopRequested = true;
    addLog('warn', '\uc0ac\uc6a9\uc790\uac00 \ubc88\uc5ed \uc77c\uc2dc\uc815\uc9c0\ub97c \uc694\uccad\ud588\uc2b5\ub2c8\ub2e4...');
  });

  // Stop + reset button
  document.getElementById('stop-reset-btn').addEventListener('click', () => {
    hardResetRequested = true;
    if (isTranslating) {
      stopRequested = true;
      addLog('warn', '\u23f9 \ubc88\uc5ed\uc774 \uc911\uc9c0\ub418\uc5c8\uc2b5\ub2c8\ub2e4.');
    }
    resetAll();
    addLog('info', '\ud83d\uddd1 \uc791\uc5c5\uc774 \ucd08\uae30\ud654\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \uc0c8 \ud30c\uc77c\uc744 \uc5c5\ub85c\ub4dc\ud574 \uc8fc\uc138\uc694.');
  });
}

// ─────────────────────────────────────────────
// FILE HANDLING & PARSING
// ─────────────────────────────────────────────

async function handleFileSelected(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['txt', 'html', 'docx'].includes(ext)) {
    addLog('error', '\u274c \uc9c0\uc6d0\ud558\uc9c0 \uc54a\ub294 \ud30c\uc77c \ud615\uc2dd\uc785\ub2c8\ub2e4: .' + ext + ' (.txt, .html, .docx\ub9cc \uac00\ub2a5)');
    return;
  }

  selectedFile = file;
  document.getElementById('selected-filename').textContent = file.name;
  addLog('info', '\ud83d\udcc2 \ud30c\uc77c \uc120\ud0dd\ub428: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)');

  try {
    addLog('info', '\u2699\ufe0f \ud30c\uc77c \ud30c\uc2f1 \uc911...');
    if (ext === 'docx') {
      parsedContent = await parseDocx(file);
    } else if (ext === 'html') {
      parsedContent = await parseHtml(file);
    } else {
      parsedContent = await parseTxt(file);
    }

    const detected = detectLanguage(parsedContent.text);
    const detectedKo = LANG_NAME_KO[detected] || detected;
    const detectedLabel = detected !== 'unknown' ? detectedKo : '\ubd88\uba85\ud655';

    addLog('success',
      '\u2705 \ud30c\uc2f1 \uc644\ub8cc. ' +
      '\ucd1d ' + parsedContent.text.length.toLocaleString() + ' \uc790 (' + parsedContent.format.toUpperCase() + ' \ud615\uc2dd) | ' +
      '\uac10\uc9c0\ub41c \uc5b8\uc5b4: ' + detectedLabel);

    document.getElementById('translation-trigger-panel').classList.remove('hidden');
  } catch (err) {
    addLog('error', '\u274c \ud30c\uc77c \ud30c\uc2f1 \uc624\ub958: ' + err.message);
    resetFileSelection();
  }
}

function parseTxt(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve({ format: 'txt', text: e.target.result });
    reader.onerror = () => reject(new Error('\ud14d\uc2a4\ud2b8 \ud30c\uc77c \uc77d\uae30 \uc624\ub958'));
    reader.readAsText(file, 'UTF-8');
  });
}

function parseHtml(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve({ format: 'html', text: e.target.result });
    reader.onerror = () => reject(new Error('HTML \ud30c\uc77c \uc77d\uae30 \uc624\ub958'));
    reader.readAsText(file, 'UTF-8');
  });
}

function parseDocx(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const result = await mammoth.convertToHtml({ arrayBuffer: e.target.result });
        if (result.messages) {
          result.messages.forEach(m => {
            if (m.type === 'warning') addLog('warn', '\u26a0\ufe0f DOCX \ubcc0\ud658 \uacbd\uace0: ' + m.message);
          });
        }
        resolve({ format: 'html', text: result.value });
      } catch (err) {
        reject(new Error('DOCX \ud30c\uc2f1 \uc2e4\ud328: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('\ud30c\uc77c \uc77d\uae30 \uc624\ub958'));
    reader.readAsArrayBuffer(file);
  });
}

function resetFileSelection() {
  selectedFile = null;
  parsedContent = null;
  document.getElementById('file-input').value = '';
  document.getElementById('translation-trigger-panel').classList.add('hidden');
  document.getElementById('translation-progress-panel').classList.add('hidden');
}

function resetAll() {
  resetFileSelection();
  document.querySelectorAll('.btn-lang').forEach(b => b.disabled = false);
  setProgress(0, 0);
  if (!isTranslating) {
    stopRequested = false;
    hardResetRequested = false;
  }
}

// ─────────────────────────────────────────────
// LANGUAGE DETECTION
// ─────────────────────────────────────────────

function detectLanguage(text) {
  const clean = text.replace(/<[^>]*>/g, '').trim();
  const total = clean.replace(/\s/g, '').length;
  if (total < 30) return 'unknown';

  const koreanChars   = (clean.match(/[\uAC00-\uD7A3\u3130-\u318F]/g) || []).length;
  const japaneseChars = (clean.match(/[\u3040-\u30FF]/g) || []).length;
  const chineseChars  = (clean.match(/[\u4E00-\u9FAF]/g) || []).length - japaneseChars;
  const asciiLetters  = (clean.match(/[a-zA-Z]/g) || []).length;

  if (koreanChars  / total > 0.08) return 'ko';
  if (japaneseChars / total > 0.08) return 'ja';
  if (chineseChars  / total > 0.08) return 'zh';
  if (asciiLetters  / total > 0.25) return 'en';
  return 'unknown';
}

// ─────────────────────────────────────────────
// CHUNKING
// ─────────────────────────────────────────────

function chunkText(text) {
  const paragraphs = text.split(/\r?\n\r?\n/).filter(p => p.trim());
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.substring(0, CHUNK_SIZE)];
}

function chunkHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const blocks = Array.from(doc.body.children);

  const chunks = [];
  let current = '';
  for (const el of blocks) {
    const outerHtml = el.outerHTML;
    if (current.length + outerHtml.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current);
      current = outerHtml;
    } else {
      current += '\n' + outerHtml;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [html.substring(0, CHUNK_SIZE * 2)];
}

// ─────────────────────────────────────────────
// GEMINI API CALL
// ─────────────────────────────────────────────

async function callGemini(apiKey, systemInstruction, userPrompt, modelName = 'gemini-1.5-flash') {
  const apiVersion = modelName.includes('2.0') ? 'v1beta' : 'v1';
  const url = 'https://generativelanguage.googleapis.com/' + apiVersion + '/models/' + modelName + ':generateContent?key=' + apiKey;
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const e = new Error(errData.error && errData.error.message ? errData.error.message : 'HTTP ' + res.status);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  const text = data && data.candidates && data.candidates[0] &&
               data.candidates[0].content && data.candidates[0].content.parts &&
               data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!text) throw new Error('Gemini \uc751\ub2f5 \ud615\uc2dd \uc624\ub958: ' + JSON.stringify(data).substring(0, 200));
  return text;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// MAIN TRANSLATION LOOP
// ─────────────────────────────────────────────

async function startTranslation(targetLang) {
  if (isTranslating) { addLog('warn', '\uc774\ubbf8 \ubc88\uc5ed \uc911\uc785\ub2c8\ub2e4.'); return; }
  if (!parsedContent) { addLog('error', '\ud30c\uc77c\uc744 \uba3c\uc800 \uc120\ud0dd\ud574 \uc8fc\uc138\uc694.'); return; }

  const apiKeys = Array.from(getStoredKeys()); // copy so we can mutate
  if (apiKeys.length === 0) {
    addLog('error', '\u274c API \ud0a4\uac00 \uc5c6\uc2b5\ub2c8\ub2e4. \uc67c\ucabd\uc5d0\uc11c Gemini API \ud0a4\ub97c \uc785\ub825\ud558\uace0 \uc800\uc7a5\ud574 \uc8fc\uc138\uc694.');
    return;
  }

  // ── Language Detection: block same-language pairs ──
  const detected     = detectLanguage(parsedContent.text);
  const targetLangKo = LANG_NAME_KO[targetLang] || targetLang;
  const detectedKo   = LANG_NAME_KO[detected]   || detected;

  if (detected !== 'unknown' && detected === targetLang) {
    alert(
      '\u26a0\ufe0f \uc6d0\ubcf8 \uc5b8\uc5b4\uc640 \ubc88\uc5ed \uc5b8\uc5b4\uac00 \ub3d9\uc77c\ud569\ub2c8\ub2e4 (' + detectedKo + ').\n' +
      '\ubc88\uc5ed\uc774 \ud544\uc694\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4. \ub2e4\ub978 \uc5b8\uc5b4\ub97c \uc120\ud0dd\ud574 \uc8fc\uc138\uc694.'
    );
    addLog('warn', '\u26a0\ufe0f \uc6d0\ubcf8(' + detectedKo + ') \u2192 \ubc88\uc5ed(' + targetLangKo + '): \ub3d9\uc77c \uc5b8\uc5b4. \ubc88\uc5ed\uc744 \uc2e4\ud589\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.');
    return;
  }

  if (detected === 'unknown') {
    addLog('warn', '\u26a0\ufe0f \uc6d0\ubcf8 \uc5b8\uc5b4\ub97c \uc790\ub3d9 \uac10\uc9c0\ud558\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4. \uc5b8\uc5b4\uac00 \ub9de\ub294\uc9c0 \ud655\uc778 \ud6c4 \uacc4\uc18d \uc9c4\ud589\ud569\ub2c8\ub2e4.');
  } else {
    addLog('info', '\ud83d\udd0d \uc6d0\ubcf8 \uc5b8\uc5b4 \uac10\uc9c0: ' + detectedKo + ' \u2192 ' + targetLangKo + ' \ubc88\uc5ed');
  }

  isTranslating = true;
  stopRequested = false;
  hardResetRequested = false;

  // UI: show progress, disable buttons
  document.querySelectorAll('.btn-lang').forEach(b => b.disabled = true);
  document.getElementById('translation-progress-panel').classList.remove('hidden');

  // Read selected AI model
  const selectedModel = document.getElementById('model-select').value || 'gemini-1.5-flash';

  const langName = LANG_MAP[targetLang] || targetLang;
  const isHtml   = parsedContent.format === 'html';

  // Generic system instruction — works for any source/target language pair
  const systemInstruction = isHtml
    ? 'You are a professional literary translator. ' +
      'Translate the following document (HTML format) into ' + langName + ' naturally and fluently.\n' +
      'Strict rules:\n' +
      '1. Preserve all HTML tags (p, strong, em, a, h1-h6, li, td, etc.) and their attributes exactly. Translate only the text inside the tags.\n' +
      '2. Do not break or omit any part of the HTML structure.\n' +
      '3. Maintain narrative consistency: preserve tone, character names, place names, and proper nouns.\n' +
      '4. Output ONLY the translated HTML body. No explanations, no markdown code fences.'
    : 'You are a professional literary translator. ' +
      'Translate the following document into ' + langName + ' naturally and fluently.\n' +
      'Strict rules:\n' +
      '1. Maintain narrative consistency: preserve tone, character names, place names, and proper nouns.\n' +
      '2. Output ONLY the translated text. No explanations, no markdown formatting.';

  const chunks = isHtml ? chunkHtml(parsedContent.text) : chunkText(parsedContent.text);
  const total  = chunks.length;

  addLog('info', '\ud83d\ude80 ' + langName + ' \ubc88\uc5ed \uc2dc\uc791 (' + selectedModel + '). \uccd9 ' + total + '\uac1c \uccad\ud06c, ' + apiKeys.length + '\uac1c API \ud0a4 \uc0ac\uc6a9.');
  setProgress(0, total);

  const translatedChunks = [];
  let keyIndex = 0;

  for (let i = 0; i < total; i++) {
    if (stopRequested) {
      addLog('warn', '\u23f9 \ubc88\uc5ed\uc774 \uc911\uc9c0\ub418\uc5c8\uc2b5\ub2c8\ub2e4.');
      break;
    }

    const chunk = chunks[i];
    let contextHint = '';
    if (i > 0 && translatedChunks[i - 1]) {
      const prev = translatedChunks[i - 1].replace(/<[^>]*>/g, '').substring(0, 400);
      contextHint = '[Previous translation for context — do NOT translate this; use only for terminology/tone consistency]:\n' + prev + '\n========\n\n';
    }
    const prompt = contextHint + 'Translate the following:\n\n' + chunk;

    let success = false;
    let retries = MAX_RETRIES;
    let delay   = 2000;
    let consecutiveRateLimits = 0;

    while (retries > 0 && !success && !stopRequested) {
      const currentKey = apiKeys[keyIndex % apiKeys.length];
      try {
        addLog('info', '\ud83d\udd04 \uccad\ud06c ' + (i + 1) + '/' + total + ' \ubc88\uc5ed \uc911 (API Key #' + ((keyIndex % apiKeys.length) + 1) + ')...');
        const translated = await callGemini(currentKey, systemInstruction, prompt, selectedModel);
        translatedChunks.push(translated);
        addLog('success', '\u2705 \uccad\ud06c ' + (i + 1) + '/' + total + ' \uc644\ub8cc');
        success = true;
        consecutiveRateLimits = 0;
        setProgress(i + 1, total);
        if (i < total - 1) {
          await sleep(INTER_CHUNK_DELAY);
          if (stopRequested) break;
        }

      } catch (err) {
        if (err.status === 429) {
          consecutiveRateLimits++;
          addLog('warn', '\u26a0\ufe0f 429 Rate Limit (API Key #' + ((keyIndex % apiKeys.length) + 1) + ') \uac10\uc9c0: ' + err.message);
          if (apiKeys.length > 1 && consecutiveRateLimits < apiKeys.length) {
            keyIndex++;
            addLog('warn', '\u26a0\ufe0f \ub2e4\uc74c API Key #' + ((keyIndex % apiKeys.length) + 1) + '\ub85c \uc804\ud658 \uc911...');
            await sleep(1000);
            if (stopRequested) break;
          } else {
            addLog('warn', '\u26a0\ufe0f \ubaa8\ub4e0 API \ud0a4\uac00 Rate Limit \uc0c1\ud0dc\uc785\ub2c8\ub2e4. ' + (delay / 1000) + '\ucd08 \ud6c4 \uc7ac\uc2dc\ub3c4... (\ub0a8\uc740 \uc2dc\ub3c4: ' + (retries - 1) + ')');
            await sleep(delay);
            if (stopRequested) break;
            delay = Math.min(delay * 2, 60000);
            retries--;
            consecutiveRateLimits = 0;
            keyIndex++;
          }
        } else if (err.status === 400 || err.status === 403) {
          addLog('error', '\u274c API Key #' + ((keyIndex % apiKeys.length) + 1) + ' \uc624\ub958 (' + err.status + '): ' + err.message + '. \ub2e4\uc74c \ud0a4\ub85c \uc774\ub3d9...');
          apiKeys.splice(keyIndex % apiKeys.length, 1);
          if (apiKeys.length === 0) {
            addLog('error', '\u274c \ubaa8\ub4e0 API \ud0a4\uac00 \uc720\ud6a8\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4. \ubc88\uc5ed\uc744 \uc911\ub2e8\ud569\ub2c8\ub2e4.');
            retries = 0;
          }
        } else {
          addLog('warn', '\u26a0\ufe0f \uc624\ub958: ' + err.message + '. ' + (delay / 1000) + '\ucd08 \ud6c4 \uc7ac\uc2dc\ub3c4...');
          await sleep(delay);
          if (stopRequested) break;
          delay = Math.min(delay * 2, 30000);
          retries--;
        }
      }
    }

    if (!success && !stopRequested) {
      addLog('error', '\u274c \uccad\ud06c ' + (i + 1) + ' \ubc88\uc5ed \uc2e4\ud328 (\ucd5c\ub300 \uc7ac\uc2dc\ub3c4 \ucd08\uacfc). \ubc88\uc5ed\uc744 \uc911\ub2e8\ud569\ub2c8\ub2e4.');
      break;
    }
  }

  // Assemble output
  if (!hardResetRequested && translatedChunks.length > 0) {
    addLog('info', '\ud83d\udcdd \ucd5c\uc885 \ubb38\uc11c \uc870\ub9bd \uc911...');
    const finalHtml = assembleOutput(translatedChunks, isHtml, targetLang, selectedFile.name);
    downloadHtml(finalHtml, targetLang, selectedFile.name);
    addLog('success', '\ud83c\udf89 \ubc88\uc5ed \uc644\ub8cc! \ub2e4\uc6b4\ub85c\ub4dc\uac00 \uc2dc\uc791\ub429\ub2c8\ub2e4.');
  }

  // Reset UI and state variables
  isTranslating = false;
  stopRequested = false;
  hardResetRequested = false;
  document.querySelectorAll('.btn-lang').forEach(b => b.disabled = false);
}

// ─────────────────────────────────────────────
// OUTPUT ASSEMBLY & DOWNLOAD
// ─────────────────────────────────────────────

function assembleOutput(chunks, isHtml, lang, originalName) {
  let body = '';
  if (isHtml) {
    body = chunks.join('\n');
  } else {
    body = chunks
      .join('\n\n')
      .split(/\r?\n\r?\n/)
      .map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>')
      .join('\n');
  }

  return '<!DOCTYPE html>\n' +
    '<html lang="' + lang + '">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '  <title>Translated (' + lang.toUpperCase() + ') - ' + originalName + '</title>\n' +
    '  <style>\n' +
    '    body { font-family: "Times New Roman", Times, serif; line-height: 1.9; color: #222; max-width: 800px; margin: 50px auto; padding: 0 24px; text-align: justify; }\n' +
    '    p { margin-bottom: 1.5em; text-indent: 1.2em; }\n' +
    '    h1,h2,h3,h4,h5,h6 { color: #111; margin: 2em 0 0.6em; text-align: center; }\n' +
    '    ul,ol { margin-bottom: 1.5em; padding-left: 2em; }\n' +
    '    li { margin-bottom: 0.4em; }\n' +
    '    table { border-collapse: collapse; width: 100%; margin-bottom: 1.5em; }\n' +
    '    th,td { border: 1px solid #ccc; padding: 8px 12px; }\n' +
    '    th { background: #f5f5f5; }\n' +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    body + '\n' +
    '</body>\n' +
    '</html>';
}

function downloadHtml(html, lang, originalName) {
  const base     = originalName.replace(/\.[^.]+$/, '');
  const fileName = 'translated_' + lang + '_' + base + '.html';
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
// PROGRESS & LOG HELPERS
// ─────────────────────────────────────────────

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('main-progress-bar').style.width = pct + '%';
  document.getElementById('progress-chunks').textContent = done + ' / ' + total + ' \uccad\ud06c';
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-label').textContent = done >= total && total > 0
    ? '\u2705 \ubc88\uc5ed \uc644\ub8cc!'
    : '\ubc88\uc5ed \uc9c4\ud589 \uc911... (' + done + '/' + total + ' \uccad\ud06c)';
}

function addLog(level, message) {
  const el    = document.getElementById('logs-console');
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + level;
  const now = new Date();
  const t   = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
  entry.innerHTML = '<span class="log-time">' + t + '</span>' + message;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

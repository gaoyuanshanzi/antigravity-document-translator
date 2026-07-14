/* ─────────────────────────────────────────────────────────────────
   Client-Side Korean Document Translator
   - No server-side DB dependency
   - API keys stored in localStorage
   - File parsing in-browser (mammoth.js for DOCX)
   - Gemini API called directly from browser
   - Progress tracked entirely client-side
   ───────────────────────────────────────────────────────────────── */

'use strict';

// ── Constants ──
const CHUNK_SIZE = 3000;       // chars per chunk
const INTER_CHUNK_DELAY = 2000; // ms between successful API calls (free tier RPM guard)
const MAX_RETRIES = 4;

const LANG_MAP = {
  en: 'English',
  ja: '日本語(Japanese)',
  zh: '中文(Chinese Simplified)',
};

const LANG_NAME_KO = {
  en: '영어',
  ja: '일본어',
  zh: '중국어',
  ko: '한국어',
};

// ── State ──
let selectedFile = null;
let parsedContent = null;  // { format: 'txt'|'html', text: string }
let isTranslating = false;
let stopRequested = false;

// ── DOM Ready ──
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupUI();
});

// ─────────────────────────────────────────────
// AUTH (server handles session cookie)
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
    row.innerHTML = `
      <label>API KEY ${i + 1}</label>
      <input type="password" class="key-input" value="${val}" placeholder="AIzaSy...">
      <div class="key-status-dot ${val ? 'active' : ''}"></div>`;
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
      else { err.textContent = d.error || '로그인 실패'; }
    } catch { err.textContent = '서버 연결 오류'; }
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
    const s = document.getElementById('keys-status');
    s.textContent = `✅ ${keys.length}개의 API 키가 저장되었습니다.`;
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

  // Translation buttons
  document.querySelectorAll('.btn-lang').forEach(btn => {
    btn.addEventListener('click', () => startTranslation(btn.dataset.lang));
  });

  // Stop button
  document.getElementById('stop-translation-btn').addEventListener('click', () => {
    stopRequested = true;
    addLog('warn', '사용자가 번역 중지를 요청했습니다...');
  });

  // Stop AND reset button
  document.getElementById('stop-reset-btn').addEventListener('click', () => {
    if (isTranslating) {
      stopRequested = true;
      addLog('warn', '⏹ 번역이 중지되었습니다.');
    }
    setTimeout(() => {
      resetAll();
      addLog('info', '🗑 작업이 초기화되었습니다. 새 파일을 업로드해 주세요.');
    }, 400);
  });
}

// ─────────────────────────────────────────────
// FILE HANDLING & PARSING
// ─────────────────────────────────────────────

async function handleFileSelected(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['txt', 'html', 'docx'].includes(ext)) {
    addLog('error', `❌ 지원하지 않는 파일 형식입니다: .${ext} (.txt, .html, .docx만 가능)`);
    return;
  }

  selectedFile = file;
  document.getElementById('selected-filename').textContent = file.name;

  addLog('info', `📂 파일 선택됨: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

  try {
    addLog('info', '⚙️ 파일 파싱 중...');
    if (ext === 'docx') {
      parsedContent = await parseDocx(file);
    } else if (ext === 'html') {
      parsedContent = await parseHtml(file);
    } else {
      parsedContent = await parseTxt(file);
    }
    addLog('success', `✅ 파싱 완료. 총 ${parsedContent.text.length.toLocaleString()} 자 (${parsedContent.format.toUpperCase()} 형식)`);
    document.getElementById('translation-trigger-panel').classList.remove('hidden');
  } catch (err) {
    addLog('error', `❌ 파일 파싱 오류: ${err.message}`);
    resetFileSelection();
  }
}

function parseTxt(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve({ format: 'txt', text: e.target.result });
    reader.onerror = () => reject(new Error('텍스트 파일 읽기 오류'));
    reader.readAsText(file, 'UTF-8');
  });
}

function parseHtml(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve({ format: 'html', text: e.target.result });
    reader.onerror = () => reject(new Error('HTML 파일 읽기 오류'));
    reader.readAsText(file, 'UTF-8');
  });
}

function parseDocx(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const result = await mammoth.convertToHtml({ arrayBuffer: e.target.result });
        if (result.messages && result.messages.length > 0) {
          result.messages.forEach(m => {
            if (m.type === 'warning') addLog('warn', `⚠️ DOCX 변환 경고: ${m.message}`);
          });
        }
        resolve({ format: 'html', text: result.value });
      } catch (err) {
        reject(new Error(`DOCX 파싱 실패: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error('파일 읽기 오류'));
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
  isTranslating = false;
  stopRequested = false;
  resetFileSelection();
  document.querySelectorAll('.btn-lang').forEach(b => b.disabled = false);
  setProgress(0, 0);
}

// ─────────────────────────────────────────────
// LANGUAGE DETECTION
// ─────────────────────────────────────────────

function detectLanguage(text) {
  // Strip HTML tags for clean analysis
  const clean = text.replace(/<[^>]*>/g, '').trim();
  const total = clean.replace(/\s/g, '').length;
  if (total < 30) return 'unknown';

  const koreanChars  = (clean.match(/[\uAC00-\uD7A3\u3130-\u318F]/g) || []).length;
  const japaneseChars = (clean.match(/[\u3040-\u30FF]/g) || []).length;
  const chineseOnlyChars = (clean.match(/[\u4E00-\u9FAF]/g) || []).length - japaneseChars;
  const asciiLetters = (clean.match(/[a-zA-Z]/g) || []).length;

  if (koreanChars / total > 0.08) return 'ko';
  if (japaneseChars / total > 0.08) return 'ja';
  if (chineseOnlyChars / total > 0.08) return 'zh';
  if (asciiLetters / total > 0.25) return 'en';
  return 'unknown';
}

// ─────────────────────────────────────────────
// CHUNKING
// ─────────────────────────────────────────────

function chunkText(text) {
  // Split by paragraph (double newline) and accumulate to CHUNK_SIZE
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
  // Parse HTML and split at block-level elements
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

async function callGemini(apiKey, systemInstruction, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
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
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error?.message || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 응답 형식 오류: ' + JSON.stringify(data).substring(0, 200));
  return text;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// MAIN TRANSLATION LOOP
// ─────────────────────────────────────────────

async function startTranslation(targetLang) {
  if (isTranslating) { addLog('warn', '이미 번역 중입니다.'); return; }
  if (!parsedContent) { addLog('error', '파일을 먼저 선택해 주세요.'); return; }

  const apiKeys = getStoredKeys();
  if (apiKeys.length === 0) {
    addLog('error', '❌ API 키가 없습니다. 왼쪽에서 Gemini API 키를 입력하고 저장해 주세요.');
    return;
  }

  // ── Language Detection ──
  const detected = detectLanguage(parsedContent.text);
  const targetLangKo = LANG_NAME_KO[targetLang] || targetLang;
  const detectedKo  = LANG_NAME_KO[detected]   || detected;

  if (detected === targetLang) {
    addLog('error',
      `❌ 원본 문건이 이미 ${detectedKo}(으)로 작성된 것으로 감지됩니다. ` +
      `${targetLangKo} 번역은 필요하지 않습니다. 다른 언어를 선택하거나 한국어 문건을 업로드해 주세요.`);
    return;
  }

  if (detected !== 'ko' && detected !== 'unknown') {
    addLog('error',
      `❌ 이 서비스는 한국어 → 외국어 번역 전용입니다. ` +
      `원본 문건의 언어가 ${detectedKo}(으)로 감지되었습니다. 한국어 문건을 업로드해 주세요.`);
    return;
  }

  if (detected === 'unknown') {
    addLog('warn', `⚠️ 원본 언어를 자동 감지하지 못했습니다. 한국어 문건이 맞는지 확인 후 계속 진행합니다.`);
  }

  isTranslating = true;
  stopRequested = false;

  // UI: show progress, hide buttons
  document.querySelectorAll('.btn-lang').forEach(b => b.disabled = true);
  document.getElementById('translation-progress-panel').classList.remove('hidden');

  const langName = LANG_MAP[targetLang] || targetLang;
  const isHtml = parsedContent.format === 'html';

  const systemInstruction = isHtml
    ? `당신은 소설 전문 번역가입니다. 주어진 한국어 소설 본문(HTML 형식)을 ${langName}로 자연스럽게 번역하세요.
반드시 지켜야 할 규칙:
1. HTML 태그(p, strong, em, a, h1~h6, li, td 등)의 구조와 속성은 그대로 유지하고 태그 안의 텍스트만 번역하세요.
2. HTML 구조가 깨지거나 누락되지 않도록 주의하십시오.
3. 소설의 문맥(톤앤매너, 인명/지명 등 고유명사 연결성)을 매끄럽게 유지하십시오.
4. 번역된 HTML 본문만 출력하고, 다른 설명이나 마크다운 백틱(\`\`\`html 등)은 절대 포함하지 마십시오.`
    : `당신은 소설 전문 번역가입니다. 주어진 한국어 소설 본문을 ${langName}로 자연스럽게 번역하세요.
반드시 지켜야 할 규칙:
1. 소설의 문맥(톤앤매너, 인명/지명 등 고유명사 연결성)을 매끄럽게 유지하십시오.
2. 번역된 본문만 출력하고, 다른 설명이나 마크다운 형식 등은 절대 포함하지 마십시오.`;

  const chunks = isHtml ? chunkHtml(parsedContent.text) : chunkText(parsedContent.text);
  const total = chunks.length;

  addLog('info', `🚀 ${langName} 번역 시작. 총 ${total}개 청크, ${apiKeys.length}개 API 키 사용.`);
  setProgress(0, total);

  const translatedChunks = [];
  let keyIndex = 0;

  for (let i = 0; i < total; i++) {
    if (stopRequested) {
      addLog('warn', '⏹ 번역이 중지되었습니다.');
      break;
    }

    const chunk = chunks[i];
    let contextHint = '';
    if (i > 0 && translatedChunks[i - 1]) {
      const prev = translatedChunks[i - 1].replace(/<[^>]*>/g, '').substring(0, 400);
      contextHint = `[이전 번역문 참고 - 번역하지 말고 문맥/인명/톤앤매너 연결용으로만 참고]:\n${prev}\n========\n\n`;
    }
    const prompt = `${contextHint}다음 본문을 번역해줘:\n\n${chunk}`;

    let success = false;
    let retries = MAX_RETRIES;
    let delay = 2000;

    while (retries > 0 && !success && !stopRequested) {
      const currentKey = apiKeys[keyIndex % apiKeys.length];
      try {
        addLog('info', `🔄 청크 ${i + 1}/${total} 번역 중 (API Key #${(keyIndex % apiKeys.length) + 1})...`);
        const translated = await callGemini(currentKey, systemInstruction, prompt);
        translatedChunks.push(translated);
        addLog('success', `✅ 청크 ${i + 1}/${total} 완료`);
        success = true;
        setProgress(i + 1, total);
        if (i < total - 1) await sleep(INTER_CHUNK_DELAY);

      } catch (err) {
        if (err.status === 429) {
          if (apiKeys.length > 1) {
            keyIndex++;
            addLog('warn', `⚠️ 429 Rate Limit. API Key #${(keyIndex % apiKeys.length) + 1}로 전환 중...`);
            await sleep(1000);
          } else {
            addLog('warn', `⚠️ 429 Rate Limit. ${delay / 1000}초 후 재시도... (남은 시도: ${retries - 1})`);
            await sleep(delay);
            delay = Math.min(delay * 2, 60000);
            retries--;
          }
        } else if (err.status === 400 || err.status === 403) {
          addLog('error', `❌ API Key #${(keyIndex % apiKeys.length) + 1} 오류 (${err.status}): ${err.message}. 다음 키로 이동...`);
          apiKeys.splice(keyIndex % apiKeys.length, 1);
          if (apiKeys.length === 0) {
            addLog('error', '❌ 모든 API 키가 유효하지 않습니다. 번역을 중단합니다.');
            retries = 0;
          }
        } else {
          addLog('warn', `⚠️ 오류: ${err.message}. ${delay / 1000}초 후 재시도...`);
          await sleep(delay);
          delay = Math.min(delay * 2, 30000);
          retries--;
        }
      }
    }

    if (!success && !stopRequested) {
      addLog('error', `❌ 청크 ${i + 1} 번역 실패 (최대 재시도 초과). 번역을 중단합니다.`);
      break;
    }
  }

  // Assemble output
  if (translatedChunks.length > 0) {
    addLog('info', '📝 최종 문서 조립 중...');
    const finalHtml = assembleOutput(translatedChunks, isHtml, targetLang, selectedFile.name);
    downloadHtml(finalHtml, targetLang, selectedFile.name);
    addLog('success', `🎉 번역 완료! 다운로드가 시작됩니다.`);
  }

  // Reset UI
  isTranslating = false;
  stopRequested = false;
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
      .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('\n');
  }

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Translated (${lang.toUpperCase()}) - ${originalName}</title>
  <style>
    body { font-family: 'Times New Roman', Times, serif; line-height: 1.9; color: #222; max-width: 800px; margin: 50px auto; padding: 0 24px; text-align: justify; }
    p { margin-bottom: 1.5em; text-indent: 1.2em; }
    h1,h2,h3,h4,h5,h6 { color: #111; margin: 2em 0 0.6em; text-align: center; }
    ul,ol { margin-bottom: 1.5em; padding-left: 2em; }
    li { margin-bottom: 0.4em; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1.5em; }
    th,td { border: 1px solid #ccc; padding: 8px 12px; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function downloadHtml(html, lang, originalName) {
  const base = originalName.replace(/\.[^.]+$/, '');
  const fileName = `translated_${lang}_${base}.html`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
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
  document.getElementById('progress-chunks').textContent = `${done} / ${total} 청크`;
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-label').textContent = done >= total
    ? '✅ 번역 완료!'
    : `번역 진행 중... (${done}/${total} 청크)`;
}

function addLog(level, message) {
  const console_ = document.getElementById('logs-console');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const now = new Date();
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  entry.innerHTML = `<span class="log-time">${t}</span>${message}`;
  console_.appendChild(entry);
  console_.scrollTop = console_.scrollHeight;
}

// State variables
let activeJobIdForLogs = null;
let logPollInterval = null;
let jobsPollInterval = null;
let currentUploadedJobId = null;

// Helper: read API keys stored in browser localStorage
function getStoredKeys() {
  try {
    return JSON.parse(localStorage.getItem('gemini_api_keys') || '[]');
  } catch (e) {
    return [];
  }
}

// Initialize app on load
document.addEventListener('DOMContentLoaded', () => {
  checkAuthStatus();
  setupEventListeners();
});

// Check if user is logged in
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.loggedIn) {
      showApp();
    } else {
      showLogin();
    }
  } catch (error) {
    console.error('Error checking auth status:', error);
    showLogin();
  }
}

// Show/Hide UI layers
function showApp() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  
  // Start polling jobs list
  startJobsPolling();
  // Fetch API keys
  loadApiKeys();
}

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  stopJobsPolling();
  stopLogsPolling();
}

// Setup all event listeners
function setupEventListeners() {
  // Login Form
  const loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('login-error');
    errorDiv.textContent = '';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showApp();
      } else {
        errorDiv.textContent = data.error || '로그인 실패';
      }
    } catch (err) {
      errorDiv.textContent = '서버 통신 오류가 발생했습니다.';
    }
  });

  // Logout Button
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
      showLogin();
    } catch (err) {
      console.error('Logout error:', err);
    }
  });

  // Save API keys Form
  const keysForm = document.getElementById('keys-form');
  keysForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputs = document.querySelectorAll('.key-input');
    const keys = Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);
    const statusDiv = document.getElementById('keys-status');
    statusDiv.textContent = '저장 중...';

    try {
      // Always save to localStorage first (works on Vercel serverless too)
      localStorage.setItem('gemini_api_keys', JSON.stringify(keys));

      // Best-effort save to server DB (works when persistent, e.g. local dev)
      await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys })
      });

      statusDiv.textContent = `✅ ${keys.length}개의 API 키가 저장되었습니다.`;
      statusDiv.style.color = 'var(--color-success)';
      loadApiKeys();
      setTimeout(() => { statusDiv.textContent = ''; }, 3000);
    } catch (err) {
      statusDiv.textContent = '통신 에러';
      statusDiv.style.color = 'var(--color-danger)';
    }
  });

  // Drag and Drop Zone
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFileUpload(fileInput.files[0]);
    }
  });

  // Direct language translation triggers (immediately after uploading)
  const langButtons = document.querySelectorAll('.btn-lang');
  langButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetLang = btn.dataset.lang;
      if (!currentUploadedJobId) return;

      const apiKeys = getStoredKeys();
      if (apiKeys.length === 0) {
        alert('Gemini API 키가 없습니다. 왼쪽 패널에서 API 키를 입력하고 저장해 주세요.');
        return;
      }

      try {
        const res = await fetch(`/api/jobs/${currentUploadedJobId}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_lang: targetLang, api_keys: apiKeys })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          openLogs(currentUploadedJobId, document.getElementById('upload-filename').textContent);
          document.getElementById('translation-trigger-panel').classList.add('hidden');
          document.getElementById('upload-progress-container').classList.add('hidden');
          currentUploadedJobId = null;
          fetchJobsList();
        } else {
          alert(data.error || '번역 시작 실패');
        }
      } catch (err) {
        alert('번역 시작 중 오류가 발생했습니다.');
      }
    });
  });

  // Close Logs Panel Button
  document.getElementById('close-logs-btn').addEventListener('click', () => {
    stopLogsPolling();
    document.getElementById('logs-panel').classList.add('hidden');
  });
}

// Load API Keys — prefer localStorage (works on Vercel), fall back to server DB
async function loadApiKeys() {
  const container = document.getElementById('keys-inputs-container');
  container.innerHTML = '';

  // Try to get keys from localStorage first
  const localKeys = getStoredKeys();

  // Build 5 input slots
  for (let i = 0; i < 5; i++) {
    const storedVal = localKeys[i] || '';

    const row = document.createElement('div');
    row.className = 'key-input-row';

    const label = document.createElement('label');
    label.textContent = `API KEY ${i + 1}`;

    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'key-input';
    input.value = storedVal;
    input.placeholder = 'AIzaSy...';

    const indicator = document.createElement('span');
    indicator.className = `key-status-indicator ${storedVal ? 'active' : ''}`;
    indicator.title = storedVal ? 'Key Saved Locally' : 'Empty Slot';

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(indicator);
    container.appendChild(row);
  }
}

// Handle File Upload using XHR for smooth progress tracking
function handleFileUpload(file) {
  const allowedExts = ['.docx', '.txt', '.html'];
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowedExts.includes(ext)) {
    alert('허용되지 않는 파일 형식입니다. .txt, .html, .docx 파일만 가능합니다.');
    return;
  }

  // Show progress bar container
  const progressContainer = document.getElementById('upload-progress-container');
  const filenameSpan = document.getElementById('upload-filename');
  const percentageSpan = document.getElementById('upload-percentage');
  const progressBarFill = document.getElementById('upload-progress-bar');
  const triggerPanel = document.getElementById('translation-trigger-panel');

  filenameSpan.textContent = file.name;
  percentageSpan.textContent = '0%';
  progressBarFill.style.width = '0%';
  progressContainer.classList.remove('hidden');
  triggerPanel.classList.add('hidden');

  const formData = new FormData();
  formData.append('document', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);

  // Track upload progress
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percentage = Math.round((e.loaded / e.total) * 100);
      percentageSpan.textContent = `${percentage}%`;
      progressBarFill.style.style = `width: ${percentage}%`;
      // Workaround for layout width string
      progressBarFill.style.width = `${percentage}%`;
    }
  };

  xhr.onload = () => {
    if (xhr.status === 200) {
      try {
        const response = JSON.parse(xhr.responseText);
        currentUploadedJobId = response.jobId;
        
        // Show triggers
        percentageSpan.textContent = '업로드 및 분석 완료';
        progressBarFill.style.width = '100%';
        triggerPanel.classList.remove('hidden');
        
        // Refresh job list
        fetchJobsList();
      } catch (err) {
        alert('서버 응답 파싱 실패');
      }
    } else {
      let errText = '업로드 실패';
      try {
        const response = JSON.parse(xhr.responseText);
        errText = response.error || errText;
      } catch(e) {}
      alert(`에러: ${errText}`);
      progressContainer.classList.add('hidden');
    }
  };

  xhr.onerror = () => {
    alert('업로드 중 통신 오류가 발생했습니다.');
    progressContainer.classList.add('hidden');
  };

  xhr.send(formData);
}

// Fetch all jobs list from backend
async function fetchJobsList() {
  try {
    const res = await fetch('/api/jobs');
    const data = await res.json();
    renderJobsTable(data.jobs);
  } catch (err) {
    console.error('Error fetching jobs:', err);
  }
}

// Render the jobs list table
function renderJobsTable(jobs) {
  const tbody = document.getElementById('jobs-tbody');
  
  if (!jobs || jobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="no-data">등록된 번역 작업이 없습니다.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  
  const LANG_LABELS = { en: '영어', ja: '일본어', zh: '중국어' };

  jobs.forEach(job => {
    const tr = document.createElement('tr');
    
    // 1. Filename
    const tdName = document.createElement('td');
    tdName.textContent = job.filename;
    tr.appendChild(tdName);

    // 2. Target language
    const tdLang = document.createElement('td');
    tdLang.textContent = LANG_LABELS[job.target_lang] || job.target_lang || '-';
    tr.appendChild(tdLang);

    // 3. Progress
    const tdProgress = document.createElement('td');
    const total = job.total_chunks || 0;
    const completed = job.completed_chunks || 0;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    tdProgress.innerHTML = `
      <div class="job-progress-wrapper">
        <span class="job-progress-text">${completed}/${total} 청크 (${pct}%)</span>
        <div class="progress-bar-bg" style="height: 6px;">
          <div class="progress-bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
    tr.appendChild(tdProgress);

    // 4. Status Badge
    const tdStatus = document.createElement('td');
    tdStatus.innerHTML = `<span class="badge badge-${job.status}">${translateStatus(job.status)}</span>`;
    tr.appendChild(tdStatus);

    // 5. Upload Time
    const tdTime = document.createElement('td');
    tdTime.textContent = new Date(job.created_at).toLocaleString('ko-KR', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    tr.appendChild(tdTime);

    // 6. Action buttons
    const tdActions = document.createElement('td');
    tdActions.className = 'actions-cell';

    // Logs Button (Always visible once set up)
    if (job.status !== 'analyzing') {
      const btnLog = document.createElement('button');
      btnLog.className = 'btn-action btn-action-secondary';
      btnLog.textContent = '로그';
      btnLog.addEventListener('click', () => openLogs(job.job_id, job.filename));
      tdActions.appendChild(btnLog);
    }

    // Translation controls
    if (job.status === 'pending' && !job.target_lang) {
      // In case we uploaded but didn't select language yet
      const selBtn = document.createElement('button');
      selBtn.className = 'btn-action btn-action-primary';
      selBtn.textContent = '번역 시작';
      selBtn.addEventListener('click', () => {
        const lang = prompt('번역할 언어를 입력하세요 (en, ja, zh):', 'en');
        if (lang) startJobTranslation(job.job_id, lang);
      });
      tdActions.appendChild(selBtn);
    } else if (job.status === 'processing') {
      const btnPause = document.createElement('button');
      btnPause.className = 'btn-action btn-action-danger';
      btnPause.textContent = '일시정지';
      btnPause.addEventListener('click', () => pauseJob(job.job_id));
      tdActions.appendChild(btnPause);
    } else if (job.status === 'paused' || job.status === 'failed') {
      const btnResume = document.createElement('button');
      btnResume.className = 'btn-action btn-action-primary';
      btnResume.textContent = '이어하기';
      btnResume.addEventListener('click', () => resumeJob(job.job_id));
      tdActions.appendChild(btnResume);
    } else if (job.status === 'completed') {
      const btnDownload = document.createElement('button');
      btnDownload.className = 'btn-action btn-action-success';
      btnDownload.textContent = '다운로드';
      btnDownload.addEventListener('click', () => downloadJobOutput(job.job_id));
      tdActions.appendChild(btnDownload);
    }

    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });
}

function translateStatus(status) {
  const map = {
    analyzing: '분석 중',
    pending: '대기 중',
    processing: '번역 중',
    completed: '완료',
    failed: '실패',
    paused: '정지'
  };
  return map[status] || status;
}

// Call backend to trigger translation
async function startJobTranslation(jobId, lang) {
  const apiKeys = getStoredKeys();
  if (apiKeys.length === 0) {
    alert('Gemini API 키가 없습니다. 왼쪽 패널에서 API 키를 입력하고 저장해 주세요.');
    return;
  }
  try {
    const res = await fetch(`/api/jobs/${jobId}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_lang: lang, api_keys: apiKeys })
    });
    if (res.ok) {
      fetchJobsList();
    } else {
      const d = await res.json();
      alert(d.error || '에러');
    }
  } catch (err) {
    console.error(err);
  }
}

// Call backend to pause
async function pauseJob(jobId) {
  try {
    const res = await fetch(`/api/jobs/${jobId}/pause`, { method: 'POST' });
    if (res.ok) {
      fetchJobsList();
    }
  } catch (err) {
    console.error(err);
  }
}

// Call backend to resume
async function resumeJob(jobId) {
  const apiKeys = getStoredKeys();
  if (apiKeys.length === 0) {
    alert('Gemini API 키가 없습니다. 왼쪽 패널에서 API 키를 입력하고 저장해 주세요.');
    return;
  }
  try {
    const res = await fetch(`/api/jobs/${jobId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_keys: apiKeys })
    });
    if (res.ok) {
      fetchJobsList();
      openLogs(jobId, '작업');
    }
  } catch (err) {
    console.error(err);
  }
}

// Download output file
function downloadJobOutput(jobId) {
  const a = document.createElement('a');
  a.href = `/api/download/${jobId}`;
  a.click();
}

// Polling handlers for jobs list
function startJobsPolling() {
  fetchJobsList();
  jobsPollInterval = setInterval(fetchJobsList, 2500);
}

function stopJobsPolling() {
  if (jobsPollInterval) {
    clearInterval(jobsPollInterval);
    jobsPollInterval = null;
  }
}

// --- LOG CONSOLE LOGIC ---

function openLogs(jobId, filename) {
  activeJobIdForLogs = jobId;
  document.getElementById('active-log-job-name').textContent = `(${filename})`;
  document.getElementById('logs-panel').classList.remove('hidden');
  
  // Scroll to log panel
  document.getElementById('logs-panel').scrollIntoView({ behavior: 'smooth' });

  // Initial fetch and start log polling
  fetchLogs();
  stopLogsPolling();
  logPollInterval = setInterval(fetchLogs, 1500);
}

async function fetchLogs() {
  if (!activeJobIdForLogs) return;

  try {
    const res = await fetch(`/api/jobs/${activeJobIdForLogs}`);
    if (!res.ok) throw new Error('Failed to fetch job info');
    
    const data = await res.json();
    renderLogsConsole(data.logs);
    
    // If the job is no longer processing/pending, we can stop rapid polling (optionally, but keeping it is fine)
    if (data.job.status !== 'processing' && data.job.status !== 'pending' && data.job.status !== 'analyzing') {
      // Just slow down polling
      stopLogsPolling();
      logPollInterval = setInterval(fetchLogs, 5000);
    }
  } catch (err) {
    console.error(err);
  }
}

function renderLogsConsole(logs) {
  const consoleDiv = document.getElementById('logs-console');
  
  // Remember if user was scrolled to bottom
  const isScrolledToBottom = consoleDiv.scrollHeight - consoleDiv.clientHeight <= consoleDiv.scrollTop + 50;

  consoleDiv.innerHTML = '';
  
  if (!logs || logs.length === 0) {
    consoleDiv.innerHTML = `<div class="log-entry info">작업 로그가 비어 있습니다.</div>`;
    return;
  }

  logs.forEach(log => {
    const logRow = document.createElement('div');
    logRow.className = `log-entry ${log.level}`;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = new Date(log.time).toLocaleTimeString('ko-KR', { hour12: false });

    const msgSpan = document.createElement('span');
    msgSpan.textContent = log.message;

    logRow.appendChild(timeSpan);
    logRow.appendChild(msgSpan);
    consoleDiv.appendChild(logRow);
  });

  // Auto-scroll if they were at bottom
  if (isScrolledToBottom) {
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  }
}

function stopLogsPolling() {
  if (logPollInterval) {
    clearInterval(logPollInterval);
    logPollInterval = null;
  }
}

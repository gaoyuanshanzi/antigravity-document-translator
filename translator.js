const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const cheerio = require('cheerio');
const { dbRun, dbGet, dbAll, logJobMessage } = require('./db');

// Map language codes to display names in prompt
const LANG_MAP = {
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese'
};

// Global map to store abort controllers for active translation loops
const activeJobs = new Map();

/**
 * Text Chunking Function
 * Splitting text by paragraphs, with sentence-level split fallback for giant paragraphs.
 */
function chunkText(text, maxChars = 3000) {
  const paragraphs = text.split(/\r?\n/);
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Handle giant paragraphs
    if (trimmed.length > maxChars) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n\n'));
        currentChunk = [];
        currentLength = 0;
      }

      // Split paragraph by sentences
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let tempChunk = [];
      let tempLength = 0;
      for (const sentence of sentences) {
        if (tempLength + sentence.length > maxChars && tempChunk.length > 0) {
          chunks.push(tempChunk.join(' '));
          tempChunk = [sentence];
          tempLength = sentence.length;
        } else {
          tempChunk.push(sentence);
          tempLength += sentence.length;
        }
      }
      if (tempChunk.length > 0) {
        chunks.push(tempChunk.join(' '));
      }
    } else if (currentLength + trimmed.length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n\n'));
      currentChunk = [trimmed];
      currentLength = trimmed.length;
    } else {
      currentChunk.push(trimmed);
      currentLength += trimmed.length;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n'));
  }

  return chunks;
}

/**
 * HTML Chunking Function
 * Groups top-level block elements from HTML safely to keep elements intact.
 */
function chunkHtml(htmlContent, maxChars = 3000) {
  const $ = cheerio.load(htmlContent);
  
  // Try body, fallback to root elements
  let elements = $('body').children();
  if (elements.length === 0) {
    elements = $.root().children();
  }

  if (elements.length === 0) {
    const bodyText = $.text().trim();
    if (bodyText) {
      return chunkText(bodyText, maxChars).map(txt => `<p>${txt}</p>`);
    }
    return [];
  }

  const chunks = [];
  let currentChunkHtmls = [];
  let currentTextLength = 0;

  elements.each((index, element) => {
    const elHtml = $.html(element);
    const elText = $(element).text().trim();
    const textLen = elText.length;

    if (textLen > maxChars) {
      // Flush current chunk
      if (currentChunkHtmls.length > 0) {
        chunks.push(currentChunkHtmls.join('\n'));
        currentChunkHtmls = [];
        currentTextLength = 0;
      }
      // Split text of giant element and wrap back in same tag type
      const elTextChunks = chunkText(elText, maxChars);
      const tagName = element.name || 'p';
      for (const tc of elTextChunks) {
        chunks.push(`<${tagName}>${tc}</${tagName}>`);
      }
    } else if (currentTextLength + textLen > maxChars && currentChunkHtmls.length > 0) {
      chunks.push(currentChunkHtmls.join('\n'));
      currentChunkHtmls = [elHtml];
      currentTextLength = textLen;
    } else {
      currentChunkHtmls.push(elHtml);
      currentTextLength += textLen;
    }
  });

  if (currentChunkHtmls.length > 0) {
    chunks.push(currentChunkHtmls.join('\n'));
  }

  return chunks;
}

/**
 * Parses and splits a document into the database as pending chunks.
 */
async function prepareDocumentChunks(jobId, filePath, format) {
  let chunks = [];

  if (format === 'txt') {
    const content = fs.readFileSync(filePath, 'utf-8');
    chunks = chunkText(content);
  } else if (format === 'html') {
    const content = fs.readFileSync(filePath, 'utf-8');
    chunks = chunkHtml(content);
  } else if (format === 'docx') {
    // Convert docx to HTML using Mammoth
    const result = await mammoth.convertToHtml({ path: filePath });
    const htmlContent = result.value; // Clean HTML output
    chunks = chunkHtml(htmlContent);
  } else {
    throw new Error(`Unsupported format: ${format}`);
  }

  // Insert chunks into job_chunks table
  for (let i = 0; i < chunks.length; i++) {
    await dbRun(
      'INSERT INTO job_chunks (job_id, chunk_index, original_content, status) VALUES (?, ?, ?, ?)',
      [jobId, i, chunks[i], 'pending']
    );
  }

  // Update total chunks count in job table
  await dbRun(
    'UPDATE translation_jobs SET total_chunks = ?, status = ? WHERE job_id = ?',
    [chunks.length, 'pending', jobId]
  );

  return chunks.length;
}

/**
 * Call Gemini API using native fetch with detailed prompt instructions
 */
async function callGeminiApi(apiKey, prompt, systemInstructions) {
  // Use gemini-2.0-flash as the default model
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemInstructions }] },
      generationConfig: {
        temperature: 0.3
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    const error = new Error(`Gemini API Error: Status ${response.status}`);
    error.status = response.status;
    error.details = errText;
    throw error;
  }

  const resJson = await response.json();
  if (resJson.candidates && resJson.candidates[0] && resJson.candidates[0].content && resJson.candidates[0].content.parts[0]) {
    return resJson.candidates[0].content.parts[0].text;
  } else {
    throw new Error(`Unexpected Gemini response format: ${JSON.stringify(resJson)}`);
  }
}

/**
 * Runs the translation loop for a given job.
 * @param {string} jobId
 * @param {AbortSignal} abortSignal
 * @param {string[]} suppliedKeys - API keys passed directly from the client request
 */
async function runTranslationLoop(jobId, abortSignal, suppliedKeys = []) {
  await logJobMessage(jobId, 'Starting translation background loop.', 'info');
  await dbRun('UPDATE translation_jobs SET status = "processing", updated_at = CURRENT_TIMESTAMP WHERE job_id = ?', [jobId]);

  // Fetch target language
  const job = await dbGet('SELECT * FROM translation_jobs WHERE job_id = ?', [jobId]);
  if (!job) {
    console.error(`Job ${jobId} not found in database.`);
    return;
  }

  const targetLangName = LANG_MAP[job.target_lang] || job.target_lang;
  const isHtmlFormat = job.original_format === 'html' || job.original_format === 'docx';

  // System instructions for Gemini based on format
  let systemInstructions = '';
  if (isHtmlFormat) {
    systemInstructions = `당신은 소설 전문 번역가입니다. 주어진 한국어 소설 본문(HTML 형식)을 ${targetLangName}로 자연스럽게 번역하세요.
반드시 다음 규칙을 지키십시오:
1. HTML 태그(<p>, <strong>, <em>, <a>, <h1>, <li>, <td> 등)의 구조와 속성은 그대로 유지하고 태그 안의 텍스트만 번역하세요.
2. HTML 구조가 깨지거나 누락되지 않도록 주의하십시오.
3. 소설의 문맥(톤앤매너, 인명/지명 등 고유명사 연결성)을 매끄럽게 유지하십시오.
4. 번역된 HTML 본문만 출력하고, 다른 설명이나 마크다운 백틱(\`\`\`html 등)은 절대로 포함하지 마십시오.`;
  } else {
    systemInstructions = `당신은 소설 전문 번역가입니다. 주어진 한국어 소설 본문을 ${targetLangName}로 자연스럽게 번역하세요.
반드시 다음 규칙을 지키십시오:
1. 소설의 문맥(톤앤매너, 인명/지명 등 고유명사 연결성)을 매끄럽게 유지하십시오.
2. 번역된 본문만 출력하고, 다른 설명이나 마크다운 형식 등은 절대로 포함하지 마십시오.`;
  }

  // Fetch pending or failed chunks
  const chunks = await dbAll(
    'SELECT * FROM job_chunks WHERE job_id = ? AND status != "completed" ORDER BY chunk_index ASC',
    [jobId]
  );

  if (chunks.length === 0) {
    await logJobMessage(jobId, 'No pending chunks found. Checking for completion.', 'info');
    await assembleFinalOutput(jobId, job);
    return;
  }

  // Use keys supplied by client; fall back to DB only if none provided (local dev)
  let apiKeys = suppliedKeys.filter(Boolean);
  if (apiKeys.length === 0) {
    apiKeys = (await dbAll('SELECT key_value FROM api_keys WHERE status = "active"')).map(r => r.key_value);
  }
  
  if (apiKeys.length === 0) {
    await logJobMessage(jobId, 'No active Gemini API keys found. Please add a key in the settings panel.', 'error');
    await dbRun('UPDATE translation_jobs SET status = "failed", updated_at = CURRENT_TIMESTAMP WHERE job_id = ?', [jobId]);
    return;
  }

  await logJobMessage(jobId, `Using ${apiKeys.length} API key(s) for translation.`, 'info');

  let keyIndex = 0;

  for (const chunk of chunks) {
    // Check pause/abort request
    if (abortSignal.aborted) {
      await logJobMessage(jobId, 'Translation job paused by user request.', 'info');
      await dbRun('UPDATE translation_jobs SET status = "paused", updated_at = CURRENT_TIMESTAMP WHERE job_id = ?', [jobId]);
      return;
    }

    await logJobMessage(jobId, `Translating chunk ${chunk.chunk_index + 1}/${job.total_chunks}...`, 'info');

    // Context hint: fetch the last completed chunk's translation for terminology consistency
    let contextHint = '';
    if (chunk.chunk_index > 0) {
      const prevChunk = await dbGet(
        'SELECT translated_content FROM job_chunks WHERE job_id = ? AND chunk_index = ? AND status = "completed"',
        [jobId, chunk.chunk_index - 1]
      );
      if (prevChunk && prevChunk.translated_content) {
        // Strip tags for clean text hint
        const rawTextHint = prevChunk.translated_content.replace(/<[^>]*>/g, '').substring(0, 400);
        contextHint = `[이전 번역문 참고 (중요: 번역하지 말고 문맥, 인명, 톤앤매너 연결용으로만 참고할 것)]:\n${rawTextHint}\n====================\n\n`;
      }
    }

    const prompt = `${contextHint}다음 본문을 번역해줘:\n\n${chunk.original_content}`;

    let success = false;
    let retries = 5;
    let delay = 2000; // start with 2s delay

    while (retries > 0 && !success) {
      if (abortSignal.aborted) {
        await logJobMessage(jobId, 'Translation job paused during retry loop.', 'info');
        await dbRun('UPDATE translation_jobs SET status = "paused", updated_at = CURRENT_TIMESTAMP WHERE job_id = ?', [jobId]);
        return;
      }

      // Rotate keys if needed
      if (apiKeys.length === 0) {
        await logJobMessage(jobId, 'All keys exhausted or invalid. Add valid API keys to continue.', 'error');
        await dbRun('UPDATE translation_jobs SET status = "failed", updated_at = CURRENT_TIMESTAMP WHERE job_id = ?', [jobId]);
        return;
      }
      
      const currentApiKey = apiKeys[keyIndex % apiKeys.length];

      try {
        const translatedText = await callGeminiApi(currentApiKey, prompt, systemInstructions);
        
        // Save success status
        await dbRun(
          'UPDATE job_chunks SET translated_content = ?, status = "completed", error_message = NULL WHERE id = ?',
          [translatedText, chunk.id]
        );

        // Update progress counts
        const progress = await dbGet('SELECT COUNT(*) as count FROM job_chunks WHERE job_id = ? AND status = "completed"', [jobId]);
        await dbRun(
          'UPDATE translation_jobs SET completed_chunks = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?',
          [progress.count, jobId]
        );

        await logJobMessage(jobId, `Successfully translated chunk ${chunk.chunk_index + 1}.`, 'info');
        success = true;

        // Intentional API Rate Limiting Delay (3 seconds to protect free tier RPM)
        await sleep(3000);

      } catch (error) {
        console.error(`Error on chunk ${chunk.chunk_index + 1}:`, error.message, error.details || '');

        if (error.status === 429) {
          // Quota limit hit
          await logJobMessage(jobId, `Rate limit (429) hit on API Key index ${keyIndex}. Attempting rotation...`, 'warn');
          
          if (apiKeys.length > 1) {
            // Rotate API key
            keyIndex = (keyIndex + 1) % apiKeys.length;
            await logJobMessage(jobId, `Rotated to next API Key index: ${keyIndex}.`, 'info');
            await sleep(1000); // short pause before retrying with next key
          } else {
            // Exponential backoff if only 1 key or all keys hitting rate limits
            await logJobMessage(jobId, `Rate limit hit. Retrying in ${delay / 1000}s (Exponential Backoff)...`, 'warn');
            await sleep(delay);
            delay *= 2;
            retries--;
          }
        } else if (error.status === 400 || error.status === 403) {
          // Invalid Key / Forbidden
          await logJobMessage(jobId, `API Key index ${keyIndex} is invalid or disabled (Status ${error.status}). Rotating out this key...`, 'error');
          // Remove bad key from current runtime list
          apiKeys.splice(keyIndex % apiKeys.length, 1);
          // Update key in database to let admin know
          await dbRun('UPDATE api_keys SET status = "invalid" WHERE key_value = ?', [currentApiKey]);
          
          if (apiKeys.length > 0) {
            keyIndex = keyIndex % apiKeys.length;
          }
        } else {
          // Network / general error
          await logJobMessage(jobId, `API error occurred: ${error.message}. Retrying in ${delay / 1000}s...`, 'warn');
          await sleep(delay);
          delay *= 2;
          retries--;
        }
      }
    }

    if (!success) {
      await logJobMessage(jobId, `Failed to translate chunk ${chunk.chunk_index + 1} after max retries. Saving error state.`, 'error');
      await dbRun('UPDATE job_chunks SET status = "failed", error_message = "Max retries exceeded" WHERE id = ?', [chunk.id]);
      await dbRun('UPDATE translation_jobs SET status = "failed", updated_at = CURRENT_TIMESTAMP WHERE job_id = ?', [jobId]);
      return;
    }
  }

  // All chunks completed!
  await assembleFinalOutput(jobId, job);
}

/**
 * Assembles all translated chunks into the final HTML file and completes the job.
 */
async function assembleFinalOutput(jobId, job) {
  await logJobMessage(jobId, 'Assembling final translated document...', 'info');

  const allChunks = await dbAll(
    'SELECT * FROM job_chunks WHERE job_id = ? ORDER BY chunk_index ASC',
    [jobId]
  );

  const isHtml = job.original_format === 'html' || job.original_format === 'docx';
  let finalContent = '';

  if (isHtml) {
    // Join HTML elements
    const bodyContent = allChunks.map(c => c.translated_content).join('\n');
    
    // Wrap in standard HTML template with clean styling
    finalContent = `<!DOCTYPE html>
<html lang="${job.target_lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translated - ${job.filename}</title>
    <style>
        body {
            font-family: 'Times New Roman', Times, serif, 'Noto Sans KR', sans-serif;
            line-height: 1.8;
            color: #333;
            max-width: 800px;
            margin: 40px auto;
            padding: 0 20px;
            text-align: justify;
        }
        p {
            margin-bottom: 1.5em;
            text-indent: 1em;
        }
        h1, h2, h3, h4, h5, h6 {
            color: #111;
            margin-top: 1.5em;
            margin-bottom: 0.5em;
            text-align: center;
        }
        ul, ol {
            margin-bottom: 1.5em;
            padding-left: 2em;
        }
        li {
            margin-bottom: 0.5em;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin-bottom: 1.5em;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 8px;
            text-align: left;
        }
        th {
            background-color: #f2f2f2;
        }
    </style>
</head>
<body>
    ${bodyContent}
</body>
</html>`;
  } else {
    // Plain text: wrap paragraphs in paragraphs tags in the HTML template
    const paragraphs = allChunks
      .map(c => c.translated_content)
      .join('\n\n')
      .split(/\r?\n\r?\n/)
      .map(p => `<p>${escapeHtml(p)}</p>`)
      .join('\n');

    finalContent = `<!DOCTYPE html>
<html lang="${job.target_lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translated - ${job.filename}</title>
    <style>
        body {
            font-family: 'Times New Roman', Times, serif, 'Noto Sans KR', sans-serif;
            line-height: 1.8;
            color: #333;
            max-width: 800px;
            margin: 40px auto;
            padding: 0 20px;
            text-align: justify;
        }
        p {
            margin-bottom: 1.5em;
            text-indent: 1em;
        }
    </style>
</head>
<body>
    ${paragraphs}
</body>
</html>`;
  }

  // Create downloads directory if not exists
  const downloadsDir = process.env.VERCEL ? path.join('/tmp', 'downloads') : path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  // Save the file
  const outFileName = `translated_${job.target_lang}_${path.parse(job.filename).name}.html`;
  const outPath = path.join(downloadsDir, outFileName);
  fs.writeFileSync(outPath, finalContent, 'utf-8');

  // Update job record
  await dbRun(
    'UPDATE translation_jobs SET status = "completed", output_filepath = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?',
    [outPath, jobId]
  );

  await logJobMessage(jobId, `🎉 Translation fully completed! File saved to downloads directory.`, 'info');
}

/**
 * Triggers background translation.
 * @param {string} jobId
 * @param {string[]} suppliedKeys - API keys passed from client
 */
function startTranslation(jobId, suppliedKeys = []) {
  // If job is already active, return its abort controller
  if (activeJobs.has(jobId)) {
    return activeJobs.get(jobId);
  }

  const controller = new AbortController();
  activeJobs.set(jobId, controller);

  // Run asynchronously in the background, passing keys directly
  runTranslationLoop(jobId, controller.signal, suppliedKeys)
    .catch(async (err) => {
      console.error(`Unhandled loop crash for job ${jobId}:`, err);
      await logJobMessage(jobId, `Fatal system crash in background worker: ${err.message}`, 'error');
      await dbRun('UPDATE translation_jobs SET status = "failed", updated_at = CURRENT_TIMESTAMP WHERE job_id = ?', [jobId]);
    })
    .finally(() => {
      activeJobs.delete(jobId);
    });

  return controller;
}

/**
 * Aborts an active translation loop.
 */
function pauseTranslation(jobId) {
  const controller = activeJobs.get(jobId);
  if (controller) {
    controller.abort();
    activeJobs.delete(jobId);
    return true;
  }
  return false;
}

// Utility Sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Utility HTML escape
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  prepareDocumentChunks,
  startTranslation,
  pauseTranslation,
  activeJobs
};

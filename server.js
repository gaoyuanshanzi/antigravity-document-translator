const express = require('express');
const session = require('express-session');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { dbRun, dbGet, dbAll, logJobMessage } = require('./db');
const { prepareDocumentChunks, startTranslation, pauseTranslation } = require('./translator');

const app = express();
const PORT = process.env.PORT || 3000;

// Create required directories
const uploadsDir = path.join(__dirname, 'uploads');
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Keep file name clean
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.docx' || ext === '.txt' || ext === '.html') {
    cb(null, true);
  } else {
    cb(new Error('Only MS Word (.docx), Plain Text (.txt), and HTML (.html) files are allowed.'));
  }
};

const upload = multer({ storage, fileFilter });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Setup
app.use(session({
  secret: 'translation-service-super-secret-key-jesus-123',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
}));

// Admin Auth Middleware
const requireAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please login as admin.' });
  }
};

// --- AUTH ROUTES ---

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === '123jesus') {
    req.session.isAdmin = true;
    res.json({ success: true, message: 'Logged in successfully.' });
  } else {
    res.status(400).json({ error: 'Invalid username or password.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout.' });
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  });
});

app.get('/api/status', (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.json({ loggedIn: true });
  } else {
    res.json({ loggedIn: false });
  }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Protect all API endpoints below with admin auth
app.use('/api/keys', requireAdmin);
app.use('/api/upload', requireAdmin);
app.use('/api/jobs', requireAdmin);
app.use('/api/download', requireAdmin);

// --- API KEYS CONFIGURATION ---

app.get('/api/keys', async (req, res) => {
  try {
    const keys = await dbAll('SELECT key_value, status FROM api_keys ORDER BY id ASC');
    res.json({ keys: keys.map(k => ({ value: k.key_value, status: k.status })) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve API keys.' });
  }
});

app.post('/api/keys', async (req, res) => {
  try {
    const { keys } = req.body;
    if (!Array.isArray(keys)) {
      return res.status(400).json({ error: 'Keys must be an array.' });
    }

    // Keep max 5 keys
    const filteredKeys = keys.slice(0, 5).map(k => k.trim()).filter(Boolean);

    // Delete existing and insert new ones
    await dbRun('DELETE FROM api_keys');
    for (const keyVal of filteredKeys) {
      await dbRun('INSERT OR IGNORE INTO api_keys (key_value, status) VALUES (?, ?)', [keyVal, 'active']);
    }

    res.json({ success: true, message: 'API keys updated successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update API keys.' });
  }
});

// --- FILE UPLOAD ---

app.post('/api/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const filename = req.file.originalname;
    const filePath = req.file.path;
    const extension = path.extname(filename).toLowerCase();
    
    let format = '';
    if (extension === '.docx') format = 'docx';
    else if (extension === '.txt') format = 'txt';
    else if (extension === '.html') format = 'html';

    const jobId = uuidv4();

    // Create job entry
    await dbRun(
      'INSERT INTO translation_jobs (job_id, filename, original_format, status) VALUES (?, ?, ?, ?)',
      [jobId, filename, format, 'analyzing']
    );

    await logJobMessage(jobId, `File uploaded: ${filename}. Format: ${format}. Parsing content...`, 'info');

    // Run chunking and prepare chunks in DB
    // We do this synchronously during upload because it's fast, and return the job information.
    const totalChunks = await prepareDocumentChunks(jobId, filePath, format);

    await logJobMessage(jobId, `Document parsing complete. Split into ${totalChunks} chunks. Ready to translate.`, 'info');

    res.json({
      success: true,
      jobId,
      filename,
      format,
      totalChunks
    });

  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: error.message || 'Failed to process file upload.' });
  }
});

// --- TRANSLATION CONTROLS ---

// Start translating a new language
app.post('/api/jobs/:id/translate', async (req, res) => {
  try {
    const { id } = req.params;
    const { target_lang } = req.body; // 'en', 'ja', 'zh'

    if (!['en', 'ja', 'zh'].includes(target_lang)) {
      return res.status(400).json({ error: 'Unsupported target language. Select en, ja, or zh.' });
    }

    const job = await dbGet('SELECT * FROM translation_jobs WHERE job_id = ?', [id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    // Set target language and start
    await dbRun(
      'UPDATE translation_jobs SET target_lang = ?, status = "pending" WHERE job_id = ?',
      [target_lang, id]
    );

    // Trigger translator in background
    startTranslation(id);

    res.json({ success: true, message: `Translation to ${target_lang} started in background.` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start translation.' });
  }
});

// Pause translating
app.post('/api/jobs/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;
    const paused = pauseTranslation(id);
    
    // Fallback: update DB status directly if background worker wasn't running
    if (!paused) {
      await dbRun('UPDATE translation_jobs SET status = "paused" WHERE job_id = ? AND status = "processing"', [id]);
    }
    
    await logJobMessage(id, 'Translation paused by user.', 'info');
    res.json({ success: true, message: 'Translation paused.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to pause translation.' });
  }
});

// Resume translating
app.post('/api/jobs/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;
    const job = await dbGet('SELECT * FROM translation_jobs WHERE job_id = ?', [id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    if (job.status === 'completed') {
      return res.status(400).json({ error: 'Job is already completed.' });
    }

    // Start background thread
    startTranslation(id);

    res.json({ success: true, message: 'Translation resumed.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to resume translation.' });
  }
});

// Get all jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await dbAll('SELECT * FROM translation_jobs ORDER BY created_at DESC');
    res.json({ jobs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve jobs.' });
  }
});

// Get specific job status and logs
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const job = await dbGet('SELECT * FROM translation_jobs WHERE job_id = ?', [id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const logs = await dbAll('SELECT message, level, created_at FROM job_logs WHERE job_id = ? ORDER BY id ASC', [id]);
    res.json({
      job,
      logs: logs.map(l => ({
        message: l.message,
        level: l.level,
        time: l.created_at
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve job details.' });
  }
});

// --- DOWNLOAD TRANSLATED FILE ---

app.get('/api/download/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const job = await dbGet('SELECT * FROM translation_jobs WHERE job_id = ?', [id]);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    if (job.status !== 'completed' || !job.output_filepath) {
      return res.status(400).json({ error: 'Job is not completed yet or file does not exist.' });
    }

    if (!fs.existsSync(job.output_filepath)) {
      return res.status(404).json({ error: 'Output file not found on server disk.' });
    }

    res.download(job.output_filepath, path.basename(job.output_filepath));
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger file download.' });
  }
});

// Fallback error handler for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// Export app for serverless deployment
module.exports = app;

// Start express server only when run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`   Document Translation Service Online         `);
    console.log(`   Local Server: http://localhost:${PORT}      `);
    console.log(`===============================================`);
  });
}

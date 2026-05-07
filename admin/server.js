import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { exec } from 'child_process';
import multer from 'multer';
import crypto from 'crypto';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const BLOG_DIR = join(ROOT, 'src', 'content', 'blog');
const IMAGES_DIR = join(ROOT, 'public', 'images');

// --- Config ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'teletravel2026';
const GH_PAT = process.env.GH_PAT || '';
const GH_REPO = 'botler-BOF/teletravel';
const GH_BRANCH = 'main';
const SA_KEY_FILE = join(__dirname, 'gcp-sa-key.json');

// Stateless HMAC auth
const TOKEN_SECRET = crypto.createHash('sha256').update('myteletravel-blog-' + ADMIN_PASSWORD).digest('hex');

function createToken() {
  const payload = Date.now().toString();
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return sig === expected;
}

// --- In-memory config (loaded from repo files at startup, persisted via GitHub API) ---
let emailsList = [];
let adminConfig = { senderEmail: '' };

// Load from local files (baked into Docker image)
function loadLocalConfig() {
  const emailsFile = join(__dirname, 'emails.json');
  const configFile = join(__dirname, 'config.json');
  if (existsSync(emailsFile)) {
    try { emailsList = JSON.parse(readFileSync(emailsFile, 'utf-8')); } catch {}
  }
  if (existsSync(configFile)) {
    try { adminConfig = JSON.parse(readFileSync(configFile, 'utf-8')); } catch {}
  }
}
loadLocalConfig();

// --- GitHub API helper ---
async function ghApi(method, path, body) {
  if (!GH_PAT) throw new Error('GH_PAT not configured');
  const url = `https://api.github.com/repos/${GH_REPO}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `token ${GH_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'MyTeletravel-Admin',
    },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

// Get file SHA (needed for updates/deletes)
async function getFileSha(filePath) {
  try {
    const data = await ghApi('GET', `/contents/${filePath}?ref=${GH_BRANCH}`);
    return data.sha;
  } catch { return null; }
}

// Create or update file via GitHub API
async function ghPutFile(filePath, content, message) {
  const sha = await getFileSha(filePath);
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;
  return ghApi('PUT', `/contents/${filePath}`, body);
}

// Delete file via GitHub API
async function ghDeleteFile(filePath, message) {
  const sha = await getFileSha(filePath);
  if (!sha) throw new Error('File not found: ' + filePath);
  return ghApi('DELETE', `/contents/${filePath}`, {
    message,
    sha,
    branch: GH_BRANCH,
  });
}

// Persist config to GitHub. Returns { ok, error } so callers can surface
// failures to the user (instead of fire-and-forget which silently dropped
// updates and produced false-positive "success" toasts).
async function persistConfig() {
  try {
    await ghPutFile('admin/emails.json', JSON.stringify(emailsList, null, 2), 'Update notification emails');
    await ghPutFile('admin/config.json', JSON.stringify(adminConfig, null, 2), 'Update admin config');
    return { ok: true };
  } catch (e) {
    console.error('❌ Persist config:', e.message);
    return { ok: false, error: e.message };
  }
}

// GitHub is the source of truth — read fresh state instead of trusting
// any single Cloud Run instance's in-memory copy (which can be stale
// when more than one instance is running).
async function fetchRemoteEmailsList() {
  try {
    const data = await ghApi('GET', `/contents/admin/emails.json?ref=${GH_BRANCH}`);
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    console.error('❌ Fetch emails from GitHub:', e.message);
  }
  return null;
}

async function fetchRemoteAdminConfig() {
  try {
    const data = await ghApi('GET', `/contents/admin/config.json?ref=${GH_BRANCH}`);
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {
    console.error('❌ Fetch config from GitHub:', e.message);
  }
  return null;
}

// --- Email via Gmail API ---
function loadServiceAccountKey() {
  if (process.env.GCP_SA_KEY_B64) {
    try { return JSON.parse(Buffer.from(process.env.GCP_SA_KEY_B64, 'base64').toString()); } catch {}
  }
  if (existsSync(SA_KEY_FILE)) {
    try { return JSON.parse(readFileSync(SA_KEY_FILE, 'utf-8')); } catch {}
  }
  return null;
}

async function sendEmailViaGmail(to, subject, htmlBody) {
  const senderEmail = adminConfig.senderEmail;
  if (!senderEmail) { console.log('⚠️ No sender email configured'); return; }
  const saKey = loadServiceAccountKey();
  if (!saKey) { console.log('⚠️ No service account key'); return; }

  try {
    const auth = new google.auth.JWT({
      email: saKey.client_email,
      key: saKey.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      subject: senderEmail,
    });
    const gmail = google.gmail({ version: 'v1', auth });
    const raw = Buffer.from([
      `From: MyTeletravel Blog <${senderEmail}>`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody,
    ].join('\r\n')).toString('base64url');

    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    console.log(`📧 Email sent to: ${to}`);
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

async function sendNotification(subject, htmlBody) {
  // Always fetch the live recipients list from GitHub. Falls back to
  // in-memory if GitHub is unreachable so we don't lose notifications.
  const remote = await fetchRemoteEmailsList();
  if (remote) emailsList = remote;
  if (emailsList.length === 0) return;
  await sendEmailViaGmail(emailsList.map(e => e.email).join(', '), subject, htmlBody);
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  next();
}

// Login
app.post('/api/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  res.json({ token: createToken() });
});

// Admin UI (no cache)
app.use('/admin', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
}, express.static(join(__dirname, 'public')));

// Blog — force HTML to always revalidate (so deleted/added articles show
// up immediately), but allow assets (CSS/JS/images) to be cached normally.
app.use('/blog', (req, res, next) => {
  if (req.path === '/' || req.path.endsWith('/') || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
}, express.static(join(ROOT, 'dist'), { extensions: ['html'] }));

// Image upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => { mkdirSync(IMAGES_DIR, { recursive: true }); cb(null, IMAGES_DIR); },
  filename: (req, file, cb) => {
    cb(null, file.originalname.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9.\-_]/g, '-').toLowerCase());
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// --- Helpers ---
function toSlug(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function generateMarkdown(data) {
  const faqYaml = data.faq.map(f =>
    `  - question: "${f.question.replace(/"/g, '\\"')}"\n    answer: "${f.answer.replace(/"/g, '\\"')}"`
  ).join('\n');
  const faqSection = data.faq.map(f => `### ${f.question}\n${f.answer}`).join('\n\n');
  const sectionsContent = data.sections.map(s => {
    let c = `## ${s.heading}\n\n${s.content}`;
    if (s.image) c += `\n\n![${s.imageAlt || s.heading}](${s.image})`;
    return c;
  }).join('\n\n');

  return `---
title: "${data.title.replace(/"/g, '\\"')}"
description: "${data.description.replace(/"/g, '\\"')}"
author: "${data.author}"
datePublished: "${data.datePublished}"
image: "${data.image || ''}"
imageAlt: "${data.imageAlt || ''}"
keywords: "${data.keywords}"
faq:
${faqYaml}
---

# ${data.h1}

${data.intro}

${sectionsContent}

Discover our services at [MyTeletravel](https://myteletravel.com).

<section id="faq">

## Frequently asked questions

${faqSection}

</section>
`;
}

// --- Rebuild static site (non-blocking) ---
let isBuilding = false;
function rebuildSite() {
  if (isBuilding) { console.log('⏳ Build already in progress, skipping'); return; }
  isBuilding = true;
  console.log('🔨 Rebuilding static site...');
  exec('npm run build', { cwd: ROOT }, (err, stdout, stderr) => {
    isBuilding = false;
    if (err) {
      console.error('❌ Build failed:', stderr || err.message);
    } else {
      console.log('✅ Site rebuilt successfully');
    }
  });
}

// --- API Routes ---

// List articles (from local filesystem — always up to date in running container)
app.get('/api/articles', requireAuth, (req, res) => {
  if (!existsSync(BLOG_DIR)) return res.json([]);
  const files = readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
  const articles = files.map(file => {
    const content = readFileSync(join(BLOG_DIR, file), 'utf-8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    let title = file.replace('.md', ''), author = '', datePublished = '';
    if (fm) {
      const t = fm[1].match(/title:\s*"(.+?)"/); if (t) title = t[1];
      const a = fm[1].match(/author:\s*"(.+?)"/); if (a) author = a[1];
      const d = fm[1].match(/datePublished:\s*"(.+?)"/); if (d) datePublished = d[1];
    }
    return { slug: file.replace('.md', ''), title, author, datePublished };
  });
  res.json(articles.sort((a, b) => b.datePublished.localeCompare(a.datePublished)));
});

// List images
app.get('/api/images', requireAuth, (req, res) => {
  if (!existsSync(IMAGES_DIR)) return res.json([]);
  const files = readdirSync(IMAGES_DIR).filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));
  res.json(files.map(f => ({ name: f, path: `/images/${f}` })));
});

// DELETE image — removes from local FS and (if present) from GitHub
app.delete('/api/images/:filename', requireAuth, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }

    const filePath = join(IMAGES_DIR, filename);
    if (existsSync(filePath)) unlinkSync(filePath);

    try {
      await ghDeleteFile(`public/images/${filename}`, `Delete image: ${filename}`);
    } catch (e) {
      // Image may have been uploaded but never committed — that's fine.
      console.log(`ℹ️ GitHub delete skipped for ${filename}: ${e.message}`);
    }

    rebuildSite();
    res.json({ success: true, message: `Image "${filename}" deleted.` });
  } catch (err) {
    console.error('❌ Delete image error:', err);
    res.status(500).json({ error: `Error: ${err.message}` });
  }
});

// CREATE article via GitHub API (persists + triggers redeploy)
app.post('/api/articles', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    if (!data.title || !data.description || !data.author || !data.keywords)
      return res.status(400).json({ error: 'Required fields missing.' });
    if (data.description.length > 155)
      return res.status(400).json({ error: 'Description exceeds 155 characters.' });
    if (!data.faq || data.faq.length < 5)
      return res.status(400).json({ error: 'At least 5 FAQ questions required.' });

    const slug = toSlug(data.title);
    data.datePublished = new Date().toISOString().split('T')[0];
    data.h1 = data.h1 || data.title;
    const markdown = generateMarkdown(data);

    // Also write locally so the article list updates immediately
    mkdirSync(BLOG_DIR, { recursive: true });
    writeFileSync(join(BLOG_DIR, `${slug}.md`), markdown, 'utf-8');

    // Commit to GitHub → triggers CI/CD → redeploy
    await ghPutFile(`src/content/blog/${slug}.md`, markdown, `New article: ${data.title}`);

    // Rebuild static site so /blog/ preview is up to date
    rebuildSite();

    // Send notification
    const blogUrl = `https://blog-myteletravel-u5azdc2cvq-ew.a.run.app/blog/${slug}/`;
    sendNotification(
      `🚀 Article published: ${data.title}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">🚀 Article published</h2>
        <p><strong>Title:</strong> ${data.title}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString('en-US')}</p>
        <p><a href="${blogUrl}" style="background:#228be6;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:10px">View article</a></p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin</p>
      </div>`
    ).catch(e => console.error('Email error:', e.message));

    res.json({ success: true, slug, message: `Article "${data.title}" published! Deployment in progress (~2 min).` });
  } catch (err) {
    console.error('❌ Create article error:', err);
    res.status(500).json({ error: `Error: ${err.message}` });
  }
});

// DELETE article via GitHub API (persists + triggers redeploy)
app.delete('/api/articles/:slug', requireAuth, async (req, res) => {
  try {
    const slug = decodeURIComponent(req.params.slug);
    const filePath = join(BLOG_DIR, `${slug}.md`);

    // Read title before deleting
    let title = slug;
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const m = content.match(/title:\s*"(.+?)"/);
      if (m) title = m[1];
      unlinkSync(filePath); // Remove locally for immediate UI update
    }

    // Delete from GitHub → triggers CI/CD → redeploy
    await ghDeleteFile(`src/content/blog/${slug}.md`, `Delete article: ${title}`);

    // Rebuild static site so /blog/ preview is up to date
    rebuildSite();

    // Send notification
    sendNotification(
      `🗑️ Article deleted: ${title}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">🗑️ Article deleted</h2>
        <p><strong>Title:</strong> ${title}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString('en-US')}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin</p>
      </div>`
    ).catch(e => console.error('Email error:', e.message));

    res.json({ success: true, message: `Article "${title}" deleted! Deployment in progress (~2 min).` });
  } catch (err) {
    console.error('❌ Delete article error:', err);
    res.status(500).json({ error: `Error: ${err.message}` });
  }
});

// --- Email management ---
// GET refreshes from GitHub so the UI always reflects the source of truth,
// even when other Cloud Run instances handled previous edits.
app.get('/api/emails', requireAuth, async (req, res) => {
  const remote = await fetchRemoteEmailsList();
  if (remote) emailsList = remote;
  res.json(emailsList);
});

app.post('/api/emails', requireAuth, async (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email.' });

  // Reload latest list from GitHub before mutating to avoid clobbering
  // adds from another instance.
  const remote = await fetchRemoteEmailsList();
  if (remote) emailsList = remote;

  if (emailsList.some(e => e.email === email)) return res.status(400).json({ error: 'Email already added.' });
  const newEntry = { email, name: name || '', addedAt: new Date().toISOString() };
  emailsList.push(newEntry);

  const result = await persistConfig();
  if (!result.ok) {
    emailsList.pop(); // roll back in-memory change so we stay consistent with GitHub
    return res.status(500).json({ error: `Could not save: ${result.error}` });
  }
  res.json({ success: true, emails: emailsList });
});

app.delete('/api/emails/:email', requireAuth, async (req, res) => {
  const target = decodeURIComponent(req.params.email);
  const remote = await fetchRemoteEmailsList();
  if (remote) emailsList = remote;

  const before = emailsList;
  emailsList = emailsList.filter(e => e.email !== target);

  const result = await persistConfig();
  if (!result.ok) {
    emailsList = before; // roll back
    return res.status(500).json({ error: `Could not save: ${result.error}` });
  }
  res.json({ success: true, emails: emailsList });
});

// --- Config management ---
app.get('/api/config', requireAuth, async (req, res) => {
  const saKey = loadServiceAccountKey();
  const remote = await fetchRemoteAdminConfig();
  if (remote) adminConfig = remote;
  res.json({
    senderEmail: adminConfig.senderEmail || '',
    serviceAccountConfigured: !!saKey,
    serviceAccountEmail: saKey?.client_email || '',
    githubConfigured: !!GH_PAT,
  });
});

app.put('/api/config', requireAuth, async (req, res) => {
  // Sync from GitHub first so a sender-email save doesn't overwrite another
  // instance's recipient-list edits when persistConfig writes both files.
  const remoteEmails = await fetchRemoteEmailsList();
  if (remoteEmails) emailsList = remoteEmails;
  const remoteConfig = await fetchRemoteAdminConfig();
  if (remoteConfig) adminConfig = remoteConfig;

  const before = { ...adminConfig };
  if (req.body.senderEmail !== undefined) adminConfig.senderEmail = req.body.senderEmail;

  const result = await persistConfig();
  if (!result.ok) {
    adminConfig = before;
    return res.status(500).json({ error: `Could not save: ${result.error}` });
  }
  res.json({ success: true, config: adminConfig });
});

// Test email
app.post('/api/test-email', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Email address required.' });
  try {
    await sendEmailViaGmail(to, '✅ Test notification — MyTeletravel Blog',
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">✅ Notification test</h2>
        <p>Notifications are working correctly.</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString('en-US')}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin</p>
      </div>`);
    res.json({ success: true, message: 'Test email sent!' });
  } catch (err) {
    res.status(500).json({ error: `Error: ${err.message}` });
  }
});

// Upload images
app.post('/api/upload', requireAuth, upload.array('images', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No images.' });
  res.json({ files: req.files.map(f => ({ name: f.filename, path: `/images/${f.filename}`, size: f.size })) });
});

// Webhook called by CI/CD after deployment (sends email notification)
const WEBHOOK_SECRET = crypto.createHash('sha256').update('webhook-' + ADMIN_PASSWORD).digest('hex');

app.post('/api/webhook/deployed', async (req, res) => {
  const { secret, commitMessage } = req.body || {};
  if (secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Forbidden' });

  // Always pull the latest recipients straight from GitHub so deploy
  // notifications match what the user just configured in the UI.
  const remote = await fetchRemoteEmailsList();
  if (remote) emailsList = remote;

  if (emailsList.length === 0) return res.json({ success: true, message: 'No recipients configured' });

  const isDelete = (commitMessage || '').toLowerCase().includes('suppression') || (commitMessage || '').toLowerCase().includes('delete');
  const emoji = isDelete ? '🗑️' : '🚀';

  try {
    await sendEmailViaGmail(
      emailsList.map(e => e.email).join(', '),
      `${emoji} Blog deployed: ${commitMessage || 'Update'}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">${emoji} Deployment complete</h2>
        <p><strong>Action:</strong> ${commitMessage || 'Blog update'}</p>
        <p><strong>Status:</strong> Live</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString('en-US')}</p>
        <p><a href="https://blog-myteletravel-u5azdc2cvq-ew.a.run.app/blog/" style="background:#228be6;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:10px">View blog</a></p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin — Automatic notification</p>
      </div>`
    );
    res.json({ success: true, message: 'Notification sent' });
  } catch (err) {
    console.error('Webhook email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Root → blog
app.get('/', (req, res) => res.redirect('/blog/'));
app.use('/images', express.static(IMAGES_DIR));

// Catch-all 404 — prevents requests from hanging
app.use((req, res) => {
  res.status(404).send('<!DOCTYPE html><html><head><title>404</title></head><body><h1>Page not found</h1><p><a href="/blog/">Back to blog</a></p></body></html>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ✅ Admin  : http://localhost:${PORT}/admin`);
  console.log(`  📖 Blog   : http://localhost:${PORT}/blog`);
  console.log(`  🔑 Pass   : ${ADMIN_PASSWORD}`);
  console.log(`  📧 Emails : ${emailsList.length} recipient(s)`);
  console.log(`  🐙 GitHub : ${GH_PAT ? 'configured' : '⚠️ GH_PAT missing'}\n`);
});

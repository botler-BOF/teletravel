import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
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
  if (!GH_PAT) throw new Error('GH_PAT non configuré');
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
  if (!sha) throw new Error('Fichier non trouvé: ' + filePath);
  return ghApi('DELETE', `/contents/${filePath}`, {
    message,
    sha,
    branch: GH_BRANCH,
  });
}

// Persist config to GitHub (non-blocking)
function persistConfig() {
  ghPutFile('admin/emails.json', JSON.stringify(emailsList, null, 2), 'Update notification emails')
    .catch(e => console.error('❌ Persist emails:', e.message));
  ghPutFile('admin/config.json', JSON.stringify(adminConfig, null, 2), 'Update admin config')
    .catch(e => console.error('❌ Persist config:', e.message));
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
  if (!senderEmail) { console.log('⚠️ Pas d\'email expéditeur configuré'); return; }
  const saKey = loadServiceAccountKey();
  if (!saKey) { console.log('⚠️ Pas de clé service account'); return; }

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
    console.log(`📧 Email envoyé à : ${to}`);
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

async function sendNotification(subject, htmlBody) {
  if (emailsList.length === 0) return;
  await sendEmailViaGmail(emailsList.map(e => e.email).join(', '), subject, htmlBody);
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'Non autorisé. Connectez-vous.' });
  next();
}

// Login
app.post('/api/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect.' });
  res.json({ token: createToken() });
});

// Admin UI (no cache)
app.use('/admin', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
}, express.static(join(__dirname, 'public')));

// Blog preview
app.use('/blog', express.static(join(ROOT, 'dist')));

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

Découvrez nos services sur [MyTeletravel](https://myteletravel.com).

<section id="faq">

## Questions fréquentes

${faqSection}

</section>
`;
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

// CREATE article via GitHub API (persists + triggers redeploy)
app.post('/api/articles', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    if (!data.title || !data.description || !data.author || !data.keywords)
      return res.status(400).json({ error: 'Champs obligatoires manquants.' });
    if (data.description.length > 155)
      return res.status(400).json({ error: 'Description > 155 caractères.' });
    if (!data.faq || data.faq.length < 5)
      return res.status(400).json({ error: 'Il faut au moins 5 questions FAQ.' });

    const slug = toSlug(data.title);
    data.datePublished = new Date().toISOString().split('T')[0];
    data.h1 = data.h1 || data.title;
    const markdown = generateMarkdown(data);

    // Also write locally so the article list updates immediately
    mkdirSync(BLOG_DIR, { recursive: true });
    writeFileSync(join(BLOG_DIR, `${slug}.md`), markdown, 'utf-8');

    // Commit to GitHub → triggers CI/CD → redeploy
    await ghPutFile(`src/content/blog/${slug}.md`, markdown, `Nouvel article : ${data.title}`);

    // Send notification
    const blogUrl = `https://blog-myteletravel-u5azdc2cvq-ew.a.run.app/blog/${slug}/`;
    sendNotification(
      `🚀 Article publié : ${data.title}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">🚀 Article publié</h2>
        <p><strong>Titre :</strong> ${data.title}</p>
        <p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
        <p><a href="${blogUrl}" style="background:#228be6;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:10px">Voir l'article</a></p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin</p>
      </div>`
    ).catch(e => console.error('Email error:', e.message));

    res.json({ success: true, slug, message: `Article "${data.title}" publié ! Déploiement en cours (~2 min).` });
  } catch (err) {
    console.error('❌ Create article error:', err);
    res.status(500).json({ error: `Erreur : ${err.message}` });
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
    await ghDeleteFile(`src/content/blog/${slug}.md`, `Suppression article : ${title}`);

    // Send notification
    sendNotification(
      `🗑️ Article supprimé : ${title}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">🗑️ Article supprimé</h2>
        <p><strong>Titre :</strong> ${title}</p>
        <p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin</p>
      </div>`
    ).catch(e => console.error('Email error:', e.message));

    res.json({ success: true, message: `Article "${title}" supprimé ! Déploiement en cours (~2 min).` });
  } catch (err) {
    console.error('❌ Delete article error:', err);
    res.status(500).json({ error: `Erreur : ${err.message}` });
  }
});

// --- Email management ---
app.get('/api/emails', requireAuth, (req, res) => res.json(emailsList));

app.post('/api/emails', requireAuth, (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalide.' });
  if (emailsList.some(e => e.email === email)) return res.status(400).json({ error: 'Email déjà ajouté.' });
  emailsList.push({ email, name: name || '', addedAt: new Date().toISOString() });
  persistConfig();
  res.json({ success: true, emails: emailsList });
});

app.delete('/api/emails/:email', requireAuth, (req, res) => {
  emailsList = emailsList.filter(e => e.email !== decodeURIComponent(req.params.email));
  persistConfig();
  res.json({ success: true, emails: emailsList });
});

// --- Config management ---
app.get('/api/config', requireAuth, (req, res) => {
  const saKey = loadServiceAccountKey();
  res.json({
    senderEmail: adminConfig.senderEmail || '',
    serviceAccountConfigured: !!saKey,
    serviceAccountEmail: saKey?.client_email || '',
    githubConfigured: !!GH_PAT,
  });
});

app.put('/api/config', requireAuth, (req, res) => {
  if (req.body.senderEmail !== undefined) adminConfig.senderEmail = req.body.senderEmail;
  persistConfig();
  res.json({ success: true, config: adminConfig });
});

// Test email
app.post('/api/test-email', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Adresse email requise.' });
  try {
    await sendEmailViaGmail(to, '✅ Test notification MyTeletravel Blog',
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">✅ Test de notification</h2>
        <p>Les notifications fonctionnent correctement.</p>
        <p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin</p>
      </div>`);
    res.json({ success: true, message: 'Email de test envoyé !' });
  } catch (err) {
    res.status(500).json({ error: `Erreur : ${err.message}` });
  }
});

// Upload images
app.post('/api/upload', requireAuth, upload.array('images', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Aucune image.' });
  res.json({ files: req.files.map(f => ({ name: f.filename, path: `/images/${f.filename}`, size: f.size })) });
});

// Webhook called by CI/CD after deployment (sends email notification)
const WEBHOOK_SECRET = crypto.createHash('sha256').update('webhook-' + ADMIN_PASSWORD).digest('hex');

app.post('/api/webhook/deployed', async (req, res) => {
  const { secret, commitMessage } = req.body || {};
  if (secret !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Forbidden' });

  if (emailsList.length === 0) return res.json({ success: true, message: 'No recipients configured' });

  const isDelete = (commitMessage || '').toLowerCase().includes('suppression');
  const emoji = isDelete ? '🗑️' : '🚀';
  const action = isDelete ? 'supprimé' : 'publié / mis à jour';

  try {
    await sendEmailViaGmail(
      emailsList.map(e => e.email).join(', '),
      `${emoji} Blog déployé : ${commitMessage || 'Mise à jour'}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">${emoji} Déploiement terminé</h2>
        <p><strong>Action :</strong> ${commitMessage || 'Mise à jour du blog'}</p>
        <p><strong>Statut :</strong> En ligne</p>
        <p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
        <p><a href="https://blog-myteletravel-u5azdc2cvq-ew.a.run.app/blog/" style="background:#228be6;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:10px">Voir le blog</a></p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin — Notification automatique</p>
      </div>`
    );
    res.json({ success: true, message: 'Notification envoyée' });
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
  res.status(404).send('<!DOCTYPE html><html><head><title>404</title></head><body><h1>Page non trouvée</h1><p><a href="/blog/">Retour au blog</a></p></body></html>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ✅ Admin  : http://localhost:${PORT}/admin`);
  console.log(`  📖 Blog   : http://localhost:${PORT}/blog`);
  console.log(`  🔑 Pass   : ${ADMIN_PASSWORD}`);
  console.log(`  📧 Emails : ${emailsList.length} destinataire(s)`);
  console.log(`  🐙 GitHub : ${GH_PAT ? 'configuré' : '⚠️ GH_PAT manquant'}\n`);
});

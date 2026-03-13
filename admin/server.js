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
const EMAILS_FILE = join(__dirname, 'emails.json');
const CONFIG_FILE = join(__dirname, 'config.json');
const SA_KEY_FILE = join(__dirname, 'gcp-sa-key.json');

// --- Auth config ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'teletravel2026';
const sessions = new Map();

// --- Deploy status tracking ---
let deployStatus = { status: 'idle', message: '', lastUpdated: null };

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Auth middleware ---
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Non autorisé. Connectez-vous.' });
  }
  next();
}

// --- Config helpers ---
function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { senderEmail: '' };
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); }
  catch { return { senderEmail: '' }; }
}

function saveConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// --- Email helpers ---
function loadEmails() {
  if (!existsSync(EMAILS_FILE)) return [];
  try { return JSON.parse(readFileSync(EMAILS_FILE, 'utf-8')); }
  catch { return []; }
}

function saveEmails(emails) {
  writeFileSync(EMAILS_FILE, JSON.stringify(emails, null, 2), 'utf-8');
}

// Load service account key
function loadServiceAccountKey() {
  // Priority: env var (base64 JSON) > env var (raw JSON) > file
  if (process.env.GCP_SA_KEY_B64) {
    try { return JSON.parse(Buffer.from(process.env.GCP_SA_KEY_B64, 'base64').toString()); }
    catch { console.error('❌ GCP_SA_KEY_B64 invalide'); }
  }
  if (process.env.GCP_SA_KEY_JSON) {
    try { return JSON.parse(process.env.GCP_SA_KEY_JSON); }
    catch { console.error('❌ GCP_SA_KEY_JSON invalide'); }
  }
  if (existsSync(SA_KEY_FILE)) {
    try { return JSON.parse(readFileSync(SA_KEY_FILE, 'utf-8')); }
    catch { console.error('❌ gcp-sa-key.json invalide'); }
  }
  return null;
}

// Send email via Gmail API with service account impersonation
async function sendEmailViaGmail(to, subject, htmlBody) {
  const config = loadConfig();
  const senderEmail = config.senderEmail;
  if (!senderEmail) {
    console.log('⚠️  Pas d\'email expéditeur configuré — notification ignorée');
    return;
  }

  const saKey = loadServiceAccountKey();
  if (!saKey) {
    console.log('⚠️  Pas de clé service account — notification ignorée');
    return;
  }

  try {
    const auth = new google.auth.JWT({
      email: saKey.client_email,
      key: saKey.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      subject: senderEmail, // impersonate this user
    });

    const gmail = google.gmail({ version: 'v1', auth });

    // Build RFC 2822 message
    const messageParts = [
      `From: MyTeletravel Blog <${senderEmail}>`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody,
    ];
    const rawMessage = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage).toString('base64url');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });

    console.log(`📧 Email envoyé via Gmail API à : ${to}`);
  } catch (err) {
    console.error('❌ Erreur envoi Gmail API :', err.message);
    // Log more details for debugging
    if (err.response?.data) {
      console.error('   Détails :', JSON.stringify(err.response.data));
    }
  }
}

async function sendNotification(subject, htmlBody) {
  const emails = loadEmails();
  if (emails.length === 0) return;

  const toList = emails.map(e => e.email).join(', ');
  await sendEmailViaGmail(toList, subject, htmlBody);
}

// --- Async build + deploy helper ---
function runBuildAndDeploy(action, title, slug) {
  deployStatus = { status: 'building', message: `Build en cours (${action})...`, lastUpdated: Date.now() };

  exec('npm run build', { cwd: ROOT, timeout: 120000 }, (buildErr) => {
    if (buildErr) {
      deployStatus = { status: 'error', message: `Erreur build : ${buildErr.message}`, lastUpdated: Date.now() };
      return;
    }

    deployStatus = { status: 'pushing', message: 'Build OK. Git push en cours...', lastUpdated: Date.now() };

    const commitMsg = action === 'create'
      ? `Nouvel article : ${title}`
      : `Suppression article : ${slug}`;

    exec(`git add -A && git commit -m "${commitMsg}" && git push origin main`, { cwd: ROOT, timeout: 60000 }, async (gitErr) => {
      if (gitErr) {
        deployStatus = { status: 'done', message: 'Build OK. Git push échoué (non bloquant).', lastUpdated: Date.now() };
      } else {
        deployStatus = { status: 'done', message: 'Build + déploiement terminé !', lastUpdated: Date.now() };
      }

      // Send email notification
      const blogUrl = `https://blog-myteletravel-u5azdc2cvq-ew.a.run.app/blog/${slug}/`;
      const emoji = action === 'create' ? '🚀' : '🗑️';
      const actionLabel = action === 'create' ? 'publié' : 'supprimé';

      await sendNotification(
        `${emoji} Blog ${actionLabel} : ${title}`,
        `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#0f0f23">${emoji} Article ${actionLabel}</h2>
          <p><strong>Titre :</strong> ${title}</p>
          <p><strong>Slug :</strong> ${slug}</p>
          <p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
          ${action === 'create' ? `<p><a href="${blogUrl}" style="background:#228be6;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:10px">Voir l'article</a></p>` : ''}
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="color:#888;font-size:12px">MyTeletravel Blog Admin</p>
        </div>`
      );
    });
  });
}

// Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  res.json({ token });
});

// Serve admin UI
app.use('/admin', express.static(join(__dirname, 'public')));

// Serve built blog for preview
app.use('/blog', express.static(join(ROOT, 'dist')));

// Upload images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    mkdirSync(IMAGES_DIR, { recursive: true });
    cb(null, IMAGES_DIR);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9.\-_]/g, '-')
      .toLowerCase();
    cb(null, safeName);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// --- Helpers ---
function toSlug(text) {
  return text
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateMarkdown(data) {
  const faqYaml = data.faq.map(f =>
    `  - question: "${f.question.replace(/"/g, '\\"')}"\n    answer: "${f.answer.replace(/"/g, '\\"')}"`
  ).join('\n');

  const faqSection = data.faq.map(f =>
    `### ${f.question}\n${f.answer}`
  ).join('\n\n');

  let sectionsContent = data.sections.map(s => {
    let content = `## ${s.heading}\n\n${s.content}`;
    if (s.image) {
      content += `\n\n![${s.imageAlt || s.heading}](${s.image})`;
    }
    return content;
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

// Deploy status
app.get('/api/deploy-status', requireAuth, (req, res) => {
  res.json(deployStatus);
});

// List all articles
app.get('/api/articles', requireAuth, (req, res) => {
  if (!existsSync(BLOG_DIR)) return res.json([]);
  const files = readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
  const articles = files.map(file => {
    const content = readFileSync(join(BLOG_DIR, file), 'utf-8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    let title = file.replace('.md', '');
    let author = '';
    let datePublished = '';
    if (frontmatter) {
      const titleMatch = frontmatter[1].match(/title:\s*"(.+?)"/);
      const authorMatch = frontmatter[1].match(/author:\s*"(.+?)"/);
      const dateMatch = frontmatter[1].match(/datePublished:\s*"(.+?)"/);
      if (titleMatch) title = titleMatch[1];
      if (authorMatch) author = authorMatch[1];
      if (dateMatch) datePublished = dateMatch[1];
    }
    return { slug: file.replace('.md', ''), title, author, datePublished, file };
  });
  res.json(articles.sort((a, b) => b.datePublished.localeCompare(a.datePublished)));
});

// List uploaded images
app.get('/api/images', requireAuth, (req, res) => {
  if (!existsSync(IMAGES_DIR)) return res.json([]);
  const files = readdirSync(IMAGES_DIR).filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));
  res.json(files.map(f => ({ name: f, path: `/images/${f}` })));
});

// --- Email management ---
app.get('/api/emails', requireAuth, (req, res) => {
  res.json(loadEmails());
});

app.post('/api/emails', requireAuth, (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email invalide.' });
  }
  const emails = loadEmails();
  if (emails.some(e => e.email === email)) {
    return res.status(400).json({ error: 'Cet email existe déjà.' });
  }
  emails.push({ email, name: name || '', addedAt: new Date().toISOString() });
  saveEmails(emails);
  res.json({ success: true, emails });
});

app.delete('/api/emails/:email', requireAuth, (req, res) => {
  const emails = loadEmails().filter(e => e.email !== decodeURIComponent(req.params.email));
  saveEmails(emails);
  res.json({ success: true, emails });
});

// --- Config management ---
app.get('/api/config', requireAuth, (req, res) => {
  const config = loadConfig();
  const saKey = loadServiceAccountKey();
  res.json({
    senderEmail: config.senderEmail || '',
    serviceAccountConfigured: !!saKey,
    serviceAccountEmail: saKey?.client_email || '',
  });
});

app.put('/api/config', requireAuth, (req, res) => {
  const config = loadConfig();
  if (req.body.senderEmail !== undefined) config.senderEmail = req.body.senderEmail;
  saveConfig(config);
  res.json({ success: true, config });
});

// Test email
app.post('/api/test-email', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Adresse email requise.' });
  try {
    await sendEmailViaGmail(
      to,
      '✅ Test notification MyTeletravel Blog',
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0f0f23">✅ Test de notification</h2>
        <p>Si vous recevez cet email, les notifications du blog MyTeletravel fonctionnent correctement.</p>
        <p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#888;font-size:12px">MyTeletravel Blog Admin</p>
      </div>`
    );
    res.json({ success: true, message: 'Email de test envoyé !' });
  } catch (err) {
    res.status(500).json({ error: `Erreur : ${err.message}` });
  }
});

// Create/publish article — ASYNC
app.post('/api/articles', requireAuth, (req, res) => {
  try {
    const data = req.body;
    if (!data.title || !data.description || !data.author || !data.keywords) {
      return res.status(400).json({ error: 'Champs obligatoires manquants.' });
    }
    if (data.description.length > 155) {
      return res.status(400).json({ error: 'La description ne doit pas dépasser 155 caractères.' });
    }
    if (!data.faq || data.faq.length < 5) {
      return res.status(400).json({ error: 'Il faut au moins 5 questions FAQ.' });
    }

    const slug = toSlug(data.title);
    const today = new Date().toISOString().split('T')[0];
    data.datePublished = today;
    data.h1 = data.h1 || data.title;

    const markdown = generateMarkdown(data);
    mkdirSync(BLOG_DIR, { recursive: true });
    writeFileSync(join(BLOG_DIR, `${slug}.md`), markdown, 'utf-8');

    // Build + deploy in background (non-blocking)
    runBuildAndDeploy('create', data.title, slug);

    res.json({ success: true, slug, message: `Article "${data.title}" enregistré ! Build en cours...` });
  } catch (err) {
    res.status(500).json({ error: `Erreur lors de la publication : ${err.message}` });
  }
});

// Delete article — ASYNC
app.delete('/api/articles/:slug', requireAuth, (req, res) => {
  try {
    const slug = decodeURIComponent(req.params.slug);
    const filePath = join(BLOG_DIR, `${slug}.md`);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'Article non trouvé.' });
    }

    const content = readFileSync(filePath, 'utf-8');
    const titleMatch = content.match(/title:\s*"(.+?)"/);
    const title = titleMatch ? titleMatch[1] : slug;

    unlinkSync(filePath);

    runBuildAndDeploy('delete', title, slug);

    res.json({ success: true, message: 'Article supprimé ! Build en cours...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload multiple images
app.post('/api/upload', requireAuth, upload.array('images', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Aucune image envoyée.' });
  }
  const uploaded = req.files.map(f => ({
    name: f.filename,
    path: `/images/${f.filename}`,
    size: f.size,
  }));
  res.json({ files: uploaded });
});

// Redirect root to blog
app.get('/', (req, res) => res.redirect('/blog/'));

// Serve images
app.use('/images', express.static(IMAGES_DIR));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const saKey = loadServiceAccountKey();
  console.log(`\n  ✅ Interface admin : http://localhost:${PORT}/admin`);
  console.log(`  📖 Blog preview   : http://localhost:${PORT}/blog`);
  console.log(`  🔑 Mot de passe   : ${ADMIN_PASSWORD}`);
  console.log(`  📧 Service Account: ${saKey ? saKey.client_email : '(non configuré)'}\n`);
});

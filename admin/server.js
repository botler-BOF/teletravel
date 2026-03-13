import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import multer from 'multer';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const BLOG_DIR = join(ROOT, 'src', 'content', 'blog');
const IMAGES_DIR = join(ROOT, 'public', 'images');

// --- Auth config ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'teletravel2026';
const sessions = new Map();

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

// Serve admin UI (no auth needed for static files)
app.use('/admin', express.static(join(__dirname, 'public')));

// Serve built blog for preview
app.use('/blog', express.static(join(ROOT, 'dist')));

// Upload images — multi-file
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

  // Insert images in sections
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

// Create/publish article
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

    // Build
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });

    // Git push
    try {
      execSync(`git add -A && git commit -m "Nouvel article : ${data.title}" && git push origin main`, {
        cwd: ROOT, stdio: 'pipe', timeout: 30000,
      });
    } catch (gitErr) {
      // Build succeeded, git push is optional (might not be configured)
    }

    res.json({ success: true, slug, message: `Article "${data.title}" publié avec succès !` });
  } catch (err) {
    res.status(500).json({ error: `Erreur lors de la publication : ${err.message}` });
  }
});

// Delete article
app.delete('/api/articles/:slug', requireAuth, (req, res) => {
  try {
    const filePath = join(BLOG_DIR, `${req.params.slug}.md`);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'Article non trouvé.' });
    }
    unlinkSync(filePath);
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });

    try {
      execSync(`git add -A && git commit -m "Suppression article : ${req.params.slug}" && git push origin main`, {
        cwd: ROOT, stdio: 'pipe', timeout: 30000,
      });
    } catch (gitErr) {}

    res.json({ success: true, message: 'Article supprimé.' });
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

// Serve images directly for blog preview
app.use('/images', express.static(IMAGES_DIR));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ✅ Interface admin : http://localhost:${PORT}/admin`);
  console.log(`  📖 Blog preview   : http://localhost:${PORT}/blog`);
  console.log(`  🔑 Mot de passe   : ${ADMIN_PASSWORD}\n`);
});

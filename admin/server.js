import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const BLOG_DIR = join(ROOT, 'src', 'content', 'blog');
const IMAGES_DIR = join(ROOT, 'public', 'images');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
const upload = multer({ storage });

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
    `  - question: "${f.question}"\n    answer: "${f.answer}"`
  ).join('\n');

  const faqSection = data.faq.map(f =>
    `### ${f.question}\n${f.answer}`
  ).join('\n\n');

  return `---
title: "${data.title}"
description: "${data.description}"
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

${data.sections.map(s => `## ${s.heading}\n\n${s.content}`).join('\n\n')}

Découvrez nos services sur [MyTeletravel](https://myteletravel.com).

<section id="faq">

## Questions fréquentes

${faqSection}

</section>
`;
}

// --- API Routes ---

// List all articles
app.get('/api/articles', (req, res) => {
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

// Create/publish article
app.post('/api/articles', (req, res) => {
  try {
    const data = req.body;

    // Validate
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

    res.json({ success: true, slug, message: `Article "${data.title}" publié avec succès !` });
  } catch (err) {
    res.status(500).json({ error: `Erreur lors de la publication : ${err.message}` });
  }
});

// Delete article
app.delete('/api/articles/:slug', (req, res) => {
  try {
    const filePath = join(BLOG_DIR, `${req.params.slug}.md`);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'Article non trouvé.' });
    }
    unlinkSync(filePath);
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
    res.json({ success: true, message: 'Article supprimé.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload image
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucune image envoyée.' });
  res.json({ path: `/images/${req.file.filename}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ✅ Interface admin : http://localhost:${PORT}/admin`);
  console.log(`  📖 Blog preview   : http://localhost:${PORT}/blog\n`);
});

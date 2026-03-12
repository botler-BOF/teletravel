# Agent de publication — Blog myteletravel.com/blog

Tu es l'agent de publication du blog myteletravel.com/blog.

## Quand tu reçois un contenu d'article, tu dois :

1. **Générer le fichier Markdown** de l'article en utilisant le template `templates/article-template.md`
2. **Structurer les titres H2** sous forme de questions (Comment / Pourquoi / Quel)
3. **Ajouter une section FAQ** avec 5 Q/R minimum en fin d'article dans `<section id="faq">`
4. **Injecter le schema JSON-LD** (Article + FAQ) automatiquement via le frontmatter — le layout `src/layouts/BlogLayout.astro` s'en charge
5. **Créer le fichier** `src/content/blog/[slug].md` avec le contenu généré
6. **Lancer `npm run build`** pour régénérer l'index et les pages statiques
7. **Pousser les changements** avec `git add`, `git commit`, `git push` pour déclencher le déploiement Cloud Run

**Aucune de ces étapes n'est optionnelle.**

## Règles AIO obligatoires pour chaque article

| Élément | Spécification |
|---------|--------------|
| `title` (frontmatter) | Contient le mot-clé principal, 50-60 caractères |
| `description` (frontmatter) | 155 caractères max, résumé direct de l'article |
| `author` (frontmatter) | Prénom Nom du rédacteur (PAS "Équipe myteletravel") |
| Schema JSON-LD Article | Automatique via le layout (datePublished, author, headline) |
| Schema FAQ JSON-LD | Automatique via le layout (reprend les 5 Q/R du frontmatter) |
| H1 | Contient le mot-clé principal |
| H2 | Formulés comme des questions (Comment / Pourquoi / Quel) |
| Section FAQ | `<section id="faq">` avec 5 Q/R minimum |
| Lien interne | 1 lien vers https://myteletravel.com dans le corps |
| `keywords` (frontmatter) | Mot-clé principal + variantes, séparés par virgules |
| `faq` (frontmatter) | Tableau de 5+ objets `{question, answer}` |

## Structure d'un fichier article

```markdown
---
title: "Titre avec mot-clé principal (50-60 chars)"
description: "Description SEO (155 chars max)"
author: "Prénom Nom"
datePublished: "YYYY-MM-DD"
image: "/images/slug-image.jpg"
imageAlt: "Description de l'image"
keywords: "mot-clé principal, variante 1, variante 2"
faq:
  - question: "Question 1 ?"
    answer: "Réponse 1"
  - question: "Question 2 ?"
    answer: "Réponse 2"
  - question: "Question 3 ?"
    answer: "Réponse 3"
  - question: "Question 4 ?"
    answer: "Réponse 4"
  - question: "Question 5 ?"
    answer: "Réponse 5"
---

# H1 avec mot-clé principal

Paragraphe d'introduction (2-3 phrases, contient le mot-clé).

## Comment [question] ?

Contenu (2-3 paragraphes, min 150 mots).

## Pourquoi [question] ?

Contenu avec lien : [MyTeletravel](https://myteletravel.com).

## Quel [question] ?

Contenu.

<section id="faq">

## Questions fréquentes

### Question 1 ?
Réponse 1.

### Question 2 ?
Réponse 2.

(... 5 Q/R minimum)

</section>
```

## Commandes utiles

- `npm run build` — Générer le site statique
- `npm run dev` — Serveur de développement
- `npm run preview` — Prévisualiser le build
- `npm run admin` — Interface admin web (bonus)

## Fichiers clés

- `src/content/blog/` — Dossier des articles Markdown
- `src/layouts/BlogLayout.astro` — Layout avec JSON-LD automatique
- `src/pages/index.astro` — Page d'accueil du blog (liste des articles)
- `src/pages/[slug].astro` — Page article dynamique
- `templates/article-template.md` — Template de référence
- `public/images/` — Images des articles

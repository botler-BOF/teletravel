import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string().max(155),
    author: z.string(),
    datePublished: z.string(),
    dateModified: z.string().optional(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    keywords: z.string(),
    faq: z.array(z.object({
      question: z.string(),
      answer: z.string(),
    })).min(5),
  }),
});

export const collections = { blog };

---
title: "Cache Test Article"
description: "Verifying delete flow end to end"
author: "Test User"
datePublished: "2026-05-07"
image: ""
imageAlt: ""
keywords: "test,cache,delete"
faq:
  - question: "What is this article for?"
    answer: "To verify the create/delete pipeline works end-to-end."
  - question: "Will it stay published?"
    answer: "No, it is deleted right after the publication is confirmed."
  - question: "Does it trigger a real deploy?"
    answer: "Yes, because the admin commits to GitHub which triggers Cloud Run."
  - question: "How long does the cycle take?"
    answer: "About 4 minutes total � 2 minutes for create, 2 for delete."
  - question: "Will it leave any trace?"
    answer: "Only the create + delete commits in git history, no live content."
---

# Cache Test Article

This article verifies the create and delete pipeline works correctly.

## How does this test work?

It posts a fake article via the admin API, waits for the deploy, then deletes it and verifies removal.

## Why test the cache?

Because the user reported that deleted articles still appeared on the public blog due to stale browser/CDN cache.

## What is the expected outcome?

After a successful delete + redeploy, the article should be gone from both the article list and any direct URL.

Discover our services at [MyTeletravel](https://myteletravel.com).

<section id="faq">

## Frequently asked questions

### What is this article for?
To verify the create/delete pipeline works end-to-end.

### Will it stay published?
No, it is deleted right after the publication is confirmed.

### Does it trigger a real deploy?
Yes, because the admin commits to GitHub which triggers Cloud Run.

### How long does the cycle take?
About 4 minutes total � 2 minutes for create, 2 for delete.

### Will it leave any trace?
Only the create + delete commits in git history, no live content.

</section>

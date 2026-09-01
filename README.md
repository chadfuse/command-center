# Auto-Poster

A Cloudflare Worker that automatically generates AI-written blog posts and publishes them to WordPress, LinkedIn, Facebook, and Instagram. It runs on a schedule, manages a queue of unique topics from RSS feeds, and emails a summary of each run.

## What it does

- Generates 1000+ word SEO-optimized WordPress blog posts with featured images.
- Publishes long-form blog posts twice per week on Mondays and Thursdays.
- Publishes shorter social posts twice per day to LinkedIn, Facebook, and Instagram.
- Pulls fresh topics from RSS feeds and stores used topics in Cloudflare KV to avoid duplicates.
- Sends email notifications via Resend for every successful or failed run.
- Uploads images to LinkedIn and uses Unsplash + Pollinations for featured images.

## Architecture

- `src/index.js` — main Cloudflare Worker (export with `fetch` and `scheduled` handlers).
- `wrangler.toml` — Cloudflare configuration, cron triggers, variables, and KV namespace.
- `.dev.vars` — local secrets (not committed).
- Google Gemini (`gemini-2.5-flash`) — SEO-optimized text & social post generation.
- Google Imagen 3 (`imagen-3.0-generate-002`) & Cloudflare Workers AI — featured image generation.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account
- Google AI Studio API key (free at [aistudio.google.com](https://aistudio.google.com))
- WordPress site with Application Passwords enabled
- Facebook app and Page with permissions
- Resend account (for email notifications)
- Unsplash API key (optional, for stock photos)

## Installation

1. Clone the repo:

   ```bash
   git clone https://github.com/chadfuse/command-center.git
   cd command-center
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy the example environment file:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

## Configuration

### 1. AI Generation (Google Gemini & Imagen 3)

Set your Google AI Studio API key as a Wrangler secret:

```bash
npx wrangler secret put GOOGLE_API_KEY
```

The default models and endpoints in `wrangler.toml`:

```toml
TEXT_API_URL = "https://generativelanguage.googleapis.com/v1beta/models"
TEXT_MODEL = "gemini-2.5-flash"
FALLBACK_TEXT_MODEL = "gemini-2.0-flash"
IMAGE_MODEL = "imagen-3.0-generate-002"
FALLBACK_IMAGE_MODEL = "imagen-3.0-fast-generate-001"
```

You can override them by editing `wrangler.toml` or setting them in `.dev.vars`.

The Worker tries the primary Gemini model (`gemini-2.5-flash`), then fallback models (`gemini-2.0-flash`), and then Cloudflare Workers AI.
For images, it tries **Google Imagen 3**, then falls back to **Cloudflare Workers AI (Flux 1 Schnell)**, then **Unsplash**.

### 2. WordPress

Set the site URL and username as public variables:

```bash
npx wrangler secret put WP_URL       # e.g. https://chadsia.com
npx wrangler secret put WP_USERNAME  # e.g. chad
npx wrangler secret put WP_APP_PASSWORD
```

The app password is the 20-character code from **WordPress Users → Profile → Application Passwords**.

For scheduled posts, the Worker publishes automatically (`publish` status). Manual posts use `WP_STATUS` which defaults to `draft` unless you override it.

### 3. Social platform tokens

#### LinkedIn

```bash
npx wrangler secret put LINKEDIN_ACCESS_TOKEN
```

The token needs `w_member_social` and `r_basicprofile` / `openid` scope.

#### Facebook / Instagram

Facebook and Instagram use the same Page token. Because Graph API Explorer tokens expire quickly, the Worker includes a helper endpoint to generate a long-lived Page token.

Call the helper with your Facebook App ID, App Secret, short-lived User token, and Page ID:

```bash
curl -X POST https://auto-poster.chadfuse.workers.dev/refresh-facebook-token \
  -H 'content-type: application/json' \
  -d '{
    "clientId": "YOUR_APP_ID",
    "clientSecret": "YOUR_APP_SECRET",
    "shortLivedToken": "YOUR_SHORT_LIVED_USER_TOKEN",
    "pageId": "YOUR_PAGE_ID"
  }'
```

Then set the returned `access_token` for both:

```bash
npx wrangler secret put FACEBOOK_ACCESS_TOKEN
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
n```

Set the Page and account IDs as public variables in `wrangler.toml` or secrets:

```toml
[vars]
FACEBOOK_PAGE_ID = "YOUR_PAGE_ID"
INSTAGRAM_ACCOUNT_ID = "YOUR_IG_BUSINESS_ACCOUNT_ID"
```

### 4. Resend email notifications

```bash
npx wrangler secret put RESEND_API_KEY
```

In `wrangler.toml`, set:

```toml
NOTIFICATION_EMAIL = "you@example.com"
FROM_EMAIL = "hello@yourdomain.com"
```

You must verify the `FROM_EMAIL` domain at https://resend.com/domains before emails can be sent to third-party addresses.

### 5. Images (Google Imagen, Cloudflare Flux & Unsplash)

Featured images are generated using:
1. **Google Imagen 3** (`imagen-3.0-generate-002`) if `GOOGLE_API_KEY` is provided with billing.
2. **Cloudflare Workers AI** (`@cf/black-forest-labs/flux-1-schnell`) via the free `[ai]` binding.
3. **Unsplash** (if `UNSPLASH_ACCESS_KEY` is set).

To use Unsplash stock photos as a secondary source:

```bash
npx wrangler secret put UNSPLASH_ACCESS_KEY
```

### 6. Cron schedule and topics

Edit `wrangler.toml` to change the schedule, niche, topic list, or RSS feeds:

```toml
CRON_NICHE = "AI and WordPress development"
CRON_TOPICS = "[\"topic one\", \"topic two\"]"
RSS_FEED_URLS = "[\"https://example.com/feed\"]"
```

Default schedule:

- WordPress: Monday and Thursday at 08:00 UTC
- LinkedIn, Facebook, Instagram: 10:00 and 18:00 UTC daily

## Local development

Run the Worker locally:

```bash
npx wrangler dev
```

## Deployment

Deploy to Cloudflare:

```bash
npx wrangler deploy
```

## Manual posting

Send a manual post without waiting for the cron schedule:

```bash
curl -X POST https://auto-poster.chadfuse.workers.dev \
  -H 'content-type: application/json' \
  -d '{
    "topic": "How to speed up a WordPress site",
    "niche": "wordpress development",
    "platforms": ["wordpress", "linkedin", "facebook", "instagram"],
    "wp": { "status": "publish" }
  }'
```

## How scheduled topics stay unique

When a cron fires, the Worker:

1. Fetches RSS feeds.
2. Combines feed topics with the static `CRON_TOPICS` list.
3. Checks `POSTED_TOPICS` KV for each topic.
4. Picks the first unposted topic.
5. After a successful post, stores the topic in KV.

This prevents duplicate posts. If all topics have been used, the run is skipped.

## Troubleshooting

- **Facebook/Instagram token keeps expiring** — use the `/refresh-facebook-token` endpoint to get a long-lived Page token.
- **Email does not arrive** — verify the `FROM_EMAIL` domain in Resend and check spam folders.
- **Posts are too short** — the Worker auto-expands short AI output with a second model call, but the free 7B model has limits. You may need a larger model for guaranteed 1000+ words.
- **Images look low quality** — add an `UNSPLASH_ACCESS_KEY` for real stock photos, or switch `TEXT_MODEL` to a better image prompt.
- **Instagram publish fails** — the Worker waits 10 seconds between media creation and publish. If it still fails, the image may not be public or the token may lack `instagram_content_publish`.

## Project structure

```
.
├── .dev.vars.example
├── .gitignore
├── linkedin-post.html
├── package.json
├── project-blogpost.html
├── README.md
├── src/index.js
└── wrangler.toml
```

## Project write-up

- `project-blogpost.html` — a full HTML blog post about the project.
- `linkedin-post.html` — a plain-text LinkedIn version. Open the file and copy the text inside the gray box.

## License

Private. All rights reserved by the project owner.

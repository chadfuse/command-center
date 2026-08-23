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

- `src/index.js` — main Cloudflare Worker (Hono-style export with `fetch` and `scheduled` handlers).
- `wrangler.toml` — Cloudflare configuration, cron triggers, variables, and KV namespace.
- `.dev.vars` — local secrets (not committed).
- Cloudflare Workers AI binding — image fallback (`@cf/black-forest-labs/flux-1-schnell`).
- Groq-compatible OpenAI endpoint — text generation.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account
- Groq API key (or any OpenAI-compatible endpoint)
- WordPress site with Application Passwords enabled
- Facebook app and Page with permissions
- Resend account (for email notifications)
- Unsplash API key (optional, for better images)

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

### 1. Text generation (Groq)

Set your text API key as a Wrangler secret:

```bash
npx wrangler secret put TEXT_API_KEY
```

The default endpoint and model are in `wrangler.toml`:

```toml
TEXT_API_URL = "https://api.groq.com/openai/v1/chat/completions"
TEXT_MODEL = "allam-2-7b"
```

You can override them by editing `wrangler.toml` or setting `TEXT_API_URL` / `TEXT_MODEL` in `.dev.vars`.

#### Optional fallback provider (e.g. free.ai)

If you want a third-level fallback, set a different OpenAI-compatible endpoint:

```bash
npx wrangler secret put FALLBACK_TEXT_API_URL  # e.g. https://api.free.ai/v1/chat/completions
npx wrangler secret put FALLBACK_TEXT_API_KEY
npx wrangler secret put FALLBACK_TEXT_API_MODEL
```

The Worker tries the primary Groq model, then the Groq fallback model, then this external provider. If all three fail, the run errors out.

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

### 5. Unsplash images (optional)

For real stock photos instead of AI-generated images:

```bash
npx wrangler secret put UNSPLASH_ACCESS_KEY
```

The Worker tries Unsplash first, then Pollinations, then Cloudflare Workers AI.

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
├── package.json
├── README.md
├── src/index.js
└── wrangler.toml
```

## License

Private. All rights reserved by the project owner.

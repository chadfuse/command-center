// Auto-poster v2 — WordPress + LinkedIn + Instagram + TikTok
// Platform credentials can be set in Worker env/secrets and overridden in the POST body.

const DEFAULT_TEXT_MODEL = 'llama-3.1-8b-instant';
const FEATURED_IMAGE = { width: 1200, height: 675 };

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function slugify(text) {
  return text.toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 60)
    .replace(/-$/, '');
}

async function callTextApi(messages, maxTokens, env) {
  const apiUrl = env.TEXT_API_URL;
  const apiKey = env.TEXT_API_KEY;
  const models = [env.TEXT_MODEL, env.FALLBACK_TEXT_MODEL].filter(Boolean);

  if (!apiUrl || !apiKey) {
    throw new Error('TEXT_API_URL and TEXT_API_KEY must be set in your Worker secrets/env. See .dev.vars.example.');
  }

  let lastError = null;
  for (const model of models) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content ?? '';
      if (raw) return raw;
      lastError = new Error('Text API returned empty content');
    } else {
      const err = await res.text();
      lastError = new Error(`Text API error ${res.status}: ${err}`);
    }
  }

  if (env.FALLBACK_TEXT_API_URL && env.FALLBACK_TEXT_API_KEY) {
    const fallbackModels = env.FALLBACK_TEXT_API_MODELS
      ? JSON.parse(env.FALLBACK_TEXT_API_MODELS)
      : (env.FALLBACK_TEXT_API_MODEL ? [env.FALLBACK_TEXT_API_MODEL] : []);

    for (const model of fallbackModels) {
      const res = await fetch(env.FALLBACK_TEXT_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${env.FALLBACK_TEXT_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: maxTokens,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content ?? '';
        if (raw) return raw;
      } else {
        const err = await res.text();
        lastError = new Error(`Fallback text API error ${res.status}: ${err}`);
      }
    }
  }

  throw lastError || new Error('Text API failed for all configured models and fallback providers');
}

async function generateText({ topic, niche }, env) {
  const system = `You are an expert, human ${niche} content writer and SEO specialist.

Return the content using this exact format, with each field on its own line and the BODY at the end:
TITLE: <compelling, click-worthy blog title under 60 characters>
SLUG: <url-friendly slug>
FOCUS_KEYWORD: <primary SEO keyword>
META_DESCRIPTION: <150-160 character meta description>
EXCERPT: <1-2 sentence summary>
SOCIAL_POST: <a short, original 120-200 word social media caption for LinkedIn, Facebook, and Instagram. It must be different from the excerpt. Do not include URLs, hashtags, or emojis. End with a question or a conversational call to action.>
TAGS: <comma-separated list of 5-7 tags>
BODY: <comprehensive, human, original HTML content of at least 1000 words. Do not write fewer than 1000 words. Use one <h1>, multiple <h2> and <h3> subheadings, short paragraphs, bullet lists, and practical examples. Mention current tools, recent best practices, and real-world examples where relevant. Avoid generic AI phrases and markdown code blocks.>

Do not add explanations, notes, or sections outside this format.`;
  const user = `Write a comprehensive, up-to-date, SEO-optimized blog post about: ${topic}`;

  const raw = await callTextApi([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], 2500, env);

  const fields = {
    title: /^TITLE:\s*(.+?)$/im,
    slug: /^SLUG:\s*(.+?)$/im,
    focusKeyword: /^FOCUS_KEYWORD:\s*(.+?)$/im,
    metaDescription: /^META_DESCRIPTION:\s*(.+?)$/im,
    excerpt: /^EXCERPT:\s*(.+?)$/im,
    socialPost: /^SOCIAL_POST:\s*(.+?)$/im,
    tags: /^TAGS:\s*(.+?)$/im,
    body: /^BODY:\s*([\s\S]+?)(?:\n(?:TITLE|SLUG|FOCUS_KEYWORD|META_DESCRIPTION|EXCERPT|TAGS|BODY|NOTE|REFERENCE|CONCLUSION):\s*|$)/im,
  };

  const parsed = {};
  for (const [key, regex] of Object.entries(fields)) {
    const match = raw.match(regex);
    parsed[key] = match ? match[1].trim() : '';
  }

  if (!parsed.title || !parsed.body) {
    const lines = raw.split('\n').filter(line => line.trim());
    parsed.title = lines[0] || `All about ${topic}`;
    parsed.body = lines.slice(1).join('\n').trim() || raw;
  }

  parsed.title = parsed.title.replace(/^(TITLE|Title|title):\s*/i, '').replace(/<[^>]+>/g, '').trim();
  parsed.excerpt = parsed.excerpt.replace(/^(EXCERPT|Excerpt|excerpt):\s*/i, '').replace(/<[^>]+>/g, '').trim();
  parsed.socialPost = parsed.socialPost.replace(/^(SOCIAL_POST|Social_Post|social_post):\s*/i, '').replace(/<[^>]+>/g, '').trim();
  parsed.metaDescription = parsed.metaDescription.replace(/<[^>]+>/g, '').trim();
  parsed.focusKeyword = parsed.focusKeyword.replace(/<[^>]+>/g, '').trim();

  if (!parsed.body.startsWith('<')) {
    parsed.body = `<p>${parsed.body.replace(/\n\n/g, '</p><p>')}</p>`;
  }

  if (countWords(parsed.body) < 800) {
    parsed.body = await expandBody({ body: parsed.body, title: parsed.title, niche }, env);
  }

  if (!parsed.socialPost || parsed.socialPost.length < 80) {
    parsed.socialPost = await generateSocialPost({ title: parsed.title, excerpt: parsed.excerpt, body: parsed.body, niche }, env);
  }

  const slug = parsed.slug || slugify(parsed.title) || slugify(topic);
  const tags = parsed.tags ? parsed.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

  return {
    title: parsed.title,
    slug,
    focusKeyword: parsed.focusKeyword || topic,
    metaDescription: parsed.metaDescription || parsed.excerpt || parsed.body.slice(0, 160),
    excerpt: parsed.excerpt || parsed.metaDescription || parsed.body.slice(0, 200),
    socialPost: parsed.socialPost || parsed.excerpt || parsed.body.slice(0, 300),
    tags,
    body: parsed.body,
  };
}

function countWords(html) {
  return stripHtml(html).split(/\s+/).filter(Boolean).length;
}

async function generateSocialPost({ title, excerpt, body, niche }, env) {
  const summary = excerpt || stripHtml(body).slice(0, 400);
  const prompt = `You are an expert ${niche} social media copywriter. Write a short, original, engaging 120-200 word social media caption for this post.\n\nTitle: ${title}\nSummary: ${summary}\n\nRequirements:\n- Do not copy the summary word for word.\n- Do not include URLs, hashtags, or emojis.\n- Write a complete paragraph or two.\n- End with a question or a conversational call to action.`;

  const raw = await callTextApi([
    { role: 'system', content: 'You write short, clear social media captions only. No URLs, no emojis, no hashtags.' },
    { role: 'user', content: prompt },
  ], 1000, env);

  return raw.replace(/<[^>]+>/g, '').trim();
}

async function expandBody({ body, title, niche }, env) {
  const prompt = `You are an expert, human ${niche} content writer. Expand the following blog post to at least 1000 words total. Keep the existing HTML structure and content, but add more detail, examples, and practical subsections. Do not change the title. Return the complete expanded HTML body only. Do not wrap it in markdown code blocks.\n\nTitle: ${title}\n\n${body}`;

  let raw = await callTextApi([
    { role: 'system', content: 'You are a helpful content expansion assistant. Return HTML body only.' },
    { role: 'user', content: prompt },
  ], 2000, env);
  raw = raw.replace(/^```html\n?/, '').replace(/```\s*$/, '').trim();
  if (!raw.startsWith('<')) {
    raw = `<p>${raw.replace(/\n\n/g, '</p><p>')}</p>`;
  }
  return raw || body;
}

async function fetchUnsplashImage(topic, accessKey) {
  const query = encodeURIComponent(topic.split(' ').slice(0, 6).join(' '));
  const searchRes = await fetch(`https://api.unsplash.com/search/photos?query=${query}&per_page=5&orientation=landscape&client_id=${accessKey}`);
  if (!searchRes.ok) throw new Error(`Unsplash search failed: ${searchRes.status}`);
  const data = await searchRes.json();
  if (!data.results?.length) throw new Error('No Unsplash results found');

  for (const result of data.results) {
    const imageUrl = `${result.urls.regular}&w=1200&h=675&fit=crop`;
    const imgRes = await fetch(imageUrl);
    if (imgRes.ok) {
      const blob = await imgRes.blob();
      return { blob, ext: 'jpeg', contentType: blob.type || 'image/jpeg' };
    }
  }
  throw new Error('Could not fetch any Unsplash image');
}

async function fetchOpenAIImage(topic, openaiKey) {
  const imagePrompt = `A modern, clean, professional featured blog image for "${topic}". Editorial minimal style, no text, no watermarks, high quality, 1200x675 landscape.`;
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt: imagePrompt,
      n: 1,
      size: '1024x1024',
      response_format: 'url',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI image generation failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  const imageUrl = data.data?.[0]?.url;
  if (!imageUrl) throw new Error('OpenAI did not return an image URL');

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Could not download OpenAI image: ${imgRes.status}`);

  const blob = await imgRes.blob();
  return { blob, ext: 'png', contentType: 'image/png' };
}

async function generateImage({ topic, niche }, env) {
  const openaiKey = env.OPENAI_API_KEY || env.TEXT_API_KEY;
  if (openaiKey) {
    try {
      return await fetchOpenAIImage(topic, openaiKey);
    } catch (e) {
      console.log('OpenAI image failed, trying Unsplash:', e.message);
    }
  }

  if (env.UNSPLASH_ACCESS_KEY) {
    try {
      return await fetchUnsplashImage(topic, env.UNSPLASH_ACCESS_KEY);
    } catch (e) {
      console.log('Unsplash failed, trying Pollinations:', e.message);
    }
  }

  const prompts = [
    `Modern professional featured image for a blog post about ${topic}, clean minimal editorial style, no text, high quality, 4k`,
    `Abstract minimal editorial illustration for ${niche}, clean, professional, no text, high quality`,
    `Clean abstract technology concept, modern minimal style, professional, no text, high quality`,
  ];
  const negative = 'text, watermark, logo, blurry, low quality, gibberish, ugly, distorted';
  const width = 1200;
  const height = 675;

  for (const prompt of prompts) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&seed=${Date.now()}&nologo=true&negative_prompt=${encodeURIComponent(negative)}`;
    try {
      const res = await fetch(url, { headers: { accept: 'image/*' } });
      if (res.ok) {
        const blob = await res.blob();
        return { blob, ext: 'jpeg', contentType: 'image/jpeg' };
      }
    } catch (e) {
      console.log('Pollinations failed, trying Cloudflare AI:', e.message);
    }
  }

  if (!env.AI) {
    throw new Error('AI binding not configured. Add [ai] binding = "AI" to wrangler.toml.');
  }

  let lastError = null;
  for (const prompt of prompts) {
    try {
      const result = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt });
      const b64 = result.image;
      if (typeof b64 === 'string' && b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        return { blob, ext: 'jpeg', contentType: 'image/jpeg' };
      }
      lastError = new Error('Cloudflare AI did not return an image');
    } catch (e) {
      lastError = e;
      if (e.message?.includes('8007') || e.message?.includes('NSFW')) {
        continue;
      }
      throw e;
    }
  }

  throw lastError || new Error('Image generation failed');
}

function wpBaseUrl(wp) {
  return wp.url.replace(/\/$/, '');
}

async function uploadMediaToWordPress(wp, image) {
  const auth = btoa(`${wp.username}:${wp.appPassword}`);
  const filename = `featured-${Date.now()}.${image.ext}`;

  const res = await fetch(`${wpBaseUrl(wp)}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      'authorization': `Basic ${auth}`,
      'content-disposition': `attachment; filename="${filename}"`,
      'content-type': image.contentType,
    },
    body: image.blob,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WordPress media upload failed: ${res.status} ${err}`);
  }

  return await res.json();
}

async function createPostOnWordPress(wp, { title, body, mediaId, status, seo }) {
  const auth = btoa(`${wp.username}:${wp.appPassword}`);
  const payload = {
    title,
    content: body,
    status,
    slug: seo?.slug || slugify(title),
    excerpt: seo?.excerpt,
    meta: {
      _yoast_wpseo_title: title,
      _yoast_wpseo_metadesc: seo?.metaDescription || seo?.excerpt,
      _yoast_wpseo_focuskw: seo?.focusKeyword || '',
      rank_math_title: title,
      rank_math_description: seo?.metaDescription || seo?.excerpt,
      rank_math_focus_keyword: seo?.focusKeyword || '',
    },
  };
  if (mediaId) payload.featured_media = mediaId;

  const res = await fetch(`${wpBaseUrl(wp)}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: {
      'authorization': `Basic ${auth}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WordPress post creation failed: ${res.status} ${err}`);
  }

  return await res.json();
}

function buildWpConfig(body, env) {
  return {
    url: body.wp?.url || env.WP_URL,
    username: body.wp?.username || env.WP_USERNAME,
    appPassword: body.wp?.appPassword || env.WP_APP_PASSWORD,
    status: body.wp?.status || env.WP_STATUS || 'draft',
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getLinkedInAuthor(token, env) {
  const envUrn = env.LINKEDIN_AUTHOR_URN;
  if (envUrn) return envUrn;

  const info = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { 'authorization': `Bearer ${token}` },
  });
  if (info.ok) {
    const data = await info.json();
    const sub = data.sub;
    return sub.startsWith('urn:') ? sub : `urn:li:person:${sub}`;
  }
  const userInfoErr = await info.text();

  const me = await fetch('https://api.linkedin.com/v2/me', {
    headers: {
      'authorization': `Bearer ${token}`,
      'x-restli-protocol-version': '2.0.0',
    },
  });
  if (me.ok) {
    const data = await me.json();
    return `urn:li:person:${data.id}`;
  }
  const meErr = await me.text();

  throw new Error(`Could not fetch LinkedIn profile. userinfo:${info.status} ${userInfoErr} | me:${me.status} ${meErr}`);
}

async function uploadImageToLinkedIn(token, imageUrl, author) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Could not fetch image for LinkedIn: ${imgRes.status}`);
  }
  const imageBytes = await imgRes.arrayBuffer();

  const registerRes = await fetch('https://api.linkedin.com/v2/images?action=registerUpload', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'x-restli-protocol-version': '2.0.0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: author,
        serviceRelationships: [{ identifier: 'urn:li:userGeneratedContent', relationshipType: 'OWNER' }],
      },
    }),
  });

  if (!registerRes.ok) {
    const err = await registerRes.text();
    throw new Error(`LinkedIn image registration failed: ${registerRes.status} ${err}`);
  }

  const registerData = await registerRes.json();
  const uploadUrl = registerData.value?.uploadUrl;
  const asset = registerData.value?.asset;
  if (!uploadUrl || !asset) {
    throw new Error('LinkedIn did not return an upload URL or asset URN');
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body: imageBytes,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`LinkedIn image upload failed: ${uploadRes.status} ${err}`);
  }

  return asset;
}

function formatHashtags(tags) {
  if (!tags || tags.length === 0) return '';
  return tags.map(t => '#' + t.trim().replace(/[\s-]+/g, '').toLowerCase()).join(' ');
}

async function postToLinkedIn({ text, env, media }) {
  const token = env.LINKEDIN_ACCESS_TOKEN;
  if (!token) {
    throw new Error('LINKEDIN_ACCESS_TOKEN not set. Add it with wrangler secret put.');
  }

  const author = await getLinkedInAuthor(token, env);
  const hashtags = formatHashtags(text.tags);
  const shareText = `📝 ${text.title}\n\n${text.socialPost}${hashtags ? '\n\n' + hashtags : ''}`;

  const shareContent = {
    shareCommentary: { text: shareText },
    shareMediaCategory: 'NONE',
    shareMedia: [],
  };

  if (media?.source_url) {
    try {
      const asset = await uploadImageToLinkedIn(token, media.source_url, author);
      shareContent.shareMediaCategory = 'IMAGE';
      shareContent.shareMedia = [{ status: 'READY', media: asset }];
    } catch (imgErr) {
      console.log('LinkedIn image upload skipped, posting text only:', imgErr.message);
    }
  }

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'x-restli-protocol-version': '2.0.0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      author,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': shareContent,
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn post failed: ${res.status} ${err}`);
  }

  return await res.json();
}

async function postToInstagram({ text, media, env }) {
  const token = env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = env.INSTAGRAM_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new Error('INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID not set.');
  }
  if (!media?.source_url) {
    throw new Error('Instagram requires a featured image. WordPress must succeed first.');
  }

  const hashtags = formatHashtags(text.tags);
  const caption = `✅ ${text.title}\n\n${text.socialPost}\n\n💡 Save this and share your thoughts below.${hashtags ? '\n\n' + hashtags : ''}`;
  const createRes = await fetch(`https://graph.facebook.com/v19.0/${accountId}/media?image_url=${encodeURIComponent(media.source_url)}&caption=${encodeURIComponent(caption)}&access_token=${token}`, { method: 'POST' });
  if (!createRes.ok) {
    const err = await createRes.text();
    const permsRes = await fetch(`https://graph.facebook.com/v19.0/me/permissions?access_token=${token}`);
    const permsData = permsRes.ok ? await permsRes.json() : null;
    const granted = permsData?.data?.filter(p => p.status === 'granted').map(p => p.permission).join(', ') || 'unknown';
    throw new Error(`Instagram media creation failed: ${createRes.status} ${err}. Granted permissions: ${granted}`);
  }

  const { id: creationId } = await createRes.json();
  await new Promise(resolve => setTimeout(resolve, 10000));
  const publishRes = await fetch(`https://graph.facebook.com/v19.0/${accountId}/media_publish?creation_id=${creationId}&access_token=${token}`, { method: 'POST' });
  if (!publishRes.ok) {
    const err = await publishRes.text();
    throw new Error(`Instagram media publish failed: ${publishRes.status} ${err}`);
  }

  const publishData = await publishRes.json();
  const permalinkRes = await fetch(`https://graph.facebook.com/v19.0/${publishData.id}?fields=permalink,shortcode&access_token=${token}`);
  if (permalinkRes.ok) {
    const { permalink, shortcode } = await permalinkRes.json();
    return { id: publishData.id, permalink, shortcode };
  }

  return { id: publishData.id };
}

async function postToTikTok({ text, media, env }) {
  const token = env.TIKTOK_ACCESS_TOKEN;
  if (!token) {
    throw new Error('TIKTOK_ACCESS_TOKEN not set.');
  }
  if (!media?.source_url) {
    throw new Error('TikTok requires a featured image. WordPress must succeed first.');
  }

  const res = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      media_type: 'PHOTO',
      post_mode: 'DIRECT_POST',
      post_info: {
        title: text.title.slice(0, 90),
        description: stripHtml(text.body).slice(0, 4000),
        privacy_level: 'PUBLIC_TO_EVERYONE',
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        photo_images: [media.source_url],
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TikTok post failed: ${res.status} ${err}`);
  }

  return await res.json();
}

async function getFacebookPageToken(pageId, token) {
  const listRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=access_token&access_token=${token}`);
  if (listRes.ok) {
    const data = await listRes.json();
    const page = data.data?.find(p => p.id === pageId);
    if (page?.access_token) return page.access_token;
  }

  const checkRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=id&access_token=${token}`);
  if (checkRes.ok) {
    return token;
  }

  throw new Error(`Could not get a valid token for Facebook Page ID ${pageId}. The token may not have pages_show_list/pages_manage_metadata, or the Page ID may be wrong.`);
}

async function postToFacebook({ text, env, mediaUrl }) {
  const userToken = env.FACEBOOK_ACCESS_TOKEN;
  const pageId = env.FACEBOOK_PAGE_ID;
  if (!userToken || !pageId) {
    throw new Error('FACEBOOK_ACCESS_TOKEN and FACEBOOK_PAGE_ID not set.');
  }

  const pageToken = await getFacebookPageToken(pageId, userToken);
  const hashtags = formatHashtags(text.tags);
  const message = `📝 ${text.title}\n\n${text.socialPost}${hashtags ? '\n\n' + hashtags : ''}`;
  const params = new URLSearchParams({ message, access_token: pageToken });

  if (mediaUrl) {
    params.append('url', mediaUrl);
    params.append('published', 'true');
  }

  const endpoint = mediaUrl ? `photos` : `feed`;
  const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/${endpoint}?${params.toString()}`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook post failed: ${res.status} ${err}`);
  }

  return await res.json();
}

function parseCronTopics(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function fetchRssTopics(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status}`);
  }
  const xml = await res.text();
  const items = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)];
  const topics = [];
  for (const [, item] of items) {
    const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
    const clean = title.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/i, '$1').replace(/<[^>]+>/g, '').trim();
    if (clean) topics.push(clean);
  }
  return topics;
}

async function getUniqueTopic(env) {
  const fallback = parseCronTopics(env.CRON_TOPICS);
  const feeds = env.RSS_FEED_URLS ? parseCronTopics(env.RSS_FEED_URLS) : (env.RSS_FEED_URL ? [env.RSS_FEED_URL] : []);
  const seen = new Set();
  let topics = [];

  for (const url of feeds) {
    try {
      const items = await fetchRssTopics(url);
      for (const item of items) {
        if (!seen.has(item)) {
          seen.add(item);
          topics.push(item);
        }
      }
    } catch (e) {
      console.log('RSS fetch failed:', url, e.message);
    }
  }

  for (const topic of fallback) {
    if (!seen.has(topic)) {
      seen.add(topic);
      topics.push(topic);
    }
  }

  if (topics.length === 0) {
    return null;
  }
  if (!env.POSTED_TOPICS) {
    return topics[0];
  }
  for (const topic of topics) {
    const key = `posted:${slugify(topic)}`;
    const existing = await env.POSTED_TOPICS.get(key);
    if (!existing) {
      return topic;
    }
  }
  return null;
}

async function markTopicPosted(env, topic) {
  if (env.POSTED_TOPICS && topic) {
    const key = `posted:${slugify(topic)}`;
    await env.POSTED_TOPICS.put(key, '1');
  }
}

async function refreshFacebookToken(body) {
  const { clientId, clientSecret, shortLivedToken, pageId } = body;
  if (!clientId || !clientSecret || !shortLivedToken) {
    throw new Error('clientId, clientSecret, and shortLivedToken are required');
  }

  const exchangeRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`);
  if (!exchangeRes.ok) {
    const err = await exchangeRes.text();
    throw new Error(`Token exchange failed: ${exchangeRes.status} ${err}`);
  }

  const exchangeData = await exchangeRes.json();
  const longLivedUserToken = exchangeData.access_token;
  if (!longLivedUserToken) {
    throw new Error('No long-lived token returned from Facebook');
  }

  const accountsRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=name,id,access_token&access_token=${longLivedUserToken}`);
  if (!accountsRes.ok) {
    const err = await accountsRes.text();
    throw new Error(`Could not list pages: ${accountsRes.status} ${err}`);
  }

  const { data } = await accountsRes.json();
  let pages = [];

  if (Array.isArray(data) && data.length > 0) {
    pages = pageId ? data.filter(p => p.id === pageId) : data;
  }

  if (pages.length === 0 && pageId) {
    const pageRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=name,id,access_token&access_token=${longLivedUserToken}`);
    if (pageRes.ok) {
      const pageData = await pageRes.json();
      if (pageData && pageData.access_token) {
        pages = [pageData];
      }
    }
  }

  if (pages.length === 0) {
    throw new Error('No Facebook pages found for this token. Make sure it has pages_show_list or pages_manage_metadata permission.');
  }

  return {
    pages: pages.map(p => ({ id: p.id, name: p.name, access_token: p.access_token })),
  };
}

async function runPost(body, env) {
  const { topic, niche, platforms = ['wordpress'] } = body;
  if (!topic || !niche) {
    throw new Error('Missing topic and niche.');
  }

  const wp = buildWpConfig(body, env);
  const needsImage = platforms.some(p => ['wordpress', 'instagram', 'tiktok', 'facebook', 'linkedin'].includes(p));
  if (needsImage && (!wp.url || !wp.username || !wp.appPassword)) {
    throw new Error('Missing WordPress credentials. They are needed to generate and host the featured image.');
  }

  const text = await generateText({ topic, niche }, env);
  let media = null;
  let imageError = null;
  const results = {};

  if (needsImage) {
    try {
      const image = await generateImage({ topic, niche }, env);
      media = await uploadMediaToWordPress(wp, image);
    } catch (imgErr) {
      console.log('Image generation/upload skipped:', imgErr.message);
      imageError = imgErr.message;
    }
  }

  if ((platforms.includes('instagram') || platforms.includes('tiktok')) && !media?.source_url) {
    throw new Error(`Image generation/upload failed: ${imageError || 'unknown'}. Instagram and TikTok require a hosted featured image.`);
  }

  if (platforms.includes('wordpress')) {
    const post = await createPostOnWordPress(wp, {
      title: text.title,
      body: text.body,
      mediaId: media?.id,
      status: wp.status,
      seo: {
        slug: text.slug,
        excerpt: text.excerpt,
        metaDescription: text.metaDescription,
        focusKeyword: text.focusKeyword,
      },
    });
    results.wordpress = { id: post.id, link: post.link, status: post.status };
    results.media = media ? { id: media.id, source_url: media.source_url } : null;
  }

  if (platforms.includes('linkedin')) {
    results.linkedin = await postToLinkedIn({ text, env, media });
  }

  if (platforms.includes('instagram')) {
    results.instagram = await postToInstagram({ text, media, env });
  }

  if (platforms.includes('tiktok')) {
    results.tiktok = await postToTikTok({ text, media, env });
  }

  if (platforms.includes('facebook')) {
    results.facebook = await postToFacebook({ text, env, mediaUrl: media?.source_url });
  }

  return {
    success: true,
    results,
    title: text.title,
    excerpt: text.excerpt || text.body.slice(0, 200),
    socialPost: text.socialPost,
  };
}

function pickCronTopic(topics, slot, dayIndex) {
  const index = (dayIndex * 2 + slot) % topics.length;
  return topics[index];
}

async function sendNotification({ subject, html, text }, env) {
  const apiKey = env.RESEND_API_KEY;
  const to = env.NOTIFICATION_EMAIL;
  const from = env.FROM_EMAIL || 'onboarding@resend.dev';
  if (!apiKey || !to) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resend API ${res.status}: ${err}`);
    }
  } catch (e) {
    console.log('Notification email failed:', e.message);
  }
}

function buildEmailHtml(title, status, detail) {
  return `<h2>${status}: ${title}</h2><pre style="white-space:pre-wrap">${detail}</pre>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/refresh-facebook-token') {
      if (request.method !== 'POST') {
        return new Response('Send a POST request with JSON: { "clientId": "...", "clientSecret": "...", "shortLivedToken": "..." }', { status: 200 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }
      try {
        const result = await refreshFacebookToken(body);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (request.method !== 'POST') {
      return new Response('Send a POST request with JSON: { "topic": "...", "niche": "...", "platforms": ["wordpress", "linkedin", "instagram", "tiktok", "facebook"] }', { status: 200 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await runPost(body, env);
      const detail = JSON.stringify(result, null, 2);
      await sendNotification({
        subject: `Auto-poster: posted to ${Object.keys(result.results || {}).join(', ')}`,
        html: buildEmailHtml(body.topic, 'Success', detail),
        text: detail,
      }, env);
      return jsonResponse(result);
    } catch (err) {
      await sendNotification({
        subject: 'Auto-poster: post failed',
        html: buildEmailHtml(body.topic, 'Failed', err.message),
        text: err.message,
      }, env);
      return jsonResponse({ error: err.message }, 500);
    }
  },

  async scheduled(event, env) {
    const niche = env.CRON_NICHE || 'wordpress development';
    const topic = await getUniqueTopic(env);
    if (!topic) {
      console.log('No unique topic available; skipping scheduled post');
      return;
    }

    let platforms;
    let status;

    if (event.cron === '0 8 * * 1,4') {
      platforms = ['wordpress'];
      status = env.CRON_WP_STATUS || 'publish';
    } else if (event.cron === '0 10 * * *' || event.cron === '0 18 * * *') {
      platforms = ['linkedin', 'facebook', 'instagram'];
      status = env.WP_STATUS || 'draft';
    } else {
      console.log('Unknown cron expression:', event.cron);
      return;
    }

    try {
      const result = await runPost({ topic, niche, platforms, wp: { status } }, env);
      await markTopicPosted(env, topic);
      console.log('Scheduled post succeeded:', JSON.stringify(result));
      const detail = JSON.stringify(result, null, 2);
      await sendNotification({
        subject: `Auto-poster scheduled: posted to ${Object.keys(result.results || {}).join(', ')}`,
        html: buildEmailHtml(topic, 'Success', detail),
        text: detail,
      }, env);
    } catch (err) {
      console.log('Scheduled post failed:', err.message);
      await sendNotification({
        subject: 'Auto-poster scheduled: post failed',
        html: buildEmailHtml(topic, 'Failed', err.message),
        text: err.message,
      }, env);
    }
  },
};

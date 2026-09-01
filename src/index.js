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

function isRefusal(text) {
  const lower = text.toLowerCase().trim();
  return lower.startsWith("i can't fulfill") ||
         lower.startsWith("i cannot fulfill") ||
         lower.startsWith("i can’t fulfill") ||
         lower.includes("i can't fulfill that") ||
         lower.includes("i cannot fulfill that") ||
         lower.includes("i can’t fulfill that");
}

async function callTextApi(messages, maxTokens, env) {
  const isGoogle = env.TEXT_API_URL?.includes('googleapis.com') || (!env.TEXT_API_URL && (env.GOOGLE_API_KEY || env.GEMINI_API_KEY));
  const isOpenRouter = env.TEXT_API_URL?.includes('openrouter.ai');
  let apiKey;
  if (isGoogle) {
    apiKey = env.GOOGLE_API_KEY || env.GEMINI_API_KEY || env.TEXT_API_KEY;
  } else if (isOpenRouter) {
    apiKey = env.OPENROUTER_API_KEY || env.TEXT_API_KEY;
  } else {
    apiKey = env.GOOGLE_API_KEY || env.GEMINI_API_KEY || env.TEXT_API_KEY;
  }
  const models = [env.TEXT_MODEL, env.FALLBACK_TEXT_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash'].filter((m, i, arr) => m && arr.indexOf(m) === i);

  const textApiUrl = env.TEXT_API_URL || (isGoogle ? 'https://generativelanguage.googleapis.com/v1beta/models' : '');
  if (!textApiUrl || !apiKey) {
    throw new Error('Text API URL and an API key must be set (e.g. GOOGLE_API_KEY or TEXT_API_KEY). See .dev.vars.example.');
  }

  let lastError = null;
  for (const model of models) {
    let res;
    if (isGoogle) {
      const base = textApiUrl.replace(/\/+$/, '');
      const url = base.endsWith('/models')
        ? `${base}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`
        : `${base}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const systemText = messages.find(m => m.role === 'system')?.content || '';
      const conversationMessages = messages.filter(m => m.role !== 'system');
      const contents = conversationMessages.map(m => ({
        role: (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
        parts: [{ text: m.content || '' }],
      }));

      if (contents.length === 0) {
        const userText = messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
        contents.push({ role: 'user', parts: [{ text: userText }] });
      }

      const body = {
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: maxTokens,
        },
      };
      if (systemText) {
        body.systemInstruction = { parts: [{ text: systemText }] };
      }

      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          const data = await res.json();
          const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') ?? '';
          if (raw && !isRefusal(raw)) return raw;
          if (data.promptFeedback?.blockReason) {
            lastError = new Error(`Google AI blocked request: ${data.promptFeedback.blockReason}`);
          } else {
            lastError = raw ? new Error(`Google AI (${model}) returned a refusal`) : new Error(`Google AI (${model}) returned empty content`);
          }
        } else {
          const err = await res.text();
          lastError = new Error(`Google AI (${model}) error ${res.status}: ${err}`);
          console.log(`Google AI (${model}) failed:`, res.status, err);
        }
      } catch (fetchErr) {
        lastError = fetchErr;
        console.log(`Google AI (${model}) fetch failed:`, fetchErr.message);
      }
    } else {
      try {
        res = await fetch(textApiUrl, {
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
          if (raw && !isRefusal(raw)) return raw;
          lastError = raw ? new Error(`Text API ${model} returned a refusal`) : new Error(`Text API ${model} returned empty content`);
        } else {
          const err = await res.text();
          lastError = new Error(`Text API error ${res.status}: ${err}`);
        }
      } catch (fetchErr) {
        lastError = fetchErr;
      }
    }
  }

  if (env.AI) {
    const workersModels = [
      '@cf/meta/llama-3.1-8b-instruct-fp8',
      '@cf/meta/llama-3.1-8b-instruct',
      '@cf/mistral/mistral-7b-instruct-v0.2',
    ];
    for (const model of workersModels) {
      try {
        const result = await env.AI.run(model, { messages });
        const raw = result.response || '';
        if (raw && !isRefusal(raw)) return raw;
      } catch (e) {
        lastError = e;
        console.log(`Workers AI ${model} failed:`, e.message);
      }
    }
  }

  throw lastError || new Error('Text API failed for all configured models and fallback providers');
}

function cleanSocialPost(text) {
  if (!text) return '';
  let cleaned = text.trim();

  // If there is conversational preamble before the first hook emoji, strip it
  const firstHookIndex = cleaned.search(/(?:🚀|💡|⚡|🔥|💻|✨|🌐|🔹|#)/);
  if (firstHookIndex > 0) {
    const preamble = cleaned.slice(0, firstHookIndex);
    if (/here (?:is|are)|social media post|\*\*linkedin|\*\*facebook|\*\*instagram/i.test(preamble)) {
      cleaned = cleaned.slice(firstHookIndex);
    }
  }

  cleaned = cleaned
    // Remove platform labels like "**LinkedIn Post:**", "**Instagram Post:**", etc.
    .replace(/^(\*{0,2}(?:LinkedIn|Facebook|Instagram|Twitter|X|Social Media)\s*Post:?\*{0,2})\s*\n*/gim, '')
    // Remove meta headers like "**Here's the breakdown:**", "**Inclusion Formula:**", etc.
    .replace(/^\*{0,2}(?:Here's the breakdown|Inclusion Formula|Formula|The Breakdown|Key Takeaways?):?\*{0,2}\s*\n*/gim, '')
    // Strip markdown bold and italic asterisks that show up as raw ** on social media
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // Ensure every 🔹 or bullet item is on its own separate line with clean spacing
    .replace(/([^\n])\s*(🔹|🔸|•)\s*/g, '$1\n\n$2 ')
    // Remove stray asterisks
    .replace(/\*\*/g, '')
    // Normalize excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

async function generateText({ topic, niche }, env) {
  const system = `You are a visionary web developer, ${niche} specialist, and high-impact content writer.

Return the content using this EXACT format, with each field on its own line and the BODY at the end:
TITLE: <compelling, authoritative, insightful title under 60 characters. Avoid generic "Learn How" clichés>
SLUG: <url-friendly slug>
FOCUS_KEYWORD: <primary SEO keyword>
META_DESCRIPTION: <150-160 character meta description>
EXCERPT: <1-2 sentence compelling summary of the core insight>
SOCIAL_POST: <a complete, high-engagement social media post. NO conversational preamble (DO NOT say "Here is a post:", DO NOT say "**LinkedIn Post:**"). DO NOT use markdown bold like **text**. Must start directly with 🚀 Hook, include 🔹 bullets on separate lines, 💡 insight, ⚡ formula, 👇 question CTA, and hashtags #Tag1 #Tag2>
TAGS: <comma-separated list of 5-7 tags>
BODY: <comprehensive, human, authoritative HTML content of at least 1000 words. Do not write generic tutorial filler or cliché AI introductions like "In today's fast-paced digital world". Use one <h1>, clear <h2> and <h3> subheadings, practical real-world workflow breakdowns, comparison tables or bullet lists, actionable takeaways, and a strong conclusion. Format with clean HTML semantic tags only.>

Do not add explanations, notes, or sections outside this format.`;
  const user = `Write an authoritative, high-value, comprehensive blog post and matching high-engagement social post about: ${topic}`;

  const raw = await callTextApi([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], 3000, env);

  const fields = {
    title: /^TITLE:\s*(.+?)$/im,
    slug: /^SLUG:\s*(.+?)$/im,
    focusKeyword: /^FOCUS_KEYWORD:\s*(.+?)$/im,
    metaDescription: /^META_DESCRIPTION:\s*(.+?)$/im,
    excerpt: /^EXCERPT:\s*(.+?)$/im,
    socialPost: /^SOCIAL_POST:\s*([\s\S]+?)(?=\n(?:TAGS|BODY):\s*)/im,
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
  parsed.socialPost = cleanSocialPost(parsed.socialPost.replace(/^(SOCIAL_POST|Social_Post|social_post):\s*/i, ''));
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
  const prompt = `Write a viral, high-engagement social media post for LinkedIn, Facebook, and Instagram about: "${title}".

Core Context: ${summary}

CRITICAL RULES:
1. Output ONLY the raw post content. NO conversational preamble (DO NOT say "Here is a post...", "Here are three posts...", or "**LinkedIn Post:**").
2. DO NOT use markdown bold syntax like **text**. Social media platforms do not render markdown asterisks. Write clean plain text with emojis.
3. Every 🔹 bullet item MUST be on its own line with a blank line between items.
4. Avoid generic AI clichés like "In today's digital landscape, having a website is no longer a luxury...". Start with genuine excitement, fresh perspective, or a compelling insight.

Follow this EXACT format and spacing:

🚀 [Compelling Hook Headline with Emoji]

[1-2 sentence enthusiastic opening insight with emojis, e.g. 💻✨]

🔹 [First Pillar / Tool] — [Clear, punchy explanation with emoji]

🔹 [Second Pillar / Tool] — [Clear, punchy explanation with emoji]

🔹 [Third Pillar / Tool] — [Clear, punchy explanation with emoji]

💡 The real advantage isn't [common misconception]. It's [the actual solution/combination].

[Tool A] + [Tool B] = [Benefit 1] → [Benefit 2] → [Ultimate Result] ⚡

[1-2 practical sentences explaining how to execute the workflow without starting from a blank page.]

🌐 The future of [topic] isn't [old way]. It's about [smart modern way].

[Conversational engaging question to drive comments]? 👇

#[Tag1] #[Tag2] #[Tag3] #[Tag4] #[Tag5] #[Tag6] #[Tag7] #[Tag8]`;

  const raw = await callTextApi([
    { role: 'system', content: 'You write publication-ready, scroll-stopping social media posts. You NEVER output conversational preamble, platform labels, or markdown asterisks (**).' },
    { role: 'user', content: prompt },
  ], 1200, env);

  return cleanSocialPost(raw.replace(/<[^>]+>/g, ''));
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

function getUnsplashQueries(topic, niche) {
  const stopwords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
    'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
    'will', 'with', 'how', 'why', 'what', 'when', 'which', 'your', 'my', 'their',
    'best', 'guide', 'mastering', 'unlocking', 'building', 'step', 'steps',
    'testing', 'review', 'vs', 'versus', 'easy', 'simple', 'fast', 'complete',
    'ultimate', 'top', 'new', 'latest', 'using', 'way', 'ways', 'tips', 'tricks',
    'tutorial', 'introduction', 'deep', 'dive', 'hands', 'on'
  ]);

  const cleanWords = (topic || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));

  const queries = [];

  if (cleanWords.length >= 2) {
    queries.push(cleanWords.slice(0, 3).join(' '));
  }
  if (cleanWords.length >= 1) {
    queries.push(`${cleanWords[0]} technology`);
    queries.push(`${cleanWords[0]} workspace`);
  }

  const nicheLower = (niche || '').toLowerCase();
  if (nicheLower.includes('wordpress') || nicheLower.includes('web') || nicheLower.includes('code')) {
    queries.push('web development coding', 'minimalist workspace laptop', 'software programming screen', 'clean desk computer');
  } else if (nicheLower.includes('ai') || nicheLower.includes('intelligence') || nicheLower.includes('data')) {
    queries.push('artificial intelligence technology', 'modern server room data', 'digital futuristic abstract', 'minimalist technology');
  } else {
    queries.push('modern technology workspace', 'clean minimal office desk', 'digital technology abstract');
  }

  queries.push('minimalist workspace desk', 'modern tech office setup', 'abstract digital technology');
  return Array.from(new Set(queries.filter(Boolean)));
}

async function fetchUnsplashImage(queries, accessKey) {
  const queryList = Array.isArray(queries) ? queries : [queries];
  for (const q of queryList) {
    const encoded = encodeURIComponent(q);
    try {
      const searchRes = await fetch(`https://api.unsplash.com/search/photos?query=${encoded}&per_page=5&orientation=landscape&client_id=${accessKey}`);
      if (!searchRes.ok) continue;
      const data = await searchRes.json();
      if (!data.results?.length) continue;

      for (const result of data.results) {
        const imageUrl = `${result.urls.regular}&w=1200&h=675&fit=crop`;
        const imgRes = await fetch(imageUrl);
        if (imgRes.ok) {
          const blob = await imgRes.blob();
          return { blob, ext: 'jpeg', contentType: blob.type || 'image/jpeg' };
        }
      }
    } catch (e) {
      console.log(`Unsplash query "${q}" failed:`, e.message);
    }
  }
  throw new Error('Could not fetch any Unsplash image from candidate queries');
}

function buildAIVisualPrompt(topic, niche) {
  const nicheLower = (niche || '').toLowerCase();
  let subject = 'sleek minimalist 3D geometric glass forms and subtle glowing fiber optic lines in dark studio';

  if (nicheLower.includes('wordpress') || nicheLower.includes('web') || nicheLower.includes('code')) {
    subject = 'aesthetic modern designer workspace, clean wooden desk, glowing ambient soft monitor light, architectural minimalism, 35mm photography, shallow depth of field';
  } else if (nicheLower.includes('ai') || nicheLower.includes('intelligence') || nicheLower.includes('data')) {
    subject = 'futuristic translucent glass spheres floating in dark architectural space with soft cinematic neon rim lighting, octane 3d render';
  }

  return `Cinematic high-end commercial photograph of ${subject}, ultra-clean composition, Hasselblad medium format, award winning lighting, completely blank surfaces, pristine, photorealistic, no text, no words, no letters, no typography, no captions, no signs, no logos, no watermarks, no writing.`;
}

async function generateImage({ topic, niche }, env) {
  const prompt = buildAIVisualPrompt(topic, niche);
  const googleKey = env.GOOGLE_API_KEY || env.GEMINI_API_KEY || env.IMAGE_API_KEY || (env.TEXT_API_URL?.includes('googleapis.com') ? env.TEXT_API_KEY : null);

  if (googleKey) {
    const imagenModels = Array.from(new Set([
      env.IMAGE_MODEL,
      env.FALLBACK_IMAGE_MODEL,
      'imagen-3.0-generate-002',
      'imagen-3.0-fast-generate-001',
    ].filter(Boolean)));

    for (const model of imagenModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${encodeURIComponent(googleKey)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: {
              sampleCount: 1,
              aspectRatio: '16:9',
              outputOptions: { mimeType: 'image/jpeg' },
              personGeneration: 'ALLOW_ADULT',
              safetySetting: 'block_medium_and_above',
            },
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const b64 = data.predictions?.[0]?.bytesBase64Encoded;
          if (b64) {
            const mimeType = data.predictions[0].mimeType || 'image/jpeg';
            const ext = mimeType.includes('png') ? 'png' : 'jpeg';
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const blob = new Blob([bytes], { type: mimeType });
            return { blob, ext, contentType: mimeType };
          }
        } else {
          const errText = await res.text();
          console.log(`Google Imagen (${model}) failed (${res.status}):`, errText);
        }
      } catch (err) {
        console.log(`Google Imagen (${model}) exception:`, err.message);
      }
    }
  }

  if (env.AI) {
    try {
      const result = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt });
      const b64 = result.image;
      if (typeof b64 === 'string' && b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        return { blob, ext: 'jpeg', contentType: 'image/jpeg' };
      }
    } catch (e) {
      if (e.message?.includes('8007') || e.message?.includes('NSFW')) {
        console.log('Cloudflare AI rejected the image as unsafe');
      } else {
        console.log('Cloudflare AI failed:', e.message);
      }
    }
  }

  if (env.UNSPLASH_ACCESS_KEY) {
    try {
      const queries = getUnsplashQueries(topic, niche);
      return await fetchUnsplashImage(queries, env.UNSPLASH_ACCESS_KEY);
    } catch (e) {
      console.log('Unsplash failed:', e.message);
    }
  }

  throw new Error('Image generation failed. Configure Google Imagen (GOOGLE_API_KEY), Cloudflare Workers AI ([ai] binding), or UNSPLASH_ACCESS_KEY.');
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

function buildSocialPostText(text) {
  let content = (text.socialPost || '').trim();
  if (!content) {
    content = `${text.title}\n\n${text.excerpt || ''}`;
  }
  if (!content.includes('#') && text.tags?.length) {
    const hashtags = formatHashtags(text.tags);
    if (hashtags) content += `\n\n${hashtags}`;
  }
  return content;
}

async function postToLinkedIn({ text, env, media }) {
  const token = env.LINKEDIN_ACCESS_TOKEN;
  if (!token) {
    throw new Error('LINKEDIN_ACCESS_TOKEN not set. Add it with wrangler secret put.');
  }

  const author = await getLinkedInAuthor(token, env);
  const shareText = buildSocialPostText(text);

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

  const caption = buildSocialPostText(text);
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
  const message = buildSocialPostText(text);
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

async function hashPassword(password) {
  const buf = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
  for (const pair of cookieHeader.split(';')) {
    const [key, ...value] = pair.split('=');
    if (key && key.trim() === name) {
      return value.join('=').trim();
    }
  }
  return null;
}

async function isAuthenticated(request, env) {
  if (!env.DASHBOARD_PASSWORD) return true;
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === env.DASHBOARD_PASSWORD) return true;
  }
  const apiKeyHeader = request.headers.get('x-api-key') || '';
  if (apiKeyHeader && apiKeyHeader === env.DASHBOARD_PASSWORD) return true;

  const expected = await hashPassword(env.DASHBOARD_PASSWORD);
  const cookieToken = getCookie(request, 'dashboard-auth');
  return cookieToken === expected;
}

function loginHtml(error = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auto-poster Login</title>
  <style>
    :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --muted: #94a3b8; --accent: #38bdf8; --danger: #f87171; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
    .container { max-width: 360px; margin: 8rem auto; padding: 2rem; }
    .card { background: var(--card); border-radius: 0.75rem; padding: 1.5rem; }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    label { display: block; margin: 1rem 0 0.25rem; font-size: 0.85rem; color: var(--muted); }
    input { width: 100%; padding: 0.6rem; border: 1px solid #334155; border-radius: 0.5rem; background: #0f172a; color: var(--text); }
    button { width: 100%; margin-top: 1rem; background: var(--accent); color: #0f172a; border: 0; padding: 0.65rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; }
    .error { color: var(--danger); margin-top: 0.75rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Auto-poster Login</h1>
      <form method="POST" action="/login">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autofocus>
        <button type="submit">Sign in</button>
        ${error ? `<p class="error">${error}</p>` : ''}
      </form>
    </div>
  </div>
</body>
</html>`;
}

function dashboardHtml(env) {
  const schedules = [
    { time: '0 8 * * 1,4', action: 'WordPress long-form post' },
    { time: '0 10 * * *', action: 'Social post (LinkedIn, Facebook, Instagram)' },
    { time: '0 18 * * *', action: 'Social post (LinkedIn, Facebook, Instagram)' },
  ];

  const schedulesHtml = schedules.map(s => `<li><code>${s.time}</code> — ${s.action}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auto-poster Dashboard</title>
  <style>
    :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --muted: #94a3b8; --accent: #38bdf8; --danger: #f87171; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; max-width: 760px; margin: 0 auto; padding: 2rem 2rem 0; }
    .logout { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    .container { max-width: 760px; margin: 0 auto; padding: 1rem 2rem 2rem; }
    h1 { font-size: 1.75rem; margin: 0 0 0.25rem; }
    .subtitle { color: var(--muted); margin-bottom: 1.5rem; }
    .grid { display: grid; gap: 1.25rem; }
    .card { background: var(--card); border-radius: 0.75rem; padding: 1.25rem; }
    .card h2 { font-size: 1.1rem; margin: 0 0 0.75rem; color: var(--accent); }
    label { display: block; margin: 0.75rem 0 0.25rem; font-size: 0.9rem; color: var(--muted); }
    input, select, textarea { width: 100%; padding: 0.6rem 0.75rem; border: 1px solid #334155; border-radius: 0.5rem; background: #0f172a; color: var(--text); font-size: 0.95rem; }
    textarea { min-height: 100px; resize: vertical; }
    .checkboxes { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.5rem; }
    .checkboxes label { display: inline-flex; align-items: center; gap: 0.4rem; margin: 0; color: var(--text); }
    button { background: var(--accent); color: #0f172a; border: 0; padding: 0.65rem 1.25rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    pre { background: #0f172a; border: 1px solid #334155; border-radius: 0.5rem; padding: 1rem; overflow: auto; font-size: 0.85rem; color: var(--text); }
    .error { color: var(--danger); }
    .success { color: #34d399; }
    ul { margin: 0; padding-left: 1.25rem; color: var(--muted); }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Auto-poster</h1>
      <p class="subtitle">WordPress + LinkedIn + Facebook + Instagram automation</p>
    </div>
    <a class="logout" href="/logout">Logout</a>
  </div>
  <div class="container">

    <div class="grid">
      <div class="card">
        <h2>Current config</h2>
        <ul>
          <li>Text provider: <strong>${(env.TEXT_API_URL?.includes('googleapis.com') || env.GOOGLE_API_KEY || env.GEMINI_API_KEY) ? 'Google Gemini' : (env.TEXT_API_URL?.includes('openrouter.ai') ? 'OpenRouter' : (env.TEXT_API_URL?.includes('groq.com') ? 'Groq' : 'Custom'))}</strong></li>
          <li>Primary model: <code>${env.TEXT_MODEL || 'gemini-2.5-flash'}</code></li>
          <li>Image source: <strong>Google Imagen 3 &rarr; Cloudflare Workers AI &rarr; Unsplash</strong></li>
          <li>Notification email: ${env.NOTIFICATION_EMAIL || '—'}</li>
        </ul>
      </div>

      <div class="card">
        <h2>Scheduled posting</h2>
        <ul>${schedulesHtml}</ul>
      </div>

      <div class="card">
        <h2>Manual post</h2>
        <form id="postForm">
          <label for="topic">Topic</label>
          <input type="text" id="topic" name="topic" required placeholder="e.g. How AI speeds up WordPress workflows">

          <label for="niche">Niche</label>
          <input type="text" id="niche" name="niche" value="AI and WordPress development">

          <label>Platforms</label>
          <div class="checkboxes">
            <label><input type="checkbox" name="platforms" value="wordpress" checked> WordPress</label>
            <label><input type="checkbox" name="platforms" value="linkedin" checked> LinkedIn</label>
            <label><input type="checkbox" name="platforms" value="facebook" checked> Facebook</label>
            <label><input type="checkbox" name="platforms" value="instagram" checked> Instagram</label>
          </div>

          <label for="wpStatus">WordPress status</label>
          <select id="wpStatus" name="wpStatus">
            <option value="draft" selected>Draft</option>
            <option value="publish">Publish</option>
          </select>

          <p style="margin-top:1rem"><button type="submit" id="submitBtn">Run now</button></p>
        </form>
        <div id="result"></div>
      </div>
    </div>
  </div>

  <script>
    document.getElementById('postForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const result = document.getElementById('result');
      btn.disabled = true;
      btn.textContent = 'Running...';
      result.innerHTML = '';

      const form = e.target;
      const platforms = Array.from(form.querySelectorAll('input[name="platforms"]:checked')).map(cb => cb.value);
      const body = {
        topic: form.topic.value,
        niche: form.niche.value,
        platforms,
        wp: { status: form.wpStatus.value }
      };

      try {
        const res = await fetch('/', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        const statusClass = res.ok ? 'success' : 'error';
        const statusText = res.ok ? 'Success' : 'Error';
        result.innerHTML = '<p class="' + statusClass + '">' + statusText + ' (' + res.status + ')</p><pre>' + JSON.stringify(data, null, 2) + '</pre>';
      } catch (err) {
        result.innerHTML = '<p class="error">Network error: ' + err.message + '</p>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run now';
      }
    });
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/login') {
      if (request.method !== 'POST') {
        return new Response(loginHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      const form = await request.formData();
      const password = form.get('password') || '';
      if (env.DASHBOARD_PASSWORD && password !== env.DASHBOARD_PASSWORD) {
        return new Response(loginHtml('Invalid password'), { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 401 });
      }
      const token = await hashPassword(env.DASHBOARD_PASSWORD || '');
      const headers = new Headers({
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `dashboard-auth=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      });
      headers.append('location', '/');
      return new Response('', { status: 302, headers });
    }

    if (url.pathname === '/logout') {
      const headers = new Headers({
        'set-cookie': 'dashboard-auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
      });
      headers.append('location', '/');
      return new Response('', { status: 302, headers });
    }

    if ((url.pathname === '/' || url.pathname === '/dashboard') && request.method === 'GET') {
      if (!(await isAuthenticated(request, env))) {
        return new Response(loginHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response(dashboardHtml(env), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

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

    if (!(await isAuthenticated(request, env))) {
      return jsonResponse({ error: 'Authentication required' }, 401);
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

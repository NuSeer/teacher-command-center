// Reads a photo of a class roster (Roster Import -> Photo / AI) using the AI keys that are
// already stored on this Vercel project — GEMINI_API_KEY first, GROQ_API_KEY as the fallback.
// The browser never sees a key: it sends its Firebase ID token plus the image, this function
// verifies the token (so only signed-in teachers can spend the quota), then calls the provider's
// OpenAI-compatible chat endpoint with the image attached.
//
// Optional env overrides: GEMINI_MODEL, GROQ_VISION_MODEL.
const { initializeApp, getApps, cert } = require('firebase-admin/app');

function ensureApp() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
}

// Ordered attempts: each entry is one provider + model. A model that is retired or rate-limited
// just falls through to the next one instead of failing the whole request.
function attempts() {
  const list = [];
  const add = (name, key, url, models) => {
    const seen = {};
    models.filter(Boolean).forEach((model) => {
      if (!seen[model]) { seen[model] = 1; list.push({ name, key, url, model }); }
    });
  };
  const gemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (gemini) {
    add('gemini', gemini, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash']);
  }
  if (process.env.GROQ_API_KEY) {
    add('groq', process.env.GROQ_API_KEY, 'https://api.groq.com/openai/v1/chat/completions',
      [process.env.GROQ_VISION_MODEL, 'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct']);
  }
  return list;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'unauthorized' }); return; }
  try {
    // Loaded here (not at the top) so a problem loading the auth module is reported instead of crashing the function.
    const { getAuth } = require('firebase-admin/auth');
    ensureApp();
    await getAuth().verifyIdToken(token);
  } catch (e) {
    const bad = e && /id-token|argument-error|expired|invalid|malformed|decoding/i.test(String(e.code || '') + ' ' + String(e.message || ''));
    if (!bad) console.error('roster-ai auth check failed', e && e.message);
    res.status(bad ? 401 : 500).json(bad ? { error: 'unauthorized' } : { error: 'auth_unavailable', detail: String((e && (e.code || e.message)) || e).slice(0, 120) });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const image = body.image, mime = body.mime, prompt = body.prompt;
  if (!image || !prompt || !/^image\/(png|jpe?g|webp|gif)$/i.test(mime || '')) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  if (image.length > 5500000) { res.status(413).json({ error: 'too_large' }); return; }

  const tries = attempts();
  if (!tries.length) { res.status(503).json({ error: 'not_configured' }); return; }

  let last = null;
  for (const t of tries) {
    try {
      const r = await fetch(t.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.key },
        body: JSON.stringify({
          model: t.model,
          max_tokens: 4000,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + image } },
            ],
          }],
        }),
      });
      const data = await r.json().catch(() => ({}));
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (r.ok && text) { res.status(200).json({ text, provider: t.name, model: t.model }); return; }
      last = { provider: t.name, model: t.model, status: r.status, detail: JSON.stringify(data).slice(0, 300) };
    } catch (e) {
      last = { provider: t.name, model: t.model, status: 0, detail: String((e && e.message) || e).slice(0, 200) };
    }
  }
  console.error('roster-ai: every provider attempt failed', last);
  res.status(502).json({ error: 'provider_error', status: last && last.status, provider: last && last.provider });
};

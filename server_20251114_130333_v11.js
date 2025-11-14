
/**
 * Realtime translator + chunk transcription backend (WebAudio WAV)
 * File: server_20251114__130333_v11.js
 * Version: v1.9.0
 * BuiltAt: 2025-11-14T13:03:33+00:00 (JST)
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Body limits: audio chunks can be large
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(cors());

// Static files (frontend UI lives in ./public)
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

const SERVER_META = Object.freeze({
  file: "server_20251114__130333_v11.js",
  version: "v1.9.0",
  builtAt: "2025-11-14T13:03:33+00:00",
});

if (!OPENAI_API_KEY) {
  console.warn("[server] WARNING: OPENAI_API_KEY is not set - API calls will fail.");
}

// -----------------------------------------------------------------------------
// Model config (from .env)
// -----------------------------------------------------------------------------

const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime-mini";
const VOICE = process.env.REALTIME_VOICE || "alloy";

// ASR (audio → text)
const TRANSCRIBE_PRIMARY_MODEL =
  process.env.TRANSCRIBE_PRIMARY_MODEL ||
  process.env.TRANSCRIBE_MODEL ||
  "gpt-4o-mini-transcribe";

const TRANSCRIBE_FALLBACK_MODEL =
  process.env.TRANSCRIBE_FALLBACK_MODEL || "gpt-4o-transcribe";

// "auto" lets the model detect language
const TRANSCRIBE_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE || "auto";

// Per‑chunk translation / segmentation
const SEGMENT_MODEL = process.env.EN_SEGMENT_MODEL || "gpt-5-nano";

// Recap (running summary)
const RECAP_MODEL = process.env.RECAP_MODEL || "gpt-5-nano";
const RECAP_FALLBACK_MODEL = process.env.RECAP_FALLBACK_MODEL || RECAP_MODEL;

// How much history to feed into recap (characters from end)
const RECAP_MAX_CHARS = Number(process.env.RECAP_MAX_CHARS || "4000");

// Default output language for translation / recap
const OUTPUT_LANG_DEFAULT = (process.env.OUTPUT_LANG || "ja").toLowerCase();

const OUTPUT_LANGS = {
  en: { code: "en", ui: "EN", name: "English" },
  ja: { code: "ja", ui: "JP", name: "Japanese" },
  zh: { code: "zh", ui: "CN", name: "Chinese" },
  fr: { code: "fr", ui: "FR", name: "French" },
  es: { code: "es", ui: "ES", name: "Spanish" },
};

function resolveOutputLang(raw) {
  if (!raw) {
    return OUTPUT_LANGS[OUTPUT_LANG_DEFAULT] || OUTPUT_LANGS.ja || OUTPUT_LANGS.en;
  }
  const s = String(raw).trim().toLowerCase();
  if (OUTPUT_LANGS[s]) return OUTPUT_LANGS[s];
  if (["jp", "ja-jp", "japanese", "日本語"].includes(s)) return OUTPUT_LANGS.ja;
  if (["en", "en-us", "en-gb", "english"].includes(s)) return OUTPUT_LANGS.en;
  if (["cn", "zh", "zh-cn", "chinese", "中文"].includes(s)) return OUTPUT_LANGS.zh;
  if (["fr", "fra", "french", "français"].includes(s)) return OUTPUT_LANGS.fr;
  if (["es", "spa", "spanish", "español"].includes(s)) return OUTPUT_LANGS.es;
  return OUTPUT_LANGS[OUTPUT_LANG_DEFAULT] || OUTPUT_LANGS.ja || OUTPUT_LANGS.en;
}

// -----------------------------------------------------------------------------
// Session store (in‑memory; reset when server restarts)
// -----------------------------------------------------------------------------

const sessions = new Map();

function createSessionId() {
  return "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function getOrCreateSession(sessionId) {
  let id = sessionId;
  if (!id || typeof id !== "string" || !sessions.has(id)) {
    id = createSessionId();
  }
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      createdAt: new Date().toISOString(),
      segments: [],
      lastRecap: null,
    };
    sessions.set(id, s);
  }
  return s;
}

// -----------------------------------------------------------------------------
// Helpers: audio decode + OpenAI calls
// -----------------------------------------------------------------------------

/**
 * Accepts either a pure base64 string or a data: URL.
 * Returns a Node Buffer and a resolved mimeType.
 */
function decodeAudioBase64(audioBase64, mimeType) {
  if (typeof audioBase64 !== "string" || !audioBase64.length) {
    throw new Error("audioBase64 is empty");
  }

  let b64 = audioBase64;
  let mt = (mimeType && String(mimeType).trim()) || "audio/wav";

  // data URL pattern: data:audio/wav;base64,xxxx
  if (audioBase64.startsWith("data:")) {
    const commaIndex = audioBase64.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Invalid data URL for audioBase64 (no comma)");
    }
    const header = audioBase64.substring(5, commaIndex);
    b64 = audioBase64.substring(commaIndex + 1);
    const semiParts = header.split(";"); // ["audio/wav", "base64"]
    if (semiParts[0]) mt = semiParts[0];
    console.log("[decodeAudioBase64]", {
      header,
      mimeTypeResolved: mt,
      b64Len: b64.length,
    });
  }

  const buf = Buffer.from(b64, "base64");
  if (!buf.length) {
    throw new Error("Decoded audio buffer is empty");
  }
  return { buffer: buf, mimeType: mt };
}

/**
 * Single call to /v1/audio/transcriptions
 */
async function callTranscriptionOnce({ model, audioBase64, mimeType, language }) {
  const { buffer, mimeType: mt } = decodeAudioBase64(audioBase64, mimeType);

  // Node 18+ has Blob/FormData via undici
  const blob = new Blob([buffer], { type: mt || "audio/wav" });
  const fd = new FormData();
  const filename = mt && mt.includes("wav") ? "chunk.wav" : "chunk.webm";
  fd.append("file", blob, filename);
  fd.append("model", model);
  fd.append("response_format", "json");
  if (language && language !== "auto") {
    fd.append("language", language);
  }

  console.log("[callTranscriptionOnce]", {
    model,
    mime: mt,
    bytes: buffer.length,
  });

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: fd,
  });

  const bodyText = await resp.text();
  let jr;
  try {
    jr = JSON.parse(bodyText);
  } catch {
    jr = undefined;
  }

  if (!resp.ok) {
    console.error("[callTranscriptionOnce][ERROR]", {
      status: resp.status,
      bodySnippet: bodyText.slice(0, 500),
    });
  }

  return { ok: resp.ok, status: resp.status, jr, bodyText };
}

/**
 * Primary + fallback ASR
 */
async function transcribeWithFallback(audioBase64, mimeType, language) {
  let usedModel = TRANSCRIBE_PRIMARY_MODEL;
  let result = await callTranscriptionOnce({
    model: TRANSCRIBE_PRIMARY_MODEL,
    audioBase64,
    mimeType,
    language,
  });
  let fallbackTried = false;

  if (
    !result.ok &&
    TRANSCRIBE_FALLBACK_MODEL &&
    TRANSCRIBE_FALLBACK_MODEL !== TRANSCRIBE_PRIMARY_MODEL
  ) {
    console.error("[transcribeWithFallback] primary failed:", {
      status: result.status,
      bodySnippet: (result.bodyText || "").slice(0, 300),
    });
    fallbackTried = true;
    usedModel = TRANSCRIBE_FALLBACK_MODEL;
    result = await callTranscriptionOnce({
      model: TRANSCRIBE_FALLBACK_MODEL,
      audioBase64,
      mimeType,
      language,
    });
  }

  if (!result.ok) {
    const msg =
      (result.jr && result.jr.error && result.jr.error.message) ||
      result.bodyText ||
      `Transcription failed with status ${result.status}`;
    const err = new Error(msg);
    err.status = result.status || 500;
    err.model = usedModel;
    err.fallbackTried = fallbackTried;
    err.bodyText = result.bodyText;
    throw err;
  }

  const text = (result.jr && result.jr.text) || "";
  return { text, model: usedModel, raw: result.jr || null };
}

// -------------------------- Responses API helpers ----------------------------

/**
 * Thin wrapper around /v1/responses.
 * For GPT‑5 family we force:
 *   reasoning.effort = "minimal"
 *   text.verbosity   = "low"
 * to keep output as short, concrete text (no long reasoning).
 */
async function callResponsesOnce({ model, system, user, maxTokens }) {
  const messages = [];
  if (system) {
    messages.push({
      role: "system",
      content: [{ type: "input_text", text: system }],
    });
  }
  if (user) {
    messages.push({
      role: "user",
      content: [{ type: "input_text", text: user }],
    });
  }

  const isGpt5 = typeof model === "string" && model.startsWith("gpt-5");

  const payload = {
    model,
    input: messages.length ? messages : user || system || "",
    max_output_tokens: maxTokens || 256,
  };

  if (isGpt5) {
    payload.reasoning = { effort: "minimal" };
    payload.text = { verbosity: "low" };
  }

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await resp.text();
  let jr;
  try {
    jr = JSON.parse(bodyText);
  } catch {
    jr = undefined;
  }

  if (!resp.ok) {
    console.error("[callResponsesOnce][ERROR]", {
      model,
      status: resp.status,
      bodySnippet: bodyText.slice(0, 500),
    });
  } else {
    const usage = jr && jr.usage
      ? {
          out: jr.usage.output_tokens,
          reason:
            jr.usage.output_tokens_details &&
            jr.usage.output_tokens_details.reasoning_tokens,
        }
      : null;
    console.log("[callResponsesOnce] OK", {
      model,
      status: resp.status,
      lenBodyText: bodyText.length,
      usage,
    });
  }

  return { ok: resp.ok, status: resp.status, jr, bodyText };
}

/**
 * Try to extract plain text from responses payload.
 * Supports:
 *  - jr.output_text
 *  - jr.output[].content[].text
 *  - jr.output[].content[].data.text
 */
function extractOutputText(jr) {
  if (!jr) return "";
  const parts = [];

  if (typeof jr.output_text === "string" && jr.output_text.trim()) {
    parts.push(jr.output_text.trim());
  }

  if (Array.isArray(jr.output)) {
    for (const item of jr.output) {
      const content = item && item.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (!c) continue;
        if (typeof c.text === "string" && c.text.trim()) {
          parts.push(c.text.trim());
        } else if (typeof c.output_text === "string" && c.output_text.trim()) {
          parts.push(c.output_text.trim());
        } else if (
          c.type === "output_text" &&
          c.data &&
          typeof c.data.text === "string" &&
          c.data.text.trim()
        ) {
          parts.push(c.data.text.trim());
        }
      }
    }
  }

  return parts.join(" ").trim();
}

// -------------------------- Translation prompt -------------------------------

function buildTranslationSystemPrompt(domainHints, outLangInfo) {
  const name = (outLangInfo && outLangInfo.name) || "English";
  const code = (outLangInfo && outLangInfo.code) || "en";

  let base =
    "You are a professional multilingual translator. " +
    "Your only task is to rewrite or translate the input into natural, fluent " +
    name +
    " (language code " +
    code +
    "). " +
    "The source text may contain multiple languages. " +
    "You must output only the final translated text, without any explanations, analysis, alternatives, romanization, or repetition of the source text. " +
    "Do not write meta commentary such as 'Let us parse', 'Likely', or 'This seems'. " +
    "Keep the length roughly similar to the source and do not add extra sentences beyond what is needed to express the same meaning.";

  if (Array.isArray(domainHints) && domainHints.length > 0) {
    base +=
      " The conversation domain is: " +
      domainHints.join(", ") +
      ". Use accurate domain-specific terminology where appropriate.";
  }

  return base;
}

async function translateToTarget(sourceText, domainHints, outLangInfo) {
  if (!sourceText || !sourceText.trim()) return "";

  const system = buildTranslationSystemPrompt(domainHints, outLangInfo);

  let result = await callResponsesOnce({
    model: SEGMENT_MODEL,
    system,
    user: sourceText,
    maxTokens: 256,
  });

  console.log("[translateToTarget] call status=", result.status, {
    lenInput: sourceText.length,
    lenBodyText: result.bodyText ? result.bodyText.length : 0,
  });

  let outText = extractOutputText(result.jr);

  // If empty or failed once, retry a single time with same model
  if (!result.ok || !outText) {
    console.warn(
      "[translateToTarget] empty or failed text, retrying once...",
      "status=",
      result.status
    );
    result = await callResponsesOnce({
      model: SEGMENT_MODEL,
      system,
      user: sourceText,
      maxTokens: 256,
    });
    outText = extractOutputText(result.jr);
  }

  if (!result.ok || !outText) {
    const msg =
      (result.jr && result.jr.error && result.jr.error.message) ||
      result.bodyText ||
      `Translation failed or empty with status ${result.status}`;
    const err = new Error(msg);
    err.status = result.status || 500;
    err.bodyText = result.bodyText;
    throw err;
  }

  console.log("[translateToTarget] final extractedLen=", outText.length, {
    preview: outText.slice(0, 80),
  });

  return outText;
}

// -------------------------- Recap prompt -------------------------------------

function buildRecapSystemPrompt(domainHints, outLangInfo) {
  const name = (outLangInfo && outLangInfo.name) || "English";
  const code = (outLangInfo && outLangInfo.code) || "en";

  let base = `
You are an expert meeting note taker.

Write the recap entirely in ${name} (language code ${code}).

Always follow this exact structure:

1. Overall summary
   - 1 paragraph ONLY.
   - If language is English: about 50–60 words.
   - If language is Japanese: about 100–120 characters.
   - No bullet points here.

2. Agenda list
   - Title line: "Agenda:"
   - Then 3–7 agenda items as a bullet list.
   - Each agenda item must be ONE short line.

3. Key points by agenda
   - Title line: "Key points by agenda:"
   - For each agenda item, create a sub-bullet with the same agenda title,
     and under it up to 3 bullet points with key decisions, questions,
     and action items.
   - Each bullet point must be one short sentence.

Global rules:
- The whole recap must fit roughly in one screen at 16px font, so keep all text concise.
- Do NOT add extra sections, explanations, or headings beyond the three sections above.
- Do NOT include analysis of language, translations, or meta commentary.
- Do NOT repeat the raw transcript.
`.trim();

  if (Array.isArray(domainHints) && domainHints.length > 0) {
    base += `
The discussion domain is: ${domainHints.join(", ")}.
Use appropriate specialist terminology for this domain.`;
  }

  return base;
}

async function buildRecapText(session, domainHints, outLangInfo) {
  if (!session || !Array.isArray(session.segments) || session.segments.length === 0) {
    return "";
  }

  const parts = [];
  for (const seg of session.segments) {
    if (seg && typeof seg.sourceText === "string") {
      parts.push(seg.sourceText);
    }
  }
  let text = parts.join("\n");
  if (text.length > RECAP_MAX_CHARS) {
    // keep most recent context
    text = text.slice(-RECAP_MAX_CHARS);
  }

  const system = buildRecapSystemPrompt(domainHints, outLangInfo);

  let result = await callResponsesOnce({
    model: RECAP_MODEL,
    system,
    user: text,
    maxTokens: 768,
  });

  console.log("[buildRecapText] call status=", result.status, {
    lenInput: text.length,
    lenBodyText: result.bodyText ? result.bodyText.length : 0,
  });

  let recapText = extractOutputText(result.jr);

  // Retry once with fallback model
  if (!result.ok || !recapText) {
    console.warn(
      "[buildRecapText] empty or failed text, retrying once...",
      "status=",
      result.status
    );
    result = await callResponsesOnce({
      model: RECAP_FALLBACK_MODEL,
      system,
      user: text,
      maxTokens: 768,
    });
    recapText = extractOutputText(result.jr);
  }

  if (!result.ok || !recapText) {
    const msg =
      (result.jr && result.jr.error && result.jr.error.message) ||
      result.bodyText ||
      `Recap failed or empty with status ${result.status}`;
    const err = new Error(msg);
    err.status = result.status || 500;
    err.bodyText = result.bodyText;
    throw err;
  }

  return recapText;
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/**
 * Simple session bootstrap + config for frontend
 */
app.get("/session", (req, res) => {
  try {
    const s = getOrCreateSession(null);
    const outLangInfo = resolveOutputLang(OUTPUT_LANG_DEFAULT);
    res.json({
      ok: true,
      sessionId: s.id,
      transcription: {
        model: TRANSCRIBE_PRIMARY_MODEL,
        fallback_model: TRANSCRIBE_FALLBACK_MODEL,
        language: TRANSCRIBE_LANGUAGE,
      },
      translation: {
        model: SEGMENT_MODEL,
        default_output_lang: outLangInfo.code,
      },
      recap: {
        model: RECAP_MODEL,
        fallback_model: RECAP_FALLBACK_MODEL,
        max_chars: RECAP_MAX_CHARS,
      },
      realtime: {
        model: REALTIME_MODEL,
        voice: VOICE,
      },
      server: SERVER_META,
    });
  } catch (err) {
    console.error("/session ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "Internal error in /session",
      detail: String(err.message || err),
    });
  }
});

/**
 * Main streaming endpoint: one audio chunk → ASR → translation
 */
app.post("/transcribe-chunk", async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId;
  const chunkId = body.chunkId;
  const audioBase64 = body.audioBase64;
  const mimeType = body.mimeType || "audio/wav";
  const isLast = !!body.isLast;
  const languageHint = body.languageHint || TRANSCRIBE_LANGUAGE || "auto";
  const domainHints = Array.isArray(body.domainHints) ? body.domainHints : [];
  const targetLangRaw = body.targetLang;
  const outLangInfo = resolveOutputLang(targetLangRaw);
  const outLang = outLangInfo.code;
  const session = getOrCreateSession(sessionId);

  console.log("[/transcribe-chunk] req", {
    session: session.id,
    chunkId,
    asrLang: languageHint,
    outLang,
    audioBase64Len: audioBase64 ? audioBase64.length : 0,
    mimeType,
  });

  const t0 = Date.now();

  try {
    if (!audioBase64) {
      throw new Error("audioBase64 is required");
    }

    const transcribed = await transcribeWithFallback(
      audioBase64,
      mimeType,
      languageHint
    );
    const t1 = Date.now();

    const sourceText = transcribed.text || "";
    const translatedText = await translateToTarget(
      sourceText,
      domainHints,
      outLangInfo
    );
    const t2 = Date.now();

    const seg = {
      id: "seg_" + Date.now().toString(36) + "_" + (chunkId || 0),
      chunkId: chunkId || 0,
      sourceText,
      translatedText,
      outputLang: outLangInfo.code,
      createdAt: new Date().toISOString(),
    };

    session.segments.push(seg);

    console.log("[/transcribe-chunk] done", {
      session: session.id,
      chunkId,
      model: transcribed.model,
      durTranscribeMs: t1 - t0,
      durTranslateMs: t2 - t1,
      extractedLen: seg.translatedText.length,
    });

    res.json({
      ok: true,
      sessionId: session.id,
      segment: seg,
      meta: {
        isLast,
        asrModel: transcribed.model,
        asrLanguage: languageHint,
        targetLang: outLangInfo.code,
        targetLangName: outLangInfo.name,
      },
    });
  } catch (err) {
    console.error("/transcribe-chunk ERROR:", err);
    const status = (err && err.status) || 500;
    const bodySnippet =
      err && err.bodyText ? String(err.bodyText).slice(0, 500) : undefined;

    res.status(status).json({
      ok: false,
      error: "Internal error in /transcribe-chunk",
      detail: String(err.message || err),
      model: err.model || undefined,
      fallbackTried: !!err.fallbackTried,
      status,
      upstream: {
        status: err && err.status != null ? err.status : null,
        bodySnippet,
      },
      requestInfo: {
        chunkId: chunkId || null,
        targetLang: targetLangRaw || null,
        mimeType: mimeType || null,
        hasAudioBase64: !!audioBase64,
        audioBase64Prefix:
          typeof audioBase64 === "string"
            ? audioBase64.slice(0, 32)
            : null,
      },
    });
  }
});

/**
 * Recap endpoint: summarizes all segments in the session
 */
app.post("/recap", async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId;
  const domainHints = Array.isArray(body.domainHints) ? body.domainHints : [];
  const targetLangRaw = body.targetLang;
  const outLangInfo = resolveOutputLang(targetLangRaw);

  try {
    const session = getOrCreateSession(sessionId);
    const recapText = await buildRecapText(session, domainHints, outLangInfo);
    const recapObj = {
      text: recapText,
      model: RECAP_MODEL,
      outputLang: outLangInfo.code,
      createdAt: new Date().toISOString(),
    };
    session.lastRecap = recapObj;

    res.json({
      ok: true,
      sessionId: session.id,
      recap: recapObj,
    });
  } catch (err) {
    console.error("/recap ERROR:", err);
    const status = (err && err.status) || 500;
    const bodySnippet =
      err && err.bodyText ? String(err.bodyText).slice(0, 500) : undefined;

    res.status(status).json({
      ok: false,
      error: "Internal error in /recap",
      detail: String(err.message || err),
      upstream: {
        status: err && err.status != null ? err.status : null,
        bodySnippet,
      },
    });
  }
});

/**
 * Simple health‑check
 */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    server: SERVER_META,
    time: new Date().toISOString(),
  });
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log("[server] Listening on http://localhost:" + PORT);
  console.log("[server] Meta:", SERVER_META);
});

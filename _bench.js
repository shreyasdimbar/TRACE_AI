require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const gen = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());

const SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" }, decision: { type: "STRING" },
    reasoning: { type: "STRING" }, tags: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["summary", "decision", "reasoning", "tags"],
};
const SAFETY = ["HARM_CATEGORY_HARASSMENT","HARM_CATEGORY_HATE_SPEECH","HARM_CATEGORY_SEXUALLY_EXPLICIT","HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map(c => ({ category: c, threshold: "BLOCK_ONLY_HIGH" }));
const PROMPT = [
  "You are the knowledge-extraction layer for an organisational memory system.",
  "Return a JSON object with exactly these keys:",
  "  summary    - one line, max 200 characters, describing what this content is about.",
  "  decision   - the specific decision that was made and who/what it affects.",
  '              If the content contains no decision at all, return the string "No decision".',
  "  reasoning  - why that decision was made, or the single most important insight.",
  "  tags       - 2 to 5 lowercase topical tags. No spaces, no duplicates.",
  "", "--- CONTENT ---",
  "Team sync 2026-09-29. Decision: we will standardise on PostgreSQL 17 for all new services. Reason: the current MySQL version is out of support and blocks the analytics migration. Owner: Sneha.",
].join("\n");

const MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite"];
const SAMPLES = 2;

(async () => {
  console.log("serve time on the REAL extraction workload (ms)\n");
  const results = [];
  for (const m of MODELS) {
    const times = []; let errs = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now();
      try {
        const r = await gen.getGenerativeModel({ model: m, safetySettings: SAFETY,
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024, responseMimeType: "application/json", responseSchema: SCHEMA },
        }).generateContent({ contents: [{ role: "user", parts: [{ text: PROMPT }] }] });
        const txt = (r.response?.candidates?.[0]?.content?.parts || []).map(p=>p.text||"").join("").trim();
        let ok = false; try { ok = !!JSON.parse(txt).decision; } catch {}
        times.push({ ms: Date.now()-t0, ok });
      } catch (e) {
        const msg = (e.message||"").replace(/\s+/g," ");
        const code = /429/.test(msg) ? "429 quota" : /503/.test(msg) ? "503 capacity" : /404/.test(msg) ? "404" : msg.slice(0,30);
        errs.push(code);
        times.push({ ms: Date.now()-t0, ok: false, code });
      }
    }
    const good = times.filter(t => t.ok).map(t => t.ms);
    const best = good.length ? Math.min(...good) : null;
    const avg  = good.length ? Math.round(good.reduce((a,b)=>a+b,0)/good.length) : null;
    results.push({ m, best, avg, errs, samples: good.length });
    const bs = best === null ? "   n/a" : String(best).padStart(7);
    const as = avg  === null ? "   n/a" : String(avg).padStart(7);
    console.log(`  ${m.padEnd(24)} best=${bs}  avg=${as}  ok=${good.length}/${SAMPLES}  ${errs.length ? "[" + [...new Set(errs)].join(",") + "]" : ""}`);
  }
  const ok = results.filter(r => r.best !== null).sort((a,b) => a.best - b.best);
  console.log("\nranked by best serve time:");
  ok.forEach((r,i) => console.log(`  ${i+1}. ${r.m.padEnd(24)} ${r.best}ms`));
  if (!ok.length) console.log("  (none succeeded in this window - Google capacity is saturated)");
})();

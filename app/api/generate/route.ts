// app/api/generate/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";

export const dynamic = "force-dynamic"; // make sure it's not cached during testing

// ---------- Types ----------
export interface Spec {
  width?: number;     // mm
  height?: number;    // mm
  depth?: number;     // mm (aka length)
  thickness?: number; // mm
  diameter?: number;  // mm (center hole)
  shape?: string;     // 'bracket' | 'plate' | ...
  material?: string;
  features?: string[];
  units?: string;     // 'mm'|'inch' (we normalize to mm)
}

interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
}

interface AIResponse {
  type: "code" | "questions" | "answer" | "nochange";
  spec?: Spec;
  content: string; // code or text
}

// ---------- Model ----------
const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ---------- Small utils ----------
const mmFromInches = (n: number) => n * 25.4;
const toNum = (s?: string) => {
  if (!s) return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};

// Robustly extract the freeform request the user typed (not your template).
function extractUserRequest(raw: string, history: ChatMsg[]): string {
  if (!raw) {
    const lastUser = [...history].reverse().find(m => m.role === "user");
    return (lastUser?.content || "").trim();
  }

  // Normalize newlines
  const text = raw.replace(/\r\n/g, "\n");

  // Primary: block after ### USER_REQUEST
  const header = /###\s*USER_REQUEST\s*?\n/i;
  const hdr = text.match(header);
  if (hdr) {
    const start = hdr.index! + hdr[0].length;
    // find next ### or end
    const after = text.slice(start);
    const nextHeaderIdx = after.search(/\n###\s*[A-Z_ ]+/i);
    const slice = nextHeaderIdx >= 0 ? after.slice(0, nextHeaderIdx) : after;
    const req = slice.trim();
    if (req) return req;
  }

  // Secondary: try to find fenced code and take the prose outside of it
  const noCode = text.replace(/```[\s\S]*?```/g, "").trim();
  if (noCode) {
    // take the last non-empty line as the request
    const lines = noCode.split("\n").map(l => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) return last;
  }

  // Last resort: last user message in history
  const lastUser = [...history].reverse().find(m => m.role === "user");
  return (lastUser?.content || "").trim();
}

// Heuristics: does it sound like a geometry change?
function looksLikeUpdate(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;

  // obvious “question” cues (we’ll keep updates if numeric/dims are present)
  const questionCue = /\b(what|how|why|can|should|could|ideas|improve|better)\b/;
  const hasQuestion = questionCue.test(t);

  // numbers + units or geometry verbs
  const unitOrDims = /(\d+(\.\d+)?)\s*(mm|cm|in|inch|")|(\d+(\.\d+)?\s*[x×]\s*\d+(\.\d+)?)/i;
  const geoWords = /\b(add|make|create|generate|remove|change|update|increase|decrease|hole|slot|fillet|chamfer|bracket|plate|cube|cylinder|difference|union)\b/;

  const hasDims = unitOrDims.test(t);
  const hasGeo = geoWords.test(t);

  // If it looks like geometry, treat as update even if it's phrased as a question
  return hasDims || hasGeo || (!hasQuestion && t.length > 0);
}

// Parse common dim patterns quickly
function parseDims(user: string): Partial<Spec> {
  const out: Partial<Spec> = {};
  const t = (user || "").toLowerCase().replace(/\s+/g, " ").trim();

  // 3" x 3" x 0.5"
  const inTriple = t.match(/(\d+(\.\d+)?)\s*(?:["]|in|inch(?:es)?)\s*[x×]\s*(\d+(\.\d+)?)\s*(?:["]|in|inch(?:es)?)\s*[x×]\s*(\d+(\.\d+)?)\s*(?:["]|in|inch(?:es)?)/i);
  if (inTriple) {
    const a = toNum(inTriple[1]);
    const b = toNum(inTriple[3]);
    const c = toNum(inTriple[5]);
    if (a && b && c) {
      out.width = mmFromInches(a);
      out.height = mmFromInches(b);
      out.thickness = mmFromInches(c);
      out.units = "mm";
      return out;
    }
  }

  // 76.2mm x 76.2mm x 12.7mm
  const mmTriple = t.match(/(\d+(\.\d+)?)\s*mm\s*[x×]\s*(\d+(\.\d+)?)\s*mm\s*[x×]\s*(\d+(\.\d+)?)\s*mm/i);
  if (mmTriple) {
    const a = toNum(mmTriple[1]);
    const b = toNum(mmTriple[3]);
    const c = toNum(mmTriple[5]);
    if (a && b && c) {
      out.width = a; out.height = b; out.thickness = c; out.units = "mm";
      return out;
    }
  }

  // “square plate 3 in”
  const sqIn = t.match(/(\d+(\.\d+)?)\s*(?:["]|in|inch(?:es)?)\s*(square|plate|bracket)/);
  if (sqIn) {
    const v = mmFromInches(parseFloat(sqIn[1]));
    out.width = v; out.height = v; out.units = "mm";
  }
  const sqMm = t.match(/(\d+(\.\d+)?)\s*mm\s*(square|plate|bracket)/);
  if (sqMm) {
    const v = parseFloat(sqMm[1]);
    out.width = v; out.height = v; out.units = "mm";
  }

  // “0.5 inch thick” or “12.7mm thick”
  const thickIn = t.match(/(\d+(\.\d+)?)\s*(?:["]|in|inch(?:es)?)[^\d]*thick/);
  if (thickIn) {
    out.thickness = mmFromInches(parseFloat(thickIn[1]));
    out.units = "mm";
  }
  const thickMm = t.match(/(\d+(\.\d+)?)\s*mm[^\d]*thick/);
  if (thickMm) {
    out.thickness = parseFloat(thickMm[1]);
    out.units = "mm";
  }

  return out;
}

function parseHole(user: string): Partial<Spec> {
  const out: Partial<Spec> = {};
  const t = (user || "").toLowerCase();
  if (!t.includes("hole")) return out;

  const dIn = t.match(/(\d+(\.\d+)?)\s*(?:["]|in|inch(?:es)?)\s*(?:hole|diameter)?/);
  const dMm = t.match(/(\d+(\.\d+)?)\s*mm\s*(?:hole|diameter)?/);

  if (dIn) {
    out.diameter = mmFromInches(parseFloat(dIn[1]));
    out.units = "mm";
  } else if (dMm) {
    out.diameter = parseFloat(dMm[1]);
    out.units = "mm";
  }

  out.features = Array.from(new Set([...(out.features || []), "hole_center"]));
  return out;
}

function generatePlateCode(spec: Spec): string {
  const w = spec.width ?? 60;
  const h = spec.height ?? 60;
  const t = spec.thickness ?? spec.depth ?? 6;
  const d = spec.diameter;

  return `// Parameters (mm)
width = ${w};
height = ${h};
thickness = ${t};
${d ? `hole_diameter = ${d};` : ""}

// Main body
module plate() {
  cube([width, height, thickness], center=false);
}

difference() {
  plate();
  ${d ? `translate([width/2, height/2, -1]) cylinder(h = thickness + 2, d = hole_diameter, center=false);` : "// no hole"}
}
`.trim() + "\n";
}

// ---------- Handler ----------
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      prompt: templatedPrompt, // your guided prompt
      history = [],
      spec: currentSpec = {},
    }: { prompt: string; history?: ChatMsg[]; spec?: Spec } = body;

    // Strong signal from the templated prompt
    const hasCurrentCodeHeader = /###\s*CURRENT_OPENSCAD/i.test(templatedPrompt || "");

    const userRequest = extractUserRequest(templatedPrompt || "", history);
    const heuristicUpdate = looksLikeUpdate(userRequest) || hasCurrentCodeHeader;

    console.log("📥 /generate input", {
      userRequest,
      heuristicUpdate,
      hasCurrentCodeHeader,
      historyLen: history.length,
      currentSpec,
      model: MODEL,
    });

    // 1) Intent classification (but we won't allow it to block updates)
    let intent = "nochange";
    try {
      const intentPrompt = `
You are the intent classifier for a CAD assistant.

History (compact): ${JSON.stringify(history)}
CurrentSpec: ${JSON.stringify(currentSpec)}
Request: "${userRequest}"

Return exactly one token:
- update_model
- clarification
- question
- nochange
`;
      const intentRes = await openai.responses.create({
        model: MODEL,
        input: intentPrompt,
        max_output_tokens: 32,
      });
      intent = (intentRes.output_text || "").trim().toLowerCase();
    } catch (e: any) {
      console.warn("⚠️ intent failed:", e?.message || e);
    }

    // If our heuristics say “this is an update”, we force update_model
    if (heuristicUpdate && intent === "nochange") {
      console.log("🔧 Forcing intent to update_model based on heuristics");
      intent = "update_model";
    }
    console.log("🎯 intent:", intent);

    // 2) If the user actually asked a general question
    if (!heuristicUpdate && intent === "question") {
      try {
        const answerRes = await openai.responses.create({
          model: MODEL,
          input: `Answer concisely in the context of OpenSCAD/CAD:\n\nQ: "${userRequest}"`,
          max_output_tokens: 400,
        });
        const text = (answerRes.output_text || "").trim();
        return NextResponse.json({
          type: "answer",
          content: text || "Okay.",
        } as AIResponse);
      } catch {
        return NextResponse.json({ type: "answer", content: "Okay." } as AIResponse);
      }
    }

    // 3) Clarification request
    if (!heuristicUpdate && intent === "clarification") {
      try {
        const askRes = await openai.responses.create({
          model: MODEL,
          input: `
We need targeted questions to finalize a model spec.

Spec so far: ${JSON.stringify(currentSpec)}
User said: "${userRequest}"

Ask only what is missing in 1–3 short bullets.
`,
          max_output_tokens: 200,
        });
        const text = (askRes.output_text || "").trim();
        return NextResponse.json({
          type: "questions",
          spec: currentSpec,
          content: text || "Could you clarify the missing dimensions?",
        } as AIResponse);
      } catch {
        return NextResponse.json({
          type: "questions",
          spec: currentSpec,
          content: "Could you clarify the missing dimensions?",
        } as AIResponse);
      }
    }

    // 4) Update model path (LLM + deterministic fallback)
    if (heuristicUpdate || intent === "update_model") {
      // Try to get a JSON delta from the model (but don't depend on it)
      let delta: Spec = {};
      try {
        const specRes = await openai.responses.create({
          model: MODEL,
          input: `
Update this JSON spec based ONLY on info clearly provided by the user's request.
Allowed keys: width,height,depth,thickness,diameter,shape,material,features,units.
Return STRICT JSON (no prose). Do NOT guess.

CurrentSpec: ${JSON.stringify(currentSpec)}
UserRequest: "${userRequest}"
`,
          max_output_tokens: 240,
        });
        const raw = (specRes.output_text || "").trim();
        try {
          delta = JSON.parse(raw);
        } catch {
          console.warn("⚠️ Could not parse LLM spec JSON. Raw:", raw);
          delta = {};
        }
      } catch (e: any) {
        console.warn("⚠️ spec delta failed:", e?.message || e);
      }

      // Deterministic additions from natural language
      const dims = parseDims(userRequest);
      const hole = parseHole(userRequest);

      const merged: Spec = {
        units: "mm",
        ...(currentSpec || {}),
        ...(delta || {}),
        ...dims,
        ...hole,
      };

      const changed =
        Object.keys(delta).length > 0 ||
        Object.keys(dims).length > 0 ||
        Object.keys(hole).length > 0;

      console.log("🧩 merged spec", merged, "changed?", changed);

      // If model gave nothing but we *know* user asked for geometry — generate a sane plate
      if (!changed) {
        console.log("🪄 Using deterministic base-plate fallback (nochange avoided).");
        const code = generatePlateCode(merged);
        return NextResponse.json({
          type: "code",
          spec: merged,
          content: code,
        } as AIResponse);
      }

      // Ask model for code (with fallback)
      try {
        const codeRes = await openai.responses.create({
          model: MODEL,
          input: `
Generate OpenSCAD for this spec. Use mm. Output ONLY code (no prose).

Spec:
${JSON.stringify(merged)}

Rules:
- Define variables at the top.
- If "diameter" exists and "features" includes "hole_center", subtract a through cylinder at the center.
- Ensure compilable code.
`,
          max_output_tokens: 1000,
        });
        const code = (codeRes.output_text || "").trim();

        if (code && /cube|cylinder|difference|union|translate|rotate/i.test(code)) {
          return NextResponse.json({
            type: "code",
            spec: merged,
            content: code,
          } as AIResponse);
        }

        // fallback
        const fallback = generatePlateCode(merged);
        return NextResponse.json({
          type: "code",
          spec: merged,
          content: fallback,
        } as AIResponse);
      } catch (e: any) {
        console.warn("⚠️ code gen failed, falling back:", e?.message || e);
        const fallback = generatePlateCode(merged);
        return NextResponse.json({
          type: "code",
          spec: merged,
          content: fallback,
        } as AIResponse);
      }
    }

    // 5) Default nochange (should be rare now)
    return NextResponse.json({
      type: "nochange",
      spec: { units: "mm", ...(currentSpec || {}) },
      content: "No updates were made.",
    } as AIResponse);
  } catch (err: any) {
    console.error("❌ /api/generate error:", err?.response?.data || err?.message || err);
    return NextResponse.json(
      { error: "Server error", details: err?.response?.data || err?.message || String(err) },
      { status: 500 }
    );
  }
}

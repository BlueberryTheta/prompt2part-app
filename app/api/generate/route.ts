// app/api/generate/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";

// Exported so your dashboard can import its shape if needed
export interface Spec {
  width?: number;     // mm
  height?: number;    // mm
  depth?: number;     // mm (AKA length)
  thickness?: number; // mm
  diameter?: number;  // mm (for center hole)
  shape?: string;     // e.g., 'bracket','plate'
  material?: string;
  features?: string[]; // e.g., ['hole_center','slots']
  units?: string;      // 'mm'|'inch' (we convert to mm internally)
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

const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ---------- Utilities ----------
function mmFromInches(inVal: number) {
  return inVal * 25.4;
}

function toNumber(x: string) {
  const n = parseFloat(x);
  return isFinite(n) ? n : undefined;
}

/**
 * Extract the actual user request from your templated prompt.
 * Looks for `### USER_REQUEST` ... until next `###` or EOF.
 */
function extractUserRequest(raw: string): string {
  if (!raw) return "";
  const marker = /###\s*USER_REQUEST\s*([\s\S]*?)(?:\n###|\r\n###|$)/i;
  const m = raw.match(marker);
  if (m && m[1]) return m[1].trim();
  return raw.trim();
}

/**
 * Heuristic: does the sentence look like a modeling instruction?
 */
function seemsLikeModelUpdate(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  const cues = [
    "make ", "create ", "generate ", "add ", "remove ", "change ", "update ",
    "increase", "decrease",
    "hole", "slot", "bracket", "plate", "box",
    "fillet", "chamfer",
    "diameter", "radius", "length", "width", "height", "thickness",
    "cylinder", "cube", "difference", "union"
  ];
  return cues.some(c => t.includes(c));
}

/**
 * Try to parse common dimension patterns like:
 *  - 3" x 3" x 0.5"
 *  - 76.2mm x 76.2mm x 12.7mm
 *  - "3 by 3 by 0.5 inch"
 */
function parseDims(user: string): Partial<Spec> {
  const out: Partial<Spec> = {};
  const t = user.toLowerCase().replace(/\s+/g, " ").trim();

  // Pattern: 3" x 3" x 0.5"
  const reInchesTriple = /(\d+(\.\d+)?)["in]*\s*[x×]\s*(\d+(\.\d+)?)["in]*\s*[x×]\s*(\d+(\.\d+)?)["in]*/i;
  const mTripleIn = t.match(reInchesTriple);
  if (mTripleIn) {
    const a = toNumber(mTripleIn[1]);
    const b = toNumber(mTripleIn[3]);
    const c = toNumber(mTripleIn[5]);
    if (a && b && c) {
      out.width = mmFromInches(a);
      out.height = mmFromInches(b);
      out.thickness = mmFromInches(c);
      out.units = "mm";
      return out;
    }
  }

  // Pattern: 76.2mm x 76.2mm x 12.7mm
  const reMmTriple = /(\d+(\.\d+)?)\s*mm\s*[x×]\s*(\d+(\.\d+)?)\s*mm\s*[x×]\s*(\d+(\.\d+)?)\s*mm/;
  const mTripleMm = t.match(reMmTriple);
  if (mTripleMm) {
    const a = toNumber(mTripleMm[1]);
    const b = toNumber(mTripleMm[3]);
    const c = toNumber(mTripleMm[5]);
    if (a && b && c) {
      out.width = a;
      out.height = b;
      out.thickness = c;
      out.units = "mm";
      return out;
    }
  }

  // Single thickness like “0.5 inch thick” or “12.7mm thick”
  const singleIn = t.match(/(\d+(\.\d+)?)\s*(?:["in]|inch(?:es)?)[^\d]*thick/);
  if (singleIn) {
    out.thickness = mmFromInches(parseFloat(singleIn[1]));
    out.units = "mm";
  }
  const singleMm = t.match(/(\d+(\.\d+)?)\s*mm[^\d]*thick/);
  if (singleMm) {
    out.thickness = parseFloat(singleMm[1]);
    out.units = "mm";
  }

  // “3 inch square plate” => width/height both 3 inches
  const squareIn = t.match(/(\d+(\.\d+)?)\s*(?:["in]|inch(?:es)?)\s*(square|plate|bracket)/);
  if (squareIn) {
    const val = mmFromInches(parseFloat(squareIn[1]));
    out.width = val;
    out.height = val;
    out.units = "mm";
  }
  const squareMm = t.match(/(\d+(\.\d+)?)\s*mm\s*(square|plate|bracket)/);
  if (squareMm) {
    const val = parseFloat(squareMm[1]);
    out.width = val;
    out.height = val;
    out.units = "mm";
  }

  // Fallback: if a single quoted number appears like 3" or 0.5"
  const firstIn = t.match(/(\d+(\.\d+)?)\s*(?:["in]|inch(?:es)?)/);
  if (firstIn && out.width === undefined && out.height === undefined) {
    const val = mmFromInches(parseFloat(firstIn[1]));
    out.width = val;
    out.height = val;
    out.units = "mm";
  }

  return out;
}

/**
 * Parse a hole request (center hole diameter). Supports:
 *  - "add a 1\" hole"
 *  - "add a 25.4mm hole"
 *  - "through hole" (we always do through)
 */
function parseHole(user: string): Partial<Spec> {
  const out: Partial<Spec> = {};
  const t = user.toLowerCase();

  if (t.includes("hole")) {
    // diameter in inches
    const dIn = t.match(/(\d+(\.\d+)?)\s*(?:["in]|inch(?:es)?)\s*(?:hole|diameter)/);
    if (dIn) {
      out.diameter = mmFromInches(parseFloat(dIn[1]));
      out.units = "mm";
    }
    // diameter in mm
    const dMm = t.match(/(\d+(\.\d+)?)\s*mm\s*(?:hole|diameter)/);
    if (dMm) {
      out.diameter = parseFloat(dMm[1]);
      out.units = "mm";
    }

    // default feature hint
    out.features = Array.from(new Set([...(out.features || []), "hole_center"]));
  }

  return out;
}

/**
 * Make a basic OpenSCAD plate (width x height x thickness) with optional center through-hole.
 */
function generatePlateCode(spec: Spec): string {
  const w = spec.width ?? 60;
  const h = spec.height ?? 60;
  const t = spec.thickness ?? spec.depth ?? 6;
  const d = spec.diameter;

  // center the hole at (w/2, h/2). Through hole = height t.
  const body = `// Parameters (mm)
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
`;
  return body.trim() + "\n";
}

// ---------- Handler ----------
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      userPrompt,
      history = [],
      currentSpec = {},
    }: { userPrompt: string; history?: ChatMsg[]; currentSpec?: Spec } = body;

    const userRequest = extractUserRequest(userPrompt);
    const hasPriorCode = /###\s*CURRENT_OPENSCAD/i.test(userPrompt);
    const likelyUpdate = seemsLikeModelUpdate(userRequest) || hasPriorCode;

    console.log("📩 generate input", {
      userRequest,
      hasPriorCode,
      likelyUpdate,
      historyLen: history.length,
      currentSpec,
      model: MODEL,
    });

    // 1) INTENT (clean request only)
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
        // Only this is supported on GPT-5
        max_output_tokens: 32,
      });
      intent = (intentRes.output_text || "").trim().toLowerCase();
    } catch (e: any) {
      console.warn("⚠️ intent step failed:", e?.message || e);
    }

    // Heuristic override
    if (intent === "nochange" && likelyUpdate) {
      console.log("🔧 Overriding intent -> update_model (heuristic)");
      intent = "update_model";
    }
    console.log("🎯 intent:", intent);

    // 2) QUESTION
    if (intent === "question") {
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
      } catch (e: any) {
        // Fallback: generic answer
        return NextResponse.json({
          type: "answer",
          content: "Okay.",
        } as AIResponse);
      }
    }

    // 3) CLARIFICATION
    if (intent === "clarification") {
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

    // 4) UPDATE MODEL (LLM + deterministic fallback)
    if (intent === "update_model") {
      // Try a compact LLM delta update first
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
        console.warn("⚠️ spec LLM failed:", e?.message || e);
      }

      // Deterministic fallback parse:
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

      console.log("🧩 merged", merged, "changed?", changed);

      // If STILL nothing changed but we believe it's an update, produce a sane base plate
      if (!changed && likelyUpdate) {
        console.log("🪄 Using deterministic base-plate fallback.");
        const code = generatePlateCode(merged);
        return NextResponse.json({
          type: "code",
          spec: merged,
          content: code,
        } as AIResponse);
      }

      // If there are changes, ask GPT-5 to produce code — with a fallback to deterministic
      if (changed) {
        try {
          const codeRes = await openai.responses.create({
            model: MODEL,
            input: `
Generate OpenSCAD for this spec. Use mm.

Spec:
${JSON.stringify(merged)}

Rules:
- Output ONLY OpenSCAD code (no prose).
- Define variables at top for major dims.
- If "diameter" exists and "features" includes "hole_center", subtract a through cylinder at plate center.
- Ensure compilable code.
`,
            max_output_tokens: 1000,
          });
          const code = (codeRes.output_text || "").trim();
          if (code && /cube|cylinder|difference|union/i.test(code)) {
            return NextResponse.json({
              type: "code",
              spec: merged,
              content: code,
            } as AIResponse);
          }
          // If code is empty or suspicious, fallback
          const fallbackCode = generatePlateCode(merged);
          return NextResponse.json({
            type: "code",
            spec: merged,
            content: fallbackCode,
          } as AIResponse);
        } catch {
          const fallbackCode = generatePlateCode(merged);
          return NextResponse.json({
            type: "code",
            spec: merged,
            content: fallbackCode,
          } as AIResponse);
        }
      }

      // No change
      return NextResponse.json({
        type: "nochange",
        spec: merged,
        content: "No updates were made.",
      } as AIResponse);
    }

    // 5) Default
    return NextResponse.json({
      type: "nochange",
      spec: { units: "mm", ...(currentSpec || {}) },
      content: "No updates were made.",
    } as AIResponse);
  } catch (err: any) {
    console.error("❌ /api/generate error:", err?.response?.data || err?.message || err);
    return NextResponse.json(
      {
        error: "Server error",
        details: err?.response?.data || err?.message || String(err),
      },
      { status: 500 }
    );
  }
}

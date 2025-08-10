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
  const geoWords = /\b(add|make|create|generate|remove|change|update|increase|decrease|hole|slot|fillet|chamfer|bracket|plate|cube|cylinder|mug|coffee)\b/;

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
  ${d ? `translate([width/2, height/2, -1]) cylinder(h = thickness + 2, d = hole_diameter, center=false);` : "// no hole" }
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

    console.log("📥 Received request:", body);

    const userRequest = extractUserRequest(templatedPrompt || "", history);
    console.log("📝 Extracted user request:", userRequest);

    // Heuristic check for update
    const heuristicUpdate = looksLikeUpdate(userRequest);
    console.log("🔧 Heuristic update check:", heuristicUpdate);

    // Intent Classification
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
      console.log("🎯 Intent classified as:", intent);
    } catch (e: any) {
      console.warn("⚠️ Intent classification failed:", e?.message || e);
    }

    // Process based on intent...
    if (intent === "update_model" || heuristicUpdate) {
      // Handle model update (generate OpenSCAD code)
      console.log("🔧 Generating model based on user request:", userRequest);
      const code = generatePlateCode(currentSpec);
      return NextResponse.json({
        type: "code",
        spec: currentSpec,
        content: code,
      } as AIResponse);
    }

    return NextResponse.json({
      type: "nochange",
      spec: { units: "mm", ...(currentSpec || {}) },
      content: "No updates were made.",
    } as AIResponse);
  } catch (err: any) {
    console.error("❌ /api/generate error:", err?.message || err);
    return NextResponse.json(
      { error: "Server error", details: err?.message || String(err) },
      { status: 500 }
    );
  }
}

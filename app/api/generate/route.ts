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
  shape?: string;     // e.g., 'bracket', 'plate', 'cylinder', etc.
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
  const geoWords = /\b(add|make|create|generate|remove|change|update|increase|decrease|hole|slot|fillet|chamfer|bracket|plate|cube|cylinder)\b/;

  const hasDims = unitOrDims.test(t);
  const hasGeo = geoWords.test(t);

  // If it looks like geometry, treat as update even if it's phrased as a question
  return hasDims || hasGeo || (!hasQuestion && t.length > 0);
}

// Parse dimensions provided by the user (supporting inches and mm)
function parseDims(user: string): Partial<Spec> {
  const out: Partial<Spec> = {};
  const t = (user || "").toLowerCase().replace(/\s+/g, " ").trim();

  // Handle formats like 3" x 3" x 0.5"
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

  // Handle 76.2mm x 76.2mm x 12.7mm format
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

  return out;
}

// Generate OpenSCAD code based on the provided spec (generic)
function generateGeometryCode(spec: Spec): string {
  const width = spec.width ?? 60;
  const height = spec.height ?? 60;
  const thickness = spec.thickness ?? 6;
  const diameter = spec.diameter ?? 0; // Optional hole diameter

  // Handle different shapes based on the spec
  if (spec.shape === 'bracket') {
    return `// Bracket code
width = ${width};
height = ${height};
thickness = ${thickness};

// Bracket model
module bracket() {
  cube([width, height, thickness], center=false);
}

bracket();
`.trim() + "\n";
  }

  if (spec.shape === 'plate') {
    return `// Plate code
width = ${width};
height = ${height};
thickness = ${thickness};

// Plate model
module plate() {
  cube([width, height, thickness], center=false);
}

plate();
`.trim() + "\n";
  }

  // Default fallback to a plate
  return `// Default code
width = ${width};
height = ${height};
thickness = ${thickness};

module plate() {
  cube([width, height, thickness], center=false);
}

plate();
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

    // Ask for clarification if key dimensions are missing
    if (!currentSpec.width || !currentSpec.height || !currentSpec.thickness) {
      return NextResponse.json({
        type: "questions",
        content: "Could you provide the dimensions (width, height, and thickness) of the object?",
      } as AIResponse);
    }

    // Parse and convert the dimensions if needed (handle inches to mm)
    const dims = parseDims(userRequest);
    if (dims.width || dims.height || dims.thickness) {
      currentSpec.width = dims.width ?? currentSpec.width;
      currentSpec.height = dims.height ?? currentSpec.height;
      currentSpec.thickness = dims.thickness ?? currentSpec.thickness;
    }

    // If dimensions are now available, generate the model
    const code = generateGeometryCode(currentSpec);
    return NextResponse.json({
      type: "code",
      spec: currentSpec,
      content: code,
    } as AIResponse);

  } catch (err: any) {
    console.error("❌ /api/generate error:", err?.message || err);
    return NextResponse.json(
      { error: "Server error", details: err?.message || String(err) },
      { status: 500 }
    );
  }
}

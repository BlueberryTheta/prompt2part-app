// app/api/generate/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";

/** Exported so the dashboard can import its shape */
export interface Spec {
  width?: number;
  height?: number;
  depth?: number;
  thickness?: number;
  diameter?: number;
  shape?: string;
  material?: string;
  features?: string[]; // e.g., ["hole_center", "slots"]
  units?: string;      // "mm"|"inch"|free text
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

/**
 * Pull out the actual instruction when the frontend sends a templated prompt.
 * Looks for `### USER_REQUEST` ... until next `###` or EOF.
 */
function extractUserRequest(raw: string): string {
  try {
    const marker = /###\s*USER_REQUEST\s*([\s\S]*?)(?:\n###|\r\n###|$)/i;
    const m = raw.match(marker);
    if (m && m[1]) {
      return m[1].trim();
    }
  } catch (_) {}
  // fallback: return raw
  return (raw || "").trim();
}

/**
 * Extremely simple heuristic: does the instruction likely request a model change?
 */
function seemsLikeModelUpdate(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  // verbs and tokens that usually imply geometry changes
  const cues = [
    "make ", "create ", "generate ", "add ", "remove ", "change ", "update ",
    "increase", "decrease", "hole", "slot", "bracket", "plate", "fillet", "chamfer",
    "diameter", "radius", "length", "width", "height", "thickness", "translate", "extrude",
    "cylinder", "cube", "difference", "union"
  ];
  return cues.some(c => t.includes(c));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      userPrompt,
      history = [],
      currentSpec = {},
    }: { userPrompt: string; history?: ChatMsg[]; currentSpec?: Spec } = body;

    // Pull the real instruction out of the templated prompt if present
    const userRequest = extractUserRequest(userPrompt);
    const hasPriorCode = /###\s*CURRENT_OPENSCAD/i.test(userPrompt);
    const likelyUpdate = seemsLikeModelUpdate(userRequest) || hasPriorCode;

    console.log("📥 /api/generate input:", {
      hasPriorCode,
      likelyUpdate,
      userRequest,
      historyLen: history.length,
      currentSpec,
      model: MODEL,
    });

    // --- Step 1: classify intent (but give the model the CLEAN request) ---
    const intentPrompt = `
You are the AI for Prompt2Part (OpenSCAD assistant).

Given:
- Conversation history: ${JSON.stringify(history)}
- Current spec (optional): ${JSON.stringify(currentSpec)}
- New user request (cleaned): "${userRequest}"

Return exactly one word:
- update_model   (user wants to change/add details of the model)
- clarification  (more info is needed before modeling)
- question       (general question not changing the model)
- nochange       (no change requested)
`;

    let intent = "nochange";
    try {
      const intentRes = await openai.responses.create({
        model: MODEL,
        input: intentPrompt,
        max_output_tokens: 32,
      });
      intent = (intentRes.output_text || "").trim().toLowerCase();
    } catch (e: any) {
      console.warn("⚠️ intent step failed, falling back to heuristic:", e?.message || e);
    }

    // If model says nochange but our heuristics scream "update", override.
    if (intent === "nochange" && likelyUpdate) {
      console.log("🔧 Overriding intent -> update_model (heuristic)");
      intent = "update_model";
    }

    console.log("🎯 intent:", intent);

    // --- Step 2: handle general question ---
    if (intent === "question") {
      const answerPrompt = `
Answer the user's question concisely in the context of a CAD/OpenSCAD workflow.

Question: "${userRequest}"
`;
      const answerRes = await openai.responses.create({
        model: MODEL,
        input: answerPrompt,
        max_output_tokens: 400,
      });
      const text = (answerRes.output_text || "").trim();
      return NextResponse.json({
        type: "answer",
        content: text || "Okay.",
      } as AIResponse);
    }

    // --- Step 3: if clarification needed, ask targeted questions ---
    if (intent === "clarification") {
      const clarificationPrompt = `
You are refining a 3D model specification for OpenSCAD.

Current spec: ${JSON.stringify(currentSpec)}
User request: "${userRequest}"

Ask ONLY the missing, targeted questions required to produce a clear, complete spec. Keep it short.
`;
      const clarifyRes = await openai.responses.create({
        model: MODEL,
        input: clarificationPrompt,
        max_output_tokens: 240,
      });
      const questions = (clarifyRes.output_text || "").trim();
      return NextResponse.json({
        type: "questions",
        content: questions || "Could you clarify the missing dimensions?",
        spec: currentSpec,
      } as AIResponse);
    }

    // --- Step 4: apply model updates ---
    if (intent === "update_model") {
      const specPrompt = `
You are updating a JSON spec for an OpenSCAD model.

Allowed keys (all optional): width, height, depth, thickness, diameter, shape, material, features, units.
- Only include fields that are newly provided or confidently updated by the user's message.
- Do NOT include guesses.
- Respond with STRICT JSON only (no markdown, no comments).

Current spec: ${JSON.stringify(currentSpec)}
User request: "${userRequest}"

Return JSON with the updated fields (partial is fine).
`;
      let delta: Spec = {};
      try {
        const specRes = await openai.responses.create({
          model: MODEL,
          input: specPrompt,
          max_output_tokens: 240,
        });
        const raw = (specRes.output_text || "").trim();
        try {
          delta = JSON.parse(raw);
        } catch {
          console.warn("⚠️ Could not parse spec JSON. Raw:", raw);
          delta = {};
        }
      } catch (e: any) {
        console.error("❌ spec step failed:", e?.response?.data || e?.message || e);
        // If spec step fails, still try to generate code from current spec + request
        delta = {};
      }

      // Merge deltas; ensure units default to "mm" if not set
      const merged: Spec = { units: "mm", ...(currentSpec || {}), ...(delta || {}) };
      console.log("🛠 mergedSpec:", merged);

      // If literally nothing changed and we had no prior spec, don't pretend
      const changed = Object.keys(delta || {}).length > 0;
      if (!changed && !likelyUpdate) {
        return NextResponse.json({
          type: "nochange",
          spec: merged,
          content: "No updates were made.",
        } as AIResponse);
      }

      // --- Step 5: Generate OpenSCAD code from the merged spec ---
      const codePrompt = `
Generate valid OpenSCAD code for this spec. Use ${merged.units || "mm"} for units.

Spec (JSON):
${JSON.stringify(merged)}

Requirements:
- Produce ONLY OpenSCAD code (no prose).
- Define named variables at the top for main dimensions (width, height, depth/thickness, etc., as applicable).
- If holes are implied by diameter and center placement, subtract a cylinder at the middle; if features mention "hole_center", use a through hole.
- Ensure code compiles as-is, and renders the main body + any holes/slots.
`;
      const codeRes = await openai.responses.create({
        model: MODEL,
        input: codePrompt,
        max_output_tokens: 1000,
      });

      const code = (codeRes.output_text || "").trim();
      return NextResponse.json({
        type: "code",
        spec: merged,
        content: code || "// No code produced.",
      } as AIResponse);
    }

    // --- default: nochange ---
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

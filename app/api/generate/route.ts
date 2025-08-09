// app/api/generate/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";

/** Exported so the dashboard can import it if needed */
export interface Spec {
  width?: number;
  height?: number;
  depth?: number;
  thickness?: number;
  diameter?: number;
  shape?: string;
  material?: string;
  features?: string[]; // e.g. ["hole_center","slots"]
  units?: string;      // "mm" | "inch" | free text
}

interface AIResponse {
  type: "code" | "questions" | "answer" | "nochange";
  spec?: Spec;
  content: string; // code or text
}

const MODEL = process.env.OPENAI_MODEL || "gpt-5";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      userPrompt,
      history = [],
      currentSpec = {},
    }: { userPrompt: string; history?: Array<{ role: string; content: string }>; currentSpec?: Spec } = body;

    console.log("📥 /api/generate incoming:", {
      userPrompt,
      historyLen: history.length,
      currentSpec,
      model: MODEL,
    });

    // --- Step 1: classify intent ---
    const intentPrompt = `
You are the AI for Prompt2Part (OpenSCAD assistant).

Given:
- Conversation history: ${JSON.stringify(history)}
- Current spec: ${JSON.stringify(currentSpec)}
- New user message: "${userPrompt}"

Return one of:
- update_model   (user wants to change/add details of the model)
- clarification  (more info is needed before modeling)
- question       (general question not changing the model)
- nochange       (no change requested)
Only the word.`;

    const intentRes = await openai.responses.create({
      model: MODEL,
      input: intentPrompt,
      // NOTE: GPT-5 supports only default temperature; do not pass it.
      max_output_tokens: 32,
    });

    const intent = intentRes.output_text.trim().toLowerCase();
    console.log("🎯 intent:", intent);

    // --- Step 2: handle general question ---
    if (intent === "question") {
      const answerPrompt = `
Answer the user's question concisely in the context of a CAD/OpenSCAD workflow.

Question: "${userPrompt}"
`;
      const answerRes = await openai.responses.create({
        model: MODEL,
        input: answerPrompt,
        max_output_tokens: 300,
      });

      const text = (answerRes.output_text || "").trim();
      return NextResponse.json({
        type: "answer",
        content: text,
      } as AIResponse);
    }

    // --- Step 3: ask for clarification if needed ---
    if (intent === "clarification") {
      const clarificationPrompt = `
You are refining a 3D model specification for OpenSCAD.

Current spec: ${JSON.stringify(currentSpec)}
User message: "${userPrompt}"

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
        content: questions,
        spec: currentSpec,
      } as AIResponse);
    }

    // --- Step 4: apply model updates ---
    if (intent === "update_model") {
      const specPrompt = `
You are updating a JSON spec for an OpenSCAD model.

Fields allowed (all optional): width, height, depth, thickness, diameter, shape, material, features, units.
- Only include fields that are newly provided or confidently updated by the user's message.
- Do NOT include guesses.
- Respond with STRICT JSON only (no markdown, no comments).

Current spec: ${JSON.stringify(currentSpec)}
User request: "${userPrompt}"

Return JSON with the updated fields (partial is fine).
`;

      const specRes = await openai.responses.create({
        model: MODEL,
        input: specPrompt,
        max_output_tokens: 240,
      });

      let delta: Spec = {};
      const raw = (specRes.output_text || "").trim();
      try {
        delta = JSON.parse(raw);
      } catch (e) {
        console.warn("⚠️ Could not parse spec JSON. Raw:", raw);
        delta = {};
      }

      // Merge the delta into the current spec
      const merged: Spec = { ...(currentSpec || {}), ...(delta || {}) };
      console.log("🛠 mergedSpec:", merged);

      // If nothing meaningful changed, return nochange
      if (Object.keys(delta || {}).length === 0) {
        return NextResponse.json({
          type: "nochange",
          spec: merged,
          content: "No significant updates detected.",
        } as AIResponse);
      }

      // --- Step 5: Generate OpenSCAD code from the merged spec ---
      const codePrompt = `
Generate valid OpenSCAD code for this part spec. Use ${merged.units || "mm"} for units.
Spec: ${JSON.stringify(merged)}

Requirements:
- Produce ONLY OpenSCAD code (no prose).
- Define named variables at the top for main dimensions.
- Ensure code compiles as-is.
`;
      const codeRes = await openai.responses.create({
        model: MODEL,
        input: codePrompt,
        max_output_tokens: 900,
      });

      const code = (codeRes.output_text || "").trim();

      return NextResponse.json({
        type: "code",
        spec: merged,
        content: code,
      } as AIResponse);
    }

    // --- Step 6: no change ---
    return NextResponse.json({
      type: "nochange",
      spec: currentSpec,
      content: "No updates were made.",
    } as AIResponse);

  } catch (err: any) {
    // If the SDK typed error gives more info, log it
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

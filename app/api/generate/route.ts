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

// ---------- Helper to extract user request ----------
function extractUserRequest(raw: string, history: ChatMsg[]): string {
  if (!raw) {
    const lastUser = [...history].reverse().find(m => m.role === "user");
    return (lastUser?.content || "").trim();
  }

  return raw.replace(/\r\n/g, "\n").trim();
}

// ---------- Handler ----------
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { prompt: templatedPrompt, history = [], spec: currentSpec = {} }: { prompt: string; history?: ChatMsg[]; spec?: Spec } = body;

    console.log("📥 Received request:", body);

    const userRequest = extractUserRequest(templatedPrompt || "", history);
    console.log("📝 Extracted user request:", userRequest);

    // 1) Use OpenAI to classify the intent and determine the action
    const intentPrompt = `
      You are a CAD assistant. Based on the following history, decide if the user is:
      - asking for a geometry update (e.g., "change this bracket to be 4mm thick")
      - asking for clarification (e.g., missing dimensions)
      - asking a question (e.g., "What is the material for this model?")
      Return one of the following tokens:
      - update_model
      - clarification
      - question
    `;
    
    const intentRes = await openai.responses.create({
      model: MODEL,
      input: intentPrompt + `\n\nUser request: "${userRequest}"\n\nHistory: ${JSON.stringify(history)}`,
      max_output_tokens: 32,
    });

    const intent = (intentRes.output_text || "").trim().toLowerCase();

    console.log("🎯 Intent classified as:", intent);

    // 2) If the intent is clarification, ask the user for more details (e.g., dimensions)
    if (intent === "clarification") {
      return NextResponse.json({
        type: "questions",
        content: "Could you please provide the missing dimensions (width, height, thickness, etc.) for this object?",
      } as AIResponse);
    }

    // 3) If the intent is a general question, we answer it
    if (intent === "question") {
      return NextResponse.json({
        type: "answer",
        content: "I'm here to help with your CAD model. Please specify your requirements!",
      } as AIResponse);
    }

    // 4) If the user is requesting an update to the model, ask for necessary dimensions if not available
    if (intent === "update_model") {
      // Ask for missing dimensions if necessary
      if (!currentSpec.width || !currentSpec.height || !currentSpec.thickness) {
        return NextResponse.json({
          type: "questions",
          content: "I need the dimensions (width, height, thickness, etc.) to proceed. Can you please provide them?",
        } as AIResponse);
      }

      // Proceed to generate the OpenSCAD code once dimensions are available
      const code = generateGeometryCode(currentSpec);
      return NextResponse.json({
        type: "code",
        spec: currentSpec,
        content: code,
      } as AIResponse);
    }

    // If intent is not recognized, ask the user for clarification
    return NextResponse.json({
      type: "questions",
      content: "Can you provide more details or clarification about your request?",
    } as AIResponse);

  } catch (err: any) {
    console.error("❌ /api/generate error:", err?.message || err);
    return NextResponse.json(
      { error: "Server error", details: err?.message || String(err) },
      { status: 500 }
    );
  }
}

// ---------- Generate OpenSCAD code based on the given spec ----------
function generateGeometryCode(spec: Spec): string {
  const width = spec.width ?? 60;
  const height = spec.height ?? 60;
  const thickness = spec.thickness ?? 6;

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

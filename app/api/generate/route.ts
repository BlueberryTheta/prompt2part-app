// app/api/generate/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export interface Spec {
  width?: number;
  height?: number;
  depth?: number;
  thickness?: number;
  diameter?: number;
  shape?: string;
  material?: string;
  features?: string[];
  units?: string; // ✅ added units support
}

export async function POST(req: Request) {
  try {
    const { prompt, history, resolution }: { prompt: string; history: any[]; resolution: number } =
      await req.json();

    // === Step 1: Intent Classification ===
    const intentResponse = await openai.chat.completions.create({
      model: "gpt-5", // ✅ GPT-5
      messages: [
        {
          role: "system",
          content:
            "You are an AI for a 3D part generator. Classify the user's message as one of: update_model, clarification, question. Return ONLY the label.",
        },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: 20, // ✅ GPT-5 syntax
    });

    const intent = intentResponse.choices[0].message?.content?.trim() || "clarification";

    // === Step 2: Handle Questions ===
    if (intent === "question") {
      const answerResponse = await openai.chat.completions.create({
        model: "gpt-5",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant inside a 3D modeling app. Answer the question naturally, using the context of the app.",
          },
          ...history,
          { role: "user", content: prompt },
        ],
        max_completion_tokens: 500,
      });

      return NextResponse.json({
        type: "answer",
        content: answerResponse.choices[0].message?.content || "",
      });
    }

    // === Step 3: Spec Extraction ===
    const specResponse = await openai.chat.completions.create({
      model: "gpt-5",
      messages: [
        {
          role: "system",
          content:
            "Extract a structured JSON spec for the part based on the conversation. Only include valid JSON. Fields: width, height, depth, thickness, diameter, shape, material, features (array), units.",
        },
        ...history,
        { role: "user", content: prompt },
      ],
      max_completion_tokens: 300,
      response_format: { type: "json_object" }, // ✅ ensure valid JSON
    });

    let spec: Spec;
    try {
      spec = JSON.parse(specResponse.choices[0].message?.content || "{}");
    } catch {
      return NextResponse.json({
        error: "❌ Spec content includes invalid or partial JSON.",
      });
    }

    // === Step 4: Generate OpenSCAD Code ===
    const codeResponse = await openai.chat.completions.create({
      model: "gpt-5",
      messages: [
        {
          role: "system",
          content: `You are an OpenSCAD code generator. Produce valid OpenSCAD code using $fn=${resolution}.`,
        },
        { role: "user", content: JSON.stringify(spec) },
      ],
      max_completion_tokens: 800,
    });

    return NextResponse.json({
      type: "code",
      spec,
      content: codeResponse.choices[0].message?.content || "",
    });
  } catch (error) {
    console.error("❌ API error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

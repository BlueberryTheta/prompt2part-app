// app/api/generate/route.ts
import { NextResponse } from 'next/server'

/** ========= Types (exported so the dashboard can import) ========= */
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

/** A richer Spec that covers what your dashboard has used before */
export interface Spec {
  units?: 'mm' | 'inch'
  part_type?: string

  /** Overall dimensions (mm by default) */
  overall?: { x?: number; y?: number; z?: number }

  /** Freeform shape/dimensions strings (optional, for looser intents) */
  shape?: string
  dimensions?: string

  /** Optional feature array for holes/slots/etc. */
  features?: Array<
    | {
        type: 'hole'
        diameter?: number
        count?: number
        pattern?: 'grid' | 'linear' | 'custom'
        positions?: Array<{ x: number; y: number }>
        through?: boolean
        countersink?: boolean
      }
    | {
        type: 'slot'
        width?: number
        length?: number
        center?: { x: number; y: number }
        angle?: number
      }
    | { type: 'fillet'; radius?: number; edges?: 'all' | 'none' | 'some' }
    | { type: 'chamfer'; size?: number; edges?: 'all' | 'none' | 'some' }
  >

  mounting?: { surface?: string; holes?: number }
  tolerances?: { general?: number; hole_clearance?: number }
  notes?: string

  /** Render smoothness hint (passed as $fn in OpenSCAD by the UI) */
  $fn?: number
}

/** ========= Models & helpers ========= */
const SPEC_MODEL = 'gpt-5'   // step A: intent/spec
const CODE_MODEL = 'gpt-5'   // step B: OpenSCAD

function safeJSONParse<T>(str: string): T | null {
  try {
    return JSON.parse(str)
  } catch (e) {
    console.error('❌ JSON parse error:', e, '\nRaw:', str)
    return null
  }
}

function sysPromptSpec() {
  return `
You are the requirements brain for Prompt2Part.

Classify the user's message into an "intent":
- "update_model": user requests to create/modify a part
- "clarification": you are missing necessary details to proceed
- "question": a general question (no model change needed)
- "nochange": acknowledge but do not modify the model

If intent is "update_model" or "clarification", return:
{
  "intent": "...",
  "spec": {
    "units": "mm" | "inch",
    "part_type": string,
    "overall": {"x": number, "y": number, "z": number},
    "features": [...],
    "mounting": {...},
    "tolerances": {...},
    "notes": string,
    "$fn": number
  },
  "missing": string[],
  "questions": string[]
}

If intent is "question" or "nochange", return:
{
  "intent": "...",
  "answer": string
}

Rules:
- Use "units": "mm" by default unless user explicitly states inches.
- DO NOT fabricate unknown dimensions. Put them in "missing" and "questions".
- Prefer structured fields (overall, features, etc.) over freeform strings.
- Response must be valid JSON (no markdown, no trailing commas).
`.trim()
}

function sysPromptCode() {
  return `
You are an OpenSCAD code generator. Given a SPEC (JSON), output ONLY valid OpenSCAD code.
- Use millimeters for modeling if spec.units == "mm".
- Include clear variables at the top for key dimensions.
- Use difference(), translate(), cylinder(), etc. for holes/features.
- Do not include prose or markdown fences—just code.
- The code must be complete and renderable.
`.trim()
}

/** ========= Route ========= */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const { prompt, history = [], spec: currentSpec }: { prompt?: string; history?: Msg[]; spec?: Spec } = body

    if (!prompt || typeof prompt !== 'string') {
      console.error('🛑 Missing prompt in request body')
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    console.log('➡️  /api/generate: incoming', { prompt, historyLen: history.length, currentSpec })

    /** ---------- Stage A: Intent + Spec extraction ---------- */
    const messagesA: Msg[] = [
      { role: 'system', content: sysPromptSpec() },
      ...((history || []) as Msg[]),
      {
        role: 'user',
        content: JSON.stringify({
          prompt,
          existing_spec: currentSpec ?? {},
        }),
      },
    ]

    const resA = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: SPEC_MODEL,
        temperature: 0.1,
        max_completion_tokens: 900, // ✅ GPT-5 expects this, not max_tokens
        messages: messagesA,
        response_format: { type: 'json_object' },
      }),
    })

    const dataA = await resA.json()
    if (!resA.ok) {
      console.error('🛑 Stage A HTTP error:', resA.status, dataA)
      return NextResponse.json({ error: `Spec step failed: ${resA.status}`, raw: dataA }, { status: 400 })
    }

    const contentA: string = dataA?.choices?.[0]?.message?.content ?? ''
    const parsedA = safeJSONParse<any>(contentA)

    if (!parsedA || !parsedA.intent) {
      console.error('🛑 Invalid Stage A content:', contentA)
      return NextResponse.json({ error: 'Spec step returned invalid JSON', raw: contentA }, { status: 400 })
    }

    console.log('✅ Stage A parsed:', parsedA)

    // If the user is asking a question or no change is needed, short-circuit
    if (parsedA.intent === 'question' || parsedA.intent === 'nochange') {
      return NextResponse.json({
        type: parsedA.intent,
        answer: parsedA.answer ?? 'Okay.',
      })
    }

    // If we need clarification, return questions to the UI
    const missing: string[] = parsedA.missing || []
    const questions: string[] = parsedA.questions || []
    const updatedSpec: Spec = { ...(currentSpec || {}), ...(parsedA.spec || {}) }

    if (parsedA.intent === 'clarification' || missing.length > 0 || questions.length > 0) {
      return NextResponse.json({
        type: 'questions',
        spec: updatedSpec,
        missing,
        questions,
        content:
          questions.length > 0
            ? `I need a bit more info:\n- ${questions.join('\n- ')}`
            : `I’m missing:\n- ${missing.join('\n- ')}`,
      })
    }

    /** ---------- Stage B: Generate OpenSCAD ---------- */
    const messagesB: Msg[] = [
      { role: 'system', content: sysPromptCode() },
      { role: 'user', content: JSON.stringify(updatedSpec) },
    ]

    const resB = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: CODE_MODEL,
        temperature: 0.1,
        max_completion_tokens: 2000, // ✅ GPT-5 param
        messages: messagesB,
      }),
    })

    const dataB = await resB.json()
    if (!resB.ok) {
      console.error('🛑 Stage B HTTP error:', resB.status, dataB)
      return NextResponse.json({ error: `Code step failed: ${resB.status}`, raw: dataB }, { status: 400 })
    }

    // Strip markdown fences if present, just in case
    let code: string = dataB?.choices?.[0]?.message?.content ?? ''
    code = code.replace(/```(?:scad|openscad)?/gi, '').replace(/```/g, '').trim()

    const looksSCAD = /cube|cylinder|translate|rotate|difference|union|linear_extrude/i.test(code)
    if (!looksSCAD) {
      console.warn('⚠️ Stage B returned suspicious code; sending questions instead.')
      return NextResponse.json({
        type: 'questions',
        spec: updatedSpec,
        content: 'I still need a bit more detail before I can generate code. Please answer the pending questions.',
      })
    }

    console.log('✅ Stage B generated code (length):', code.length)

    return NextResponse.json({
      type: 'code',
      spec: updatedSpec,
      code,
      content: 'Here is the OpenSCAD code based on your confirmed specifications.',
    })
  } catch (err: any) {
    console.error('❌ /api/generate route error:', err)
    return NextResponse.json({ error: err?.message || 'Unknown server error' }, { status: 500 })
  }
}

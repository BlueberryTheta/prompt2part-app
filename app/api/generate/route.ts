// app/api/generate/route.ts
import { NextRequest, NextResponse } from 'next/server'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o' // or 'gpt-4o-mini' to save cost

type Msg = { role: 'system'|'user'|'assistant'; content: string }
type Spec = {
  units?: 'mm'|'inch'
  part_type?: 'bracket'|'plate'|'box'|'knob'|'custom'
  overall?: { x?: number; y?: number; z?: number } // width/height/thickness in units
  features?: Array<
    | { type: 'hole'; diameter?: number; count?: number; pattern?: 'grid'|'linear'|'custom'; positions?: Array<{ x:number; y:number }>; through?: boolean; countersink?: boolean; }
    | { type: 'slot'; width?: number; length?: number; center?: {x:number;y:number}; angle?: number }
    | { type: 'fillet'; radius?: number; edges?: 'all'|'none'|'some' }
    | { type: 'chamfer'; size?: number; edges?: 'all'|'none'|'some' }
  >
  mounting?: { surface?: 'wall'|'table'|'rail'|'custom'; holes?: number }
  tolerances?: { general?: number; hole_clearance?: number }
  notes?: string
}

function sysPromptSpec(): string {
  return `
You are a CAD requirements assistant. Your ONLY job is to:
1) Read the user's request + any prior spec, then produce an updated structured SPEC JSON.
2) Identify MISSING fields that prevent modeling.
3) Ask TARGETED questions to fill the missing fields.
NEVER generate code in this step. NEVER assume unknown dimensions. Use "units": "mm" unless user explicitly states inches.

Output STRICTLY this JSON with keys:
{
  "spec": <Spec>,
  "missing": string[],
  "questions": string[]
}

Rules:
- If the user asks for holes, you MUST require: hole diameter, hole count, and either positions OR a pattern + spacing. Also whether through or countersink.
- If the user asks for a bracket/plate, require overall.x/y/z (mm).
- Do NOT invent values. If unknown, list in "missing" and add a pointed question in "questions".
- Keep spec concise and cumulative.
`
}

function sysPromptCode(): string {
  return `
You are an OpenSCAD generator. Produce only valid OpenSCAD for the SPEC given.
Rules:
- Use millimeters if units == "mm".
- Include concise comments describing parameters and steps.
- Do not include prose or markdown—only code.
- Use named variables for key dims at the top.
- If features include holes: ensure positions are respected and diameters are correct; use translate() + cylinder() and difference().
- Code should be complete & renderable.
`
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: currentSpec }: { prompt: string; history?: Msg[]; spec?: Spec } =
      await req.json()

    // ---------------------------
    // Stage A: SPEC extraction
    // ---------------------------
    const messagesA: Msg[] = [
      { role: 'system', content: sysPromptSpec() },
      ...(history as Msg[]),
      { role: 'user', content: `User says: ${prompt}\n\nExisting spec (if any): ${JSON.stringify(currentSpec || {})}` },
    ]

    const resA = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 800,
        messages: messagesA,
      }),
    })

    const dataA = await resA.json()
    const contentA = dataA?.choices?.[0]?.message?.content || '{}'

    // Parse structured JSON
    let jsonA: { spec?: Spec; missing?: string[]; questions?: string[] } = {}
    try {
      jsonA = JSON.parse(contentA)
    } catch (e) {
      // fallback: try to recover JSON block
      const m = contentA.match(/\{[\s\S]*\}$/)
      if (m) {
        jsonA = JSON.parse(m[0])
      } else {
        throw new Error('Spec-extractor returned non-JSON.')
      }
    }

    const updatedSpec: Spec = jsonA.spec || {}
    const missing: string[] = jsonA.missing || []
    const questions: string[] = jsonA.questions || []

    if (missing.length > 0 || questions.length > 0) {
      // Still gathering requirements — return questions to the UI
      return NextResponse.json({
        type: 'questions',
        spec: updatedSpec,
        missing,
        questions,
        // Also provide a short assistant message to display
        content:
          questions.length > 0
            ? `Before I can generate the model, I need:\n- ${missing.join('\n- ')}\n\nQuestions:\n- ${questions.join('\n- ')}`
            : `I still need:\n- ${missing.join('\n- ')}`,
      })
    }

    // ---------------------------
    // Stage B: CODE generation (only when nothing is missing)
    // ---------------------------
    const messagesB: Msg[] = [
      { role: 'system', content: sysPromptCode() },
      { role: 'user', content: `SPEC:\n${JSON.stringify(updatedSpec, null, 2)}` },
    ]

    const resB = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.15,
        max_tokens: 1800,
        messages: messagesB,
      }),
    })

    const dataB = await resB.json()
    const code = dataB?.choices?.[0]?.message?.content || ''

    // Defensive check: make sure it looks like OpenSCAD
    const isLikelySCAD = /module|cube|cylinder|translate|difference|union|rotate|linear_extrude/i.test(code)

    return NextResponse.json({
      type: isLikelySCAD ? 'code' : 'questions',
      spec: updatedSpec,
      code: isLikelySCAD ? code : null,
      content: isLikelySCAD
        ? 'Here is the OpenSCAD code based on your confirmed specifications.'
        : 'The information is still incomplete; please answer the pending questions.',
    })
  } catch (err: any) {
    console.error('generate error', err)
    return NextResponse.json({ error: err?.message || 'Failed to generate' }, { status: 500 })
  }
}

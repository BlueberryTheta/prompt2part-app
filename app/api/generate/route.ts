import { NextRequest, NextResponse } from 'next/server'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }
type Spec = {
  units?: 'mm' | 'inch'
  part_type?: string
  overall?: { x?: number; y?: number; z?: number }
  features?: Array<
    | { type: 'hole'; diameter?: number; count?: number; pattern?: string; positions?: Array<{ x: number; y: number }>; through?: boolean; countersink?: boolean }
    | { type: 'slot'; width?: number; length?: number; center?: { x: number; y: number }; angle?: number }
    | { type: 'fillet'; radius?: number; edges?: string }
    | { type: 'chamfer'; size?: number; edges?: string }
  >
  mounting?: { surface?: string; holes?: number }
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
4) If the user asks a simple question, answer accordingly. NEVER generate code in this step. 

Output STRICTLY this JSON:
{
  "spec": <Spec>,
  "missing": string[],
  "questions": string[]
}
`.trim()
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
`.trim()
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: currentSpec }: { prompt: string; history?: Msg[]; spec?: Spec } =
      await req.json()

    const messagesA: Msg[] = [
      { role: 'system', content: sysPromptSpec() },
      ...(history || []),
      { role: 'user', content: `User says: ${prompt}\n\nExisting spec (if any): ${JSON.stringify(currentSpec || {})}` },
    ]

    console.log('🧠 Stage A: Extracting SPEC from OpenAI...')
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
    let contentA = dataA?.choices?.[0]?.message?.content ?? '{}'
    console.log('📝 Raw SPEC content:', contentA)

    let jsonA: { spec?: Spec; missing?: string[]; questions?: string[] } = {}

    try {
      jsonA = JSON.parse(contentA)
    } catch {
      const fallbackMatch = contentA.match(/\{[\s\S]*?\}/)
      if (fallbackMatch) {
        try {
          jsonA = JSON.parse(fallbackMatch[0])
        } catch (e2) {
          throw new Error('Spec content includes invalid or partial JSON (check for trailing commas, unquoted keys, or nulls).')
        }
      } else {
        throw new Error('Spec-extractor returned malformed output.')
      }
    }

    const updatedSpec: Spec = jsonA.spec || {}
    const missing: string[] = jsonA.missing || []
    const questions: string[] = jsonA.questions || []

    console.log('✅ Parsed SPEC:', updatedSpec)
    console.log('❓ Missing:', missing)
    console.log('❓ Questions:', questions)

    if (missing.length > 0 || questions.length > 0) {
      return NextResponse.json({
        type: 'questions',
        spec: updatedSpec,
        missing,
        questions,
        content:
          questions.length > 0
            ? `Before I can generate the model, I need:\n- ${missing.join('\n- ')}\n\nQuestions:\n- ${questions.join('\n- ')}`
            : `I still need:\n- ${missing.join('\n- ')}`,
      })
    }

    // -------------------
    // Stage B: OpenSCAD
    // -------------------
    const messagesB: Msg[] = [
      { role: 'system', content: sysPromptCode() },
      { role: 'user', content: `SPEC:\n${JSON.stringify(updatedSpec, null, 2)}` },
    ]

    console.log('🧱 Stage B: Generating OpenSCAD code...')
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
    const code = dataB?.choices?.[0]?.message?.content ?? ''
    const isLikelySCAD = /cube|cylinder|translate|difference|module|linear_extrude/i.test(code)

    console.log('🔧 Generated Code:', code.slice(0, 200) + '...')

    return NextResponse.json({
      type: isLikelySCAD ? 'code' : 'questions',
      spec: updatedSpec,
      code: isLikelySCAD ? code : null,
      content: isLikelySCAD
        ? 'Here is the OpenSCAD code based on your confirmed specifications.'
        : 'The information is still incomplete; please answer the pending questions.',
    })
  } catch (err: any) {
    console.error('🛑 /api/generate error:', err)
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// app/api/generate/route.ts
import { NextRequest, NextResponse } from 'next/server'

/**
 * ===== Model selection =====
 * Defaults to GPT-5 for both steps, but you can override per-env if needed.
 * On Vercel, set:
 *   OPENAI_SPEC_MODEL=gpt-5
 *   OPENAI_CODE_MODEL=gpt-5
 *   OPENAI_API_KEY=sk-...
 */
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const SPEC_MODEL = process.env.OPENAI_SPEC_MODEL || 'gpt-5'
const CODE_MODEL = process.env.OPENAI_CODE_MODEL || 'gpt-5'

// Basic message type for history passthrough
type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

// Your working Spec type
export type Spec = {
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

// ---------- System prompts ----------
function sysPromptSpec(): string {
  return `
You are a CAD requirements assistant. Your ONLY job is to:
1) Read the user's request + prior spec, then produce an UPDATED structured SPEC JSON.
2) Identify MISSING fields that prevent modeling.
3) Ask TARGETED questions to fill the missing fields.

IMPORTANT:
- NEVER output code.
- NEVER invent values. If unknown, leave null/omit and add to "missing" + "questions".
- Default units to "mm" unless explicitly "inch".

Return STRICT JSON, no markdown, with keys exactly:
{
  "spec": <Spec>,
  "missing": string[],
  "questions": string[]
}

Validation rules:
- If user mentions holes, require diameter, count, and either positions OR pattern+spacing. Ask if through/countersink.
- For bracket/plate-like parts, require overall.x/y/z (mm).
- Keep spec cumulative: merge previous spec with new info; do not discard known values.
`.trim()
}

function sysPromptCode(): string {
  return `
You are an OpenSCAD generator. Produce ONLY valid OpenSCAD code for the given SPEC.

Rules:
- Use mm if units == "mm".
- Include concise comments.
- Use named variables for key dims at the top.
- If there are holes: respect positions & diameters; use translate()+cylinder() inside difference() for cuts.
- Output ONLY code (no markdown, no fences, no prose). The response must be directly compilable by OpenSCAD.
`.trim()
}

// ---------- Utilities ----------
function stripCodeFences(s: string): string {
  // remove ```...``` if the model "helps"
  const m = s.match(/```(?:scad|openscad)?\n([\s\S]*?)```/i)
  if (m) return m[1].trim()
  return s.trim()
}

function safeLog(label: string, payload: unknown, max = 1000) {
  try {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    // eslint-disable-next-line no-console
    console.log(`[generate] ${label}:`, s.length > max ? s.slice(0, max) + '…(truncated)' : s)
  } catch {
    // eslint-disable-next-line no-console
    console.log(`[generate] ${label}: (unserializable)`)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.prompt !== 'string') {
      return NextResponse.json({ error: 'Missing "prompt" in request body.' }, { status: 400 })
    }

    const {
      prompt,
      history = [],
      spec: currentSpec,
    }: { prompt: string; history?: Msg[]; spec?: Spec } = body

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'Missing OPENAI_API_KEY on server.' }, { status: 500 })
    }

    // ---------- Stage A: SPEC extraction (GPT-5) ----------
    const messagesA: Msg[] = [
      { role: 'system', content: sysPromptSpec() },
      ...(Array.isArray(history) ? history : []),
      {
        role: 'user',
        content: `User says: ${prompt}\n\nExisting spec (if any): ${JSON.stringify(currentSpec || {})}`,
      },
    ]

    safeLog('STEP A model', SPEC_MODEL)
    safeLog('STEP A messages', messagesA)

    const resA = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: SPEC_MODEL,
        temperature: 0.1,
        max_tokens: 900,
        messages: messagesA,
        // Force JSON output (supported on current GPT-5/4.1 stacks)
        response_format: { type: 'json_object' },
      }),
    })

    if (!resA.ok) {
      const txt = await resA.text().catch(() => '')
      safeLog('STEP A HTTP Error', { status: resA.status, txt })
      return NextResponse.json({ error: `Spec step failed: ${resA.status} ${txt}` }, { status: 500 })
    }

    const dataA = await resA.json()
    const contentA = dataA?.choices?.[0]?.message?.content?.trim() || '{}'
    safeLog('STEP A raw content', contentA)

    // Parse JSON strictly; fallback to best-effort if the model slipped
    let jsonA: { spec?: Spec; missing?: string[]; questions?: string[] } = {}
    try {
      jsonA = JSON.parse(contentA)
    } catch {
      const block = contentA.match(/\{[\s\S]*\}$/)?.[0]
      if (!block) {
        return NextResponse.json(
          { error: '❌ Spec content includes invalid or partial JSON.' },
          { status: 500 }
        )
      }
      jsonA = JSON.parse(block)
    }

    const updatedSpec: Spec = jsonA.spec || {}
    const missing: string[] = Array.isArray(jsonA.missing) ? jsonA.missing : []
    const questions: string[] = Array.isArray(jsonA.questions) ? jsonA.questions : []

    safeLog('STEP A parsed spec', updatedSpec)
    safeLog('STEP A missing', missing)
    safeLog('STEP A questions', questions)

    if (missing.length > 0 || questions.length > 0) {
      // We’re still clarifying; return questions to UI
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

    // ---------- Stage B: OpenSCAD code generation (GPT-5) ----------
    const messagesB: Msg[] = [
      { role: 'system', content: sysPromptCode() },
      { role: 'user', content: `SPEC:\n${JSON.stringify(updatedSpec, null, 2)}` },
    ]

    safeLog('STEP B model', CODE_MODEL)
    safeLog('STEP B messages', messagesB)

    const resB = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: CODE_MODEL,
        temperature: 0.1,
        max_tokens: 2000,
        messages: messagesB,
      }),
    })

    if (!resB.ok) {
      const txt = await resB.text().catch(() => '')
      safeLog('STEP B HTTP Error', { status: resB.status, txt })
      return NextResponse.json({ error: `Code step failed: ${resB.status} ${txt}` }, { status: 500 })
    }

    const dataB = await resB.json()
    const rawCode = dataB?.choices?.[0]?.message?.content || ''
    safeLog('STEP B raw code (truncated)', rawCode.slice(0, 1500))

    // Remove code fences if the model added them
    const code = stripCodeFences(rawCode)

    // Quick sanity check that it looks like OpenSCAD
    const isLikelySCAD = /cube|cylinder|translate|difference|union|rotate|linear_extrude|module/i.test(code)

    return NextResponse.json({
      type: isLikelySCAD ? 'code' : 'questions',
      spec: updatedSpec,
      code: isLikelySCAD ? code : null,
      content: isLikelySCAD
        ? 'Here is the OpenSCAD code based on your confirmed specifications.'
        : 'I still need clarification before I can generate valid code.',
    })
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('🛑 /api/generate fatal error:', err)
    return NextResponse.json(
      { error: err?.message || 'Server error' },
      { status: 500 }
    )
  }
}

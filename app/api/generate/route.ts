// app/api/generate/route.ts
import { NextRequest, NextResponse } from 'next/server'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o' // or gpt-4o-mini

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

// What we persist across turns
export type Spec = {
  units?: 'mm' | 'inch'
  part_type?: string
  overall?: { x?: number; y?: number; z?: number } // mm
  features?: Array<
    | { type: 'hole'; diameter?: number; position?: { x: number; y: number }; count?: number; through?: boolean; countersink?: boolean }
    | { type: 'slot'; width?: number; length?: number; center?: { x: number; y: number }; angle?: number }
    | { type: 'fillet'; radius?: number; edges?: 'all' | 'none' | 'some' }
    | { type: 'chamfer'; size?: number; edges?: 'all' | 'none' | 'some' }
    | { type: 'cube'; side_length?: number; position?: any }
    | { type: 'cylinder'; diameter?: number; height?: number; position?: any; operation?: 'boss'|'cut' }
  >
  // Some models have returned { cube: {...}, cylinder: {...} } at top-level; we’ll normalize that.
  cube?: { side_length?: number, position?: any }
  cylinder?: { diameter?: number, height?: number, position?: any, operation?: 'boss'|'cut' }
  tolerances?: { general?: number; hole_clearance?: number }
  notes?: string
}

type ApiReq = {
  prompt: string
  history?: Msg[]
  spec?: Spec
  selection?: { faceIndex?: number; point?: [number, number, number] }
}

type ApiResp =
  | {
      type: 'answer' | 'questions' | 'code'
      assistant_text: string
      spec: Spec
      assumptions?: string[]
      questions?: string[]
      code?: string
      actions?: string[]
    }
  | { error: string }

// ---------- helpers ----------

function normalizeSpec(spec: Spec | undefined): Spec {
  if (!spec) return { units: 'mm', features: [] }
  const units = spec.units ?? 'mm'
  const features: NonNullable<Spec['features']> = Array.isArray(spec.features) ? [...spec.features] : []

  // Accept alternate shapes like { cube: {...}, cylinder: {...} }
  const tryPush = (obj: any) => {
    const t = (obj?.type || '').toString().toLowerCase()
    if (!t) return
    features.push(obj)
  }

  if (spec.cube && typeof spec.cube === 'object') {
    tryPush({ type: 'cube', ...spec.cube })
  }
  if (spec.cylinder && typeof spec.cylinder === 'object') {
    tryPush({ type: 'cylinder', ...spec.cylinder })
  }

  return { ...spec, units, features }
}

function sysPromptClassifier() {
  return `
You are an intent classifier for a CAD assistant.
Decide if the user's message is:
- "question" (they're asking about design choices or best practices)
- "change" (they want to modify or create the model)
- "ambiguous" (not enough info to tell)

Return STRICT JSON: {"intent":"question"|"change"|"ambiguous","reason":"<short>"}`.trim()
}

function sysPromptSpecMerge() {
  return `
You are a CAD spec editor. Merge the new user request into the existing SPEC.

Rules:
- Keep units consistent. Default to "mm" if not provided.
- Do not ask about material options.
- Do NOT change or infer existing global dimensions, features, or geometry unless the user explicitly requests a change.
- Defaults may be added ONLY for NEW feature-local fields that are strictly required and must be listed in "assumptions".
- Resolve ellipsis/pronouns using LAST_ASSISTANT_TEXT and UI_SELECTED_FACE:
  - If the user says "yes", "do it", "center", etc., apply it to the most recently requested/asked feature or dimension in LAST_ASSISTANT_TEXT.
  - If UI_SELECTED_FACE is provided (e.g., G5), treat it as the face reference for "this face"/"center of that face" for this turn.
  - "center" on a face means the geometric centroid of that planar face.
- If required info is missing for code, add explicit items to "missing" and ask pointed "questions". Keep questions minimal and propose sensible defaults.
- NEVER output code here.

Output STRICT JSON:
{
  "spec": <merged spec>,
  "assumptions": string[],
  "questions": string[]
}`.trim()
}

function sysPromptCode() {
  return `
You are an OpenSCAD generator. Produce only valid OpenSCAD.

Rules:
- Use millimeters if units == "mm".
- Start with a Parameters section that declares every symbol you use (e.g., side_length, cylinder_diameter, cylinder_height, cube_half_side, etc.). Do not reference any undefined identifiers.
- Result must be a SINGLE, closed, 3D manifold suitable for FDM printing.
- New features must be Boolean-combined with the main body in ONE top-level CSG (use union()/difference()).
- When attaching features (boss), push into the host by >= 0.3 mm and union() so they fuse. For cuts, use difference().
- Do not use 2D primitives (square/circle/polygon) without linear_extrude() or rotate_extrude().
- If a feature references a face center, place it at that face's centroid.
- Preserve existing spec values; do not change dimensions unless explicitly requested.
- Do NOT invent global dimensions; use SPEC as-is.
- Do NOT include Markdown or triple backticks. Return raw OpenSCAD only.
- Do NOT set $fn; the caller controls tessellation.
- No prose. RETURN ONLY CODE.
- Never include comments like "(removed invalid geometry assignment)".

If SELECTION is provided, use it to place geometry on the specified face/region.`.trim()
}

async function openai(messages: Msg[], max_tokens = 1200, temperature = 0.2) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, max_tokens, temperature }),
  })
  const json = await res.json()
  return json?.choices?.[0]?.message?.content ?? ''
}

function safeParseJson(jsonish: string) {
  const match = jsonish.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON block found')
  return JSON.parse(match[0])
}

function looksLikeSCAD(code: string) {
  return /cube|cylinder|translate|difference|union|rotate|linear_extrude/i.test(code)
}

// --- simple code repair utilities ---

function hasIdentifierUse(code: string, name: string) {
  const re = new RegExp(`\\b${name}\\b`)
  return re.test(code)
}
function hasIdentifierDef(code: string, name: string) {
  const re = new RegExp(`\\b${name}\\s*=`, 'i')
  return re.test(code)
}

function findCubeSideLength(spec: Spec): number | undefined {
  const arr = spec.features || []
  for (const f of arr) {
    if ((f as any)?.type?.toString().toLowerCase() === 'cube') {
      const sl = (f as any)?.side_length
      if (typeof sl === 'number' && isFinite(sl)) return sl
    }
  }
  // also allow spec.cube
  const sl2 = (spec as any)?.cube?.side_length
  if (typeof sl2 === 'number' && isFinite(sl2)) return sl2
  return undefined
}

function findCylinderDims(spec: Spec): { d?: number; h?: number } {
  let d: number | undefined
  let h: number | undefined
  const arr = spec.features || []
  for (const f of arr) {
    if ((f as any)?.type?.toString().toLowerCase() === 'cylinder') {
      const dd = (f as any)?.diameter
      const hh = (f as any)?.height
      if (typeof dd === 'number' && isFinite(dd)) d = dd
      if (typeof hh === 'number' && isFinite(hh)) h = hh
    }
  }
  // also allow spec.cylinder
  const c2 = (spec as any)?.cylinder
  if (c2) {
    if (typeof c2.diameter === 'number' && isFinite(c2.diameter)) d = c2.diameter
    if (typeof c2.height === 'number' && isFinite(c2.height)) h = c2.height
  }
  return { d, h }
}

/**
 * Inject missing parameter definitions if code references them but doesn't define them,
 * pulling values from SPEC where possible. This avoids render-time "Parser error".
 */
function repairScadIfNeeded(code: string, spec: Spec) {
  let header = ''
  const notes: string[] = []

  // side_length
  if (hasIdentifierUse(code, 'side_length') && !hasIdentifierDef(code, 'side_length')) {
    const sl = findCubeSideLength(spec)
    if (sl != null) {
      header += `side_length = ${sl};\n`
      notes.push('injected side_length from spec')
    } else {
      header += `side_length = 50;\n`
      notes.push('injected default side_length=50')
    }
  }
  // cube_half_side
  if (hasIdentifierUse(code, 'cube_half_side') && !hasIdentifierDef(code, 'cube_half_side')) {
    if (!hasIdentifierDef(code, 'side_length')) {
      // If side_length not injected yet, add a safe default
      header += `side_length = 50;\n`
      notes.push('injected default side_length=50 for cube_half_side')
    }
    header += `cube_half_side = side_length / 2;\n`
    notes.push('injected cube_half_side')
  }
  // cylinder_diameter
  if (hasIdentifierUse(code, 'cylinder_diameter') && !hasIdentifierDef(code, 'cylinder_diameter')) {
    const { d } = findCylinderDims(spec)
    if (d != null) {
      header += `cylinder_diameter = ${d};\n`
      notes.push('injected cylinder_diameter from spec')
    } else {
      header += `cylinder_diameter = 10;\n`
      notes.push('injected default cylinder_diameter=10')
    }
  }
  // cylinder_height
  if (hasIdentifierUse(code, 'cylinder_height') && !hasIdentifierDef(code, 'cylinder_height')) {
    const { h } = findCylinderDims(spec)
    if (h != null) {
      header += `cylinder_height = ${h};\n`
      notes.push('injected cylinder_height from spec')
    } else {
      header += `cylinder_height = 10;\n`
      notes.push('injected default cylinder_height=10')
    }
  }

  if (!header) return { code, notes }
  return { code: `${header}\n${code}`, notes }
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: incoming = {}, selection } = (await req.json()) as ApiReq

    // 1) classify intent
    const classifyMsg: Msg[] = [
      { role: 'system', content: sysPromptClassifier() },
      ...history,
      { role: 'user', content: prompt },
    ]
    const clsRaw = await openai(classifyMsg, 200, 0.1)
    let intent: 'question' | 'change' | 'ambiguous' = 'ambiguous'
    try {
      const parsed = safeParseJson(clsRaw)
      intent = parsed.intent
    } catch {
      intent = 'ambiguous'
    }

    // Normalize incoming spec shape early
    const incomingSpec = normalizeSpec(incoming)

    // 2) handle pure question
    if (intent === 'question') {
      const qaMsg: Msg[] = [
        {
          role: 'system',
          content:
            'You are a helpful CAD assistant. Answer the user’s question briefly and concretely for 3D printable parts. No code, no JSON.',
        },
        ...history,
        { role: 'user', content: prompt },
      ]
      const answer = await openai(qaMsg, 500, 0.3)
      return NextResponse.json({
        type: 'answer',
        assistant_text: answer?.trim() || 'Here are a few suggestions.',
        spec: incomingSpec,
        actions: ['answered_question'],
      } satisfies ApiResp)
    }

    // 3) merge/update spec
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || ''
    const uiFaceHint =
      selection?.faceIndex != null
        ? `UI_SELECTED_FACE: G${selection.faceIndex}${selection?.point ? ` @ ${JSON.stringify(selection.point)}` : ''}`
        : 'UI_SELECTED_FACE: none'

    const mergeMsg: Msg[] = [
      { role: 'system', content: sysPromptSpecMerge() },
      {
        role: 'user',
        content:
          `EXISTING_SPEC:\n` +
          JSON.stringify(incomingSpec || {}, null, 2) +
          `\n\nLAST_ASSISTANT_TEXT:\n` +
          lastAssistant +
          `\n\n${uiFaceHint}` +
          (selection ? `\n\nSELECTION:\n${JSON.stringify(selection, null, 2)}` : '') +
          `\n\nUSER_REQUEST:\n` +
          prompt,
      },
    ]
    const mergedRaw = await openai(mergeMsg, 900, 0.1)

    let mergedSpec: Spec = incomingSpec
    let assumptions: string[] = []
    let missing: string[] = []
    let questions: string[] = []
    try {
      const parsed = safeParseJson(mergedRaw)
      mergedSpec = normalizeSpec(parsed.spec || incomingSpec)
      assumptions = parsed.assumptions || []
      missing = parsed.missing || []
      questions = parsed.questions || []
    } catch (e: any) {
      console.error('Spec merge parse error:', e?.message, mergedRaw)
      return NextResponse.json({ error: 'Spec merge failed: invalid JSON' } as ApiResp, { status: 500 })
    }

    // Cap question count
    if (questions.length > 2) questions = questions.slice(0, 2)

    if (intent === 'ambiguous' || (missing.length > 0 || questions.length > 0)) {
      const msg = [
        assumptions.length ? `Assumptions applied:\n- ${assumptions.join('\n- ')}` : null,
        missing.length ? `I still need:\n- ${missing.join('\n- ')}` : null,
        questions.length ? `Questions:\n- ${questions.join('\n- ')}` : null,
      ]
        .filter(Boolean)
        .join('\n\n')

      return NextResponse.json({
        type: 'questions',
        assistant_text: msg || 'I need a bit more info.',
        spec: mergedSpec,
        assumptions,
        questions,
        actions: ['merged_spec', assumptions.length ? 'applied_defaults' : 'no_defaults'],
      } satisfies ApiResp)
    }

    // 4) generate code
    const codeMsg: Msg[] = [
      { role: 'system', content: sysPromptCode() },
      {
        role: 'user',
        content:
          (selection ? `SELECTION:\n${JSON.stringify(selection, null, 2)}\n\n` : '') +
          `SPEC:\n${JSON.stringify(mergedSpec, null, 2)}`,
      },
    ]
    let codeRaw = await openai(codeMsg, 1800, 0.1)

    // Strip fences / $fn
    const raw = (codeRaw || '').trim()
    let code = raw
    const m = raw.match(/```(?:openscad|scad)?\s*([\s\S]*?)```/i)
    if (m) code = m[1].trim()
    code = code.replace(/^\s*\$fn\s*=\s*[^;]+;\s*/gmi, '')

    // Repair pass: inject missing parameter definitions for used-but-undefined symbols
    const repaired = repairScadIfNeeded(code, mergedSpec)
    if (repaired.notes.length) {
      code = repaired.code
    }

    // Basic sanity check
    if (!looksLikeSCAD(code)) {
      return NextResponse.json({
        type: 'questions',
        assistant_text: 'I still need a bit more info before I can safely generate code.',
        spec: mergedSpec,
        questions: ['Please clarify missing geometry details.'],
        actions: ['merged_spec', 'code_check_failed'],
      } satisfies ApiResp)
    }

    return NextResponse.json({
      type: 'code',
      assistant_text: assumptions.length
        ? `Updated the model. I applied:\n- ${assumptions.join('\n- ')}`
        : 'Updated the model.',
      spec: mergedSpec,
      assumptions,
      code,
      actions: ['merged_spec', assumptions.length ? 'applied_defaults' : 'no_defaults', ...(repaired.notes.length ? ['repaired_code'] : []), 'generated_code'],
    } satisfies ApiResp)
  } catch (err: any) {
    console.error('🛑 /api/generate fatal error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

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
  >
  tolerances?: { general?: number; hole_clearance?: number }
  notes?: string
}

type ApiReq = {
  prompt: string
  history?: Msg[]
  spec?: Spec // last known spec from client
  // Optional selection from PartViewer (face id / pick point)
  selection?: { faceIndex?: number; point?: [number, number, number] }
}

type ApiResp =
  | {
      type: 'answer' | 'questions' | 'code'
      assistant_text: string // always provide something readable
      spec: Spec // always echo back merged spec
      assumptions?: string[] // when assistant applied small defaults
      questions?: string[] // when more info is needed
      code?: string // when we produced OpenSCAD
      actions?: string[] // log what we did (merge, defaults, codegen)
    }
  | { error: string }

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
- Defaults may be added ONLY for NEW feature-local fields that are strictly required (e.g., a handle's width/length/thickness) and must be listed in "assumptions".
- Never infer capacity/volume or compute new global dimensions from formulas unless the SPEC already includes an explicit target for that quantity (e.g., target_volume_ml).
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
- Start with clear named parameters.
- Result must be a SINGLE, closed, 3D manifold suitable for FDM printing.
- New features must be Boolean-combined with the main body in ONE top-level CSG (e.g., union()/difference()).
- When attaching features (e.g., handles, bosses), push them into the host by >= 0.3 mm and union() so they fuse; never leave touching/coincident surfaces.
- Do not use 2D primitives (square/circle/polygon) without linear_extrude() or rotate_extrude().
- If a feature references a face center, place it at that face's centroid.
- For holes/slots, subtract with difference() and ensure through-cuts where requested.
- Preserve existing spec values; do not change dimensions unless explicitly requested.
- Do NOT invent or recompute global dimensions from formulas unless the SPEC explicitly provides that target (e.g., target_volume_ml). If absent, use SPEC as-is.
- When hollowing a feature (e.g., handle loop), subtract a STRICTLY smaller inner solid (shrink in all axes by the shell), never larger.
- Never place attachments using a positive "offset" away from the host (e.g., mug_diameter/2 + offset). Instead, compute the attach position so the part penetrates the host by an overlap: for a cylinder use x_attach = (outer_diameter/2 - wall_thickness) - attach_overlap, where attach_overlap >= 0.3 mm.
- 2D ops (offset/square/circle/polygon) MUST be inside linear_extrude() or rotate_extrude(). Avoid offset-based shells on 2D unless extruded.
- Do NOT include Markdown or triple backticks. Return raw OpenSCAD only.
- Do NOT set $fn; the caller controls tessellation.
- No prose. No questions. RETURN ONLY CODE.

- For hollow shells (outer wall + inner cavity), attachments must reference the OUTER surface, not the inner wall. Use:
  outer_r = outer_diameter/2;
  inner_r = outer_r - wall_thickness;
  attach_overlap >= 0.3;
  x_attach = outer_r - attach_overlap; // overlap into the outer wall only

- Never allow an attachment to penetrate the inner cavity unless explicitly requested. Enforce:
  (attach_overlap + local_half_thickness) <= (wall_thickness - 0.2);
  If this cannot be satisfied, reduce the local feature thickness or ask for clarification instead of breaching the cavity.

- If SELECTION is provided, use it to place geometry on the specified face/region; do not ignore it.`.trim()
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
  // Extract largest JSON block if model added fluff
  const match = jsonish.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON block found')
  return JSON.parse(match[0])
}

function looksLikeSCAD(code: string) {
  return /cube|cylinder|translate|difference|union|rotate|linear_extrude/i.test(code)
}

/**
 * Rewrites invalid "geometry assignment" patterns into valid statements and
 * inlines references in any top-level CSG. Also creates a top-level union()
 * when geometry exists but no top-level CSG is present.
 *
 * Example in:
 *   a = cube(10);
 *   b = translate([0,0,5]) cylinder(d=5,h=10);
 *   union(){ a; b; }
 *
 * Example out:
 *   // a = cube(10);  (removed)
 *   // b = ...
 *   union(){
 *     cube(10);
 *     translate([0,0,5]) cylinder(d=5,h=10);
 *   }
 */
function sanitizeAndInlineOpenSCAD(code: string): { code: string; changed: boolean } {
  let changed = false
  let src = code

  // 1) Collect assignments (name = <expr>;), multi-line safe (non-greedy up to first semicolon)
  //    We'll allow comments and whitespace between tokens.
  const assignRe = /(^|\n)\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*?)\s*;\s*/g
  const assignments = new Map<string, string>()
  let m: RegExpExecArray | null
  while ((m = assignRe.exec(src)) !== null) {
    const varName = m[2]
    const rhs = m[3].trim()
    if (varName && rhs) assignments.set(varName, rhs)
  }

  if (assignments.size > 0) {
    changed = true
    // 2) Remove the assignment lines from the source
    src = src.replace(assignRe, (full) => {
      // Keep a comment placeholder to ease debugging
      return full.startsWith('\n') ? '\n// (removed invalid geometry assignment)\n' : '// (removed invalid geometry assignment)\n'
    })

    // 3) Inline references "name;" with the captured RHS "rhs;"
    //    We do this globally, but only for stand-alone statements ending with ';'
    for (const [name, rhs] of assignments) {
      const refRe = new RegExp(`(^|\\n)\\s*${name}\\s*;\\s*`, 'g')
      src = src.replace(refRe, (_full, pre) => `${pre}${rhs};\n`)
    }
  }

  // 4) If there is no top-level CSG (union/difference/intersection) but geometry statements exist,
  //    wrap the whole thing in union(){ ... }
  const hasTopCSG = /\b(?:union|difference|intersection)\s*\(/m.test(src)
  const hasSomeGeom =
    /\b(?:translate|rotate|scale|mirror|hull|minkowski|cube|cylinder|sphere|polyhedron|linear_extrude|rotate_extrude)\s*\(/m.test(
      src
    )

  if (!hasTopCSG && hasSomeGeom) {
    changed = true
    src = `union(){\n${src}\n}\n`
  }

  return { code: src, changed }
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: incomingSpec = {}, selection } = (await req.json()) as ApiReq

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

    // 2) handle pure question early (no spec change)
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

    // Build recency/ellipsis helpers
    const lastAssistant =
      [...history].reverse().find((m) => m.role === 'assistant')?.content || ''
    const uiFaceHint =
      selection?.faceIndex != null
        ? `UI_SELECTED_FACE: G${selection.faceIndex}${
            selection?.point ? ` @ ${JSON.stringify(selection.point)}` : ''
          }`
        : 'UI_SELECTED_FACE: none'

    // 3) merge/update spec (for "change" or "ambiguous")
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
      mergedSpec = parsed.spec || incomingSpec
      assumptions = parsed.assumptions || []
      missing = parsed.missing || []
      questions = parsed.questions || []
    } catch (e: any) {
      console.error('Spec merge parse error:', e?.message, mergedRaw)
      return NextResponse.json(
        { error: 'Spec merge failed: invalid JSON' } as ApiResp,
        { status: 500 }
      )
    }

    // Cap question count to keep the flow tight
    if (questions.length > 2) questions = questions.slice(0, 2)

    // If still missing info or ambiguous, ask questions (no code)
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

    // 4) generate code if spec is good
    const codeMsg: Msg[] = [
      { role: 'system', content: sysPromptCode() },
      {
        role: 'user',
        content:
          (selection ? `SELECTION:\n${JSON.stringify(selection, null, 2)}\n\n` : '') +
          `SPEC:\n${JSON.stringify(mergedSpec, null, 2)}`,
      },
    ]
    const codeRaw = await openai(codeMsg, 1800, 0.1)

    // Strip fences / $fn
    const raw = (codeRaw || '').trim()
    let code = raw
    const m = raw.match(/```(?:openscad|scad)?\s*([\s\S]*?)```/i)
    if (m) code = m[1].trim()
    code = code.replace(/^\s*\$fn\s*=\s*[^;]+;\s*/gmi, '')

    // Fix invalid geometry-assignment style and inline references
    const normalized = sanitizeAndInlineOpenSCAD(code)
    if (normalized.changed) code = normalized.code

    function breachesInnerWallPattern(code: string) {
      const innerRef = /\bmug_diameter\s*\/\s*2\s*-\s*wall_thickness\s*-\s*[\w\.]+\b/i.test(code)
      const naiveInnerR = /\binner_r\b.*translate\(\s*\[\s*inner_r\b/i.test(code)
      return innerRef || naiveInnerR ? 'inner_wall_reference' : null
    }

    const innerBreach = breachesInnerWallPattern(code)
    if (innerBreach) {
      return NextResponse.json({
        type: 'questions',
        assistant_text:
          'Your attachment was placed relative to the inner wall, which would breach the cavity. ' +
          'Please specify an attach overlap into the **outer** wall (e.g., 0.5 mm), or say "use default overlap".',
        spec: mergedSpec,
        questions: ['Attach overlap into the OUTER wall (mm)? (Typical: 0.3–0.8)'],
        actions: ['merged_spec', 'policy_guard_triggered', innerBreach],
      } satisfies ApiResp)
    }

    function violatesAttachPolicy(code: string) {
      const floatAway = /translate\(\s*\[\s*mug_diameter\s*\/\s*2\s*\+\s*[\w\.]+\s*,/i.test(code)
      const usesHandleOffset =
        /\bhandle_offset\b/i.test(code) && /mug_diameter\s*\/\s*2\s*\+\s*handle_offset/i.test(code)
      return floatAway || usesHandleOffset ? 'float_attach' : null
    }

    const attachIssue = violatesAttachPolicy(code)
    if (attachIssue) {
      return NextResponse.json({
        type: 'questions',
        assistant_text:
          'The attachment was placed away from the body. Please confirm an attach overlap (e.g., 0.5 mm), or say "use default overlap". I will regenerate with a fused attachment.',
        spec: mergedSpec,
        questions: ['Attach overlap into the wall (mm)? (Typical: 0.3–0.8)'],
        actions: ['merged_spec', 'policy_guard_triggered', attachIssue],
      } satisfies ApiResp)
    }

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
      actions: ['merged_spec', assumptions.length ? 'applied_defaults' : 'no_defaults', 'generated_code']
    } satisfies ApiResp)
  } catch (err: any) {
    console.error('🛑 /api/generate fatal error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

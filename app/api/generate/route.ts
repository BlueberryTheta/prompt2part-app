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
  // ▼▼▼ ADDED: optional selection from PartViewer (face id / pick point)
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

Return STRICT JSON: {"intent":"question"|"change"|"ambiguous","reason":"<short>"}`
    .trim()
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
- If required info is missing for code, add explicit items to "missing" and ask pointed "questions".
- NEVER output code here.
- If SELECTION (faceIndex/point) is provided, treat it as the target surface/region for the user's feature. If placement data is insufficient, add specific items to "missing"/"questions" rather than guessing.

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
- For holes/slots, subtract with difference() and ensure through-cuts where requested.
- Preserve existing spec values; do not change dimensions unless explicitly requested.
- Use difference() for holes/slots; respect positions, diameters, thickness, etc.
- Do NOT invent or recompute global dimensions from formulas unless the SPEC explicitly provides that target (e.g., target_volume_ml). If absent, use SPEC as-is.
- When hollowing a feature (e.g., handle loop), subtract a STRICTLY smaller inner solid (shrink in all axes by the shell), never larger.
- Never place attachments using a positive "offset" away from the host (e.g., mug_diameter/2 + offset). Instead, compute the attach position so the part penetrates the host by an overlap: for a cylinder use x_attach = (outer_diameter/2 - wall_thickness) - attach_overlap, where attach_overlap >= 0.3 mm.
- 2D ops (offset/square/circle/polygon) MUST be inside linear_extrude() or rotate_extrude(). Avoid offset-based shells on 2D unless extruded.
- Do NOT include Markdown or triple backticks. Return raw OpenSCAD only.
- Do NOT set $fn; the caller controls tessellation.
- No prose. No Markdown. RETURN ONLY CODE.

- For hollow shells (outer wall + inner cavity), attachments must reference the OUTER surface, not the inner wall. Use:
  outer_r = outer_diameter/2;
  inner_r = outer_r - wall_thickness;
  attach_overlap >= 0.3;
  x_attach = outer_r - attach_overlap; // overlap into the outer wall only

- Never allow an attachment to penetrate the inner cavity unless explicitly requested. Enforce:
  (attach_overlap + local_half_thickness) <= (wall_thickness - 0.2);
  If this cannot be satisfied, reduce the local feature thickness or ask for clarification instead of breaching the cavity.

- If SELECTION is provided, use it to place geometry on the specified face/region; do not ignore it. If placement remains ambiguous, do not guess—adhere to SPEC and prior clarified constraints.`
    .trim()
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

export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: incomingSpec = {}, selection } = (await req.json()) as ApiReq
    // ^^^^^^^ ADDED: selection pulled from request body

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
    } catch (e) {
      // if classifier failed, consider ambiguous to be safe
      intent = 'ambiguous'
    }

    // 2) handle pure question early (no spec change)
    if (intent === 'question') {
      // answer conversationally but succinctly
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

    // 3) merge/update spec (for "change" or "ambiguous")
    const mergeMsg: Msg[] = [
      { role: 'system', content: sysPromptSpecMerge() },
      {
        role: 'user',
        content:
          `EXISTING_SPEC:\n` +
          JSON.stringify(incomingSpec || {}, null, 2) +
          (selection ? `\n\nSELECTION:\n${JSON.stringify(selection, null, 2)}` : '') + // <<< ADDED
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
      return NextResponse.json({
        error: 'Spec merge failed: invalid JSON',
      } as ApiResp, { status: 500 })
    }

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
  { role: 'user', content: 
    (selection ? `SELECTION:\n${JSON.stringify(selection, null, 2)}\n\n` : '') + // <<< ADDED
    `SPEC:\n${JSON.stringify(mergedSpec, null, 2)}` },
]
const codeRaw = await openai(codeMsg, 1800, 0.1)

// Strip unnecessary fences or whitespace
const raw = (codeRaw || '').trim();

// Prefer extracting inside a fenced block if present
let code = raw;
const m = raw.match(/```(?:openscad|scad)?\s*([\s\S]*?)```/i);
if (m) code = m[1].trim();

// Remove any $fn the model set; the client controls tessellation
code = code.replace(/^\s*\$fn\s*=\s*[^;]+;\s*/gmi, '');

function breachesInnerWallPattern(code: string) {
  // Common bad placement: using inner wall as origin (outer/2 - wall_thickness - overlap)
  const innerRef = /\bmug_diameter\s*\/\s*2\s*-\s*wall_thickness\s*-\s*[\w\.]+\b/i.test(code);

  // Also catch any explicit "inner_r" placement without clearance math
  const naiveInnerR = /\binner_r\b.*translate\(\s*\[\s*inner_r\b/i.test(code);

  return innerRef || naiveInnerR ? 'inner_wall_reference' : null;
}

const innerBreach = breachesInnerWallPattern(code);
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
  // Detect common "float-away" pattern: mug_diameter/2 + something
  const floatAway = /translate\(\s*\[\s*mug_diameter\s*\/\s*2\s*\+\s*[\w\.]+\s*,/i.test(code);
  // Or explicit handle_offset param used to push outward
  const usesHandleOffset = /\bhandle_offset\b/i.test(code) && /mug_diameter\s*\/\s*2\s*\+\s*handle_offset/i.test(code);
  return floatAway || usesHandleOffset ? 'float_attach' : null;
}

const attachIssue = violatesAttachPolicy(code);
if (attachIssue) {
  return NextResponse.json({
    type: 'questions',
    assistant_text: 'The attachment was placed away from the body. Please confirm an attach overlap (e.g., 0.5 mm), or say "use default overlap". I will regenerate with a fused attachment.',
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
      actions: ['merged_spec', assumptions.length ? 'applied_defaults' : 'no_defaults', 'generated_code'],
    } satisfies ApiResp)
  } catch (err: any) {
    console.error('🛑 /api/generate fatal error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

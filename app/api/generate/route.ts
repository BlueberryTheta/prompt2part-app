// app/api/generate/route.ts
import { NextRequest, NextResponse } from 'next/server'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o' // or gpt-4o-mini

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

// ---------- SPEC TYPES (expanded to fit logs you shared) ----------
export type Spec = {
  units?: 'mm' | 'inch'
  part_type?: string
  overall?: { x?: number; y?: number; z?: number } // mm
  features?: Array<
    | {
        type: 'hole'
        diameter?: number
        position?: { x: number; y: number }
        count?: number
        through?: boolean
        countersink?: boolean
        base_face?: string
        face?: string
      }
    | {
        type: 'slot'
        width?: number
        length?: number
        center?: { x: number; y: number }
        angle?: number
        base_face?: string
        face?: string
      }
    | {
        type: 'fillet'
        radius?: number
        edges?: 'all' | 'none' | 'some'
      }
    | {
        type: 'chamfer'
        size?: number
        edges?: 'all' | 'none' | 'some'
      }
    | {
        type: 'cylinder'
        diameter?: number
        radius?: number
        height?: number
        position?: {
          reference_face?: string // e.g. "G0"
          face?: string
          alignment?: 'center' | 'adjacent' | string
          orientation?: 'normal' | 'tangent' | string
        }
        base_face?: string
        face?: string
        operation?: 'boss' | 'cut'
        dimensions?: { diameter?: number; radius?: number; height?: number }
      }
    | {
        type: 'cube'
        side_length?: number
        dimensions?: { side_length?: number; width?: number; height?: number; depth?: number }
        position?: {
          reference_face?: string
          face?: string
          alignment?: 'center' | 'adjacent' | string
        }
      }
  >
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

// ---------- SYSTEM PROMPTS ----------
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
- IMPORTANT DEFAULT: if a +cylinder+ references a face (base_face/face/position.reference_face present) and has no "operation", set "operation":"boss".
  - "boss" means a protrusion (added with union()) that sticks OUT of the face by "height" (with a small overlap into the host to fuse).
  - "cut" means a hole (subtract with difference()) that goes INTO the body.

- If required info is missing for code, add explicit items to "missing" and ask pointed "questions". Keep questions minimal.
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
- Units: millimeters if units == "mm".
- Start with named parameters (e.g., side_length, cylinder_diameter, cylinder_height, attach_overlap).
- Result must be a SINGLE, closed, 3D manifold suitable for FDM printing.
- New features must be Boolean-combined with the main body in ONE top-level CSG (union()/difference()).
- When attaching features (e.g., bosses), push them into the host by >= 0.3 mm (attach_overlap) and union() so they fuse; never leave coincident surfaces.
- If a feature references a face center, place it at that face's centroid.
- For holes/slots ("cut" operation), subtract with difference() and ensure through-cuts where requested.
- Preserve existing spec values; do not change dimensions unless explicitly requested.
- Do NOT include Markdown or triple backticks. Return raw OpenSCAD only.
- Do NOT set $fn; the caller controls tessellation.
- No prose. RETURN ONLY CODE.

- BOSS on a face: the feature must PROTRUDE OUTWARD from that face by "height". Use center=false and position the base of the boss ON the face plane, then extend outward (plus small attach_overlap into host to fuse).
- CUT on a face: subtract a cylinder starting ON the face plane and going INTO the body by "height" (or through).
- If SELECTION is provided, use it to place geometry on the specified face/region; do not ignore it.`.trim()
}

// ---------- OPENAI CALL ----------
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

// ---------- UTILS ----------
function safeParseJson(jsonish: string) {
  const match = jsonish.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON block found')
  return JSON.parse(match[0])
}

function looksLikeSCAD(code: string) {
  return /cube|cylinder|translate|difference|union|rotate|linear_extrude|sphere|polyhedron|intersection|hull|minkowski/i.test(
    code
  )
}

// Convert bad "geometry assignment" like: foo = cube(...);  into:
// module foo(){ cube(...); } foo();
function fixGeometryAssignments(scad: string) {
  const geomHeads =
    '(?:translate|rotate|scale|mirror|union|difference|intersection|hull|minkowski|cube|sphere|cylinder|polyhedron|linear_extrude|rotate_extrude)'

  // 1) Turn assignments into modules
  //    Rough regex: start-of-line <name> = <geomHead>(...);
  const assignRe = new RegExp(
    String.raw`^(\s*)([A-Za-z_]\w*)\s*=\s*(${geomHeads})\s*\(`,
    'mig'
  )

  // We'll collect names we convert, then post-replace bare "name;" with "name();"
  const converted = new Set<string>()
  let out = scad
  out = out.replace(assignRe, (_m, indent: string, name: string, head: string) => {
    converted.add(name)
    return `${indent}module ${name}() { ${head}(` // we keep the rest of the line intact
  })
  // Close braces where those module bodies end at the first semicolon after the geom.
  // Add a } before the semicolon we find that ends the statement.
  // Heuristic: find lines ending with `);` that are part of our module injection and add `} ` before `;`
  out = out.replace(/(\)\s*;)/g, '} $1')

  // 2) Replace bare calls `name;` with `name();` for converted names
  if (converted.size > 0) {
    const namesAlt = Array.from(converted).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const bareUseRe = new RegExp(String.raw`(^|\W)(${namesAlt})\s*;`, 'g')
    out = out.replace(bareUseRe, (_m, pre: string, nm: string) => `${pre}${nm}();`)
  }

  return out
}

// Remove BOM/normalize LF/strip $fn/extract fenced blocks
function sanitizeOpenSCAD(rawish: string) {
  let raw = (rawish || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim()

  // Prefer fenced content if present
  const m = raw.match(/```(?:openscad|scad)?\s*([\s\S]*?)```/i)
  if (m) raw = m[1].trim()

  // Strip any leading $fn
  raw = raw.replace(/^\s*\$fn\s*=\s*[^;]+;\s*/gmi, '')

  // Fix "foo = cube(...);" geometry assignments into modules + calls
  raw = fixGeometryAssignments(raw)

  return raw
}

// If a cylinder boss is clearly coded as centered with center=true only (internal), ask to clarify
function obviouslyInternalBoss(code: string) {
  const hasUnion = /\bunion\s*\(/i.test(code)
  const centeredCyl = /\bcylinder\s*\([^)]*center\s*=\s*true/i.test(code)
  const noCenterFalse = !/\bcylinder\s*\([^)]*center\s*=\s*false/i.test(code)
  return hasUnion && centeredCyl && noCenterFalse
}

// Default cylinder with a face reference to 'boss' if missing
function ensureCylinderBossDefault(spec: Spec): Spec {
  const out: Spec = JSON.parse(JSON.stringify(spec || {}))
  const feats = Array.isArray(out.features) ? out.features : []
  for (const f of feats as any[]) {
    if ((f?.type || '').toLowerCase() === 'cylinder') {
      const hasFace =
        !!f?.base_face || !!f?.face || !!f?.position?.reference_face || !!f?.position?.face
      if (hasFace && !f?.operation) f.operation = 'boss'
    }
  }
  out.features = feats
  return out
}

// Collapse duplicate cylinders on the same face; prefer the last "specific" one
function canonicalizeSpec(spec: Spec): Spec {
  if (!spec?.features || !Array.isArray(spec.features)) return spec

  type Key = string
  const toKey = (f: any): Key => {
    const t = (f?.type || '').toString().toLowerCase()
    const face =
      (f?.base_face ??
        f?.face ??
        f?.position?.reference_face ??
        f?.position?.face) ?? 'none'
    return `${t}|${face}`
  }

  const isSpecificCylinder = (f: any) => {
    if ((f?.type || '').toString().toLowerCase() !== 'cylinder') return false
    // Look across both shapes used in your logs
    const r = f?.dimensions?.radius ?? f?.radius
    const d = f?.dimensions?.diameter ?? f?.diameter
    const h = f?.dimensions?.height ?? f?.height
    return (r != null || d != null) && h != null
  }

  const groups = new Map<Key, any[]>()
  for (const f of spec.features as any[]) {
    const k = toKey(f)
    const arr = groups.get(k) || []
    arr.push(f)
    groups.set(k, arr)
  }

  const result: any[] = []
  for (const [key, arr] of groups) {
    const [t] = key.split('|')
    if (t === 'cylinder') {
      const specifics = arr.filter(isSpecificCylinder)
      if (specifics.length > 0) {
        result.push(specifics[specifics.length - 1]) // keep last specific
      } else {
        result.push(arr[arr.length - 1]) // or last of the group
      }
    } else {
      for (const f of arr) result.push(f)
    }
  }

  return { ...spec, features: result }
}

// ---------- HANDLER ----------
export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: incomingSpec = {}, selection } =
      (await req.json()) as ApiReq

    // 1) classify
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

    // 2) pure question
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
    const lastAssistant =
      [...history].reverse().find(m => m.role === 'assistant')?.content || ''
    const uiFaceHint =
      selection?.faceIndex != null
        ? `UI_SELECTED_FACE: G${selection.faceIndex}${
            selection?.point ? ` @ ${JSON.stringify(selection.point)}` : ''
          }`
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

    // Defaults / canonicalization
    mergedSpec = ensureCylinderBossDefault(mergedSpec)
    mergedSpec = canonicalizeSpec(mergedSpec)

    if (questions.length > 2) questions = questions.slice(0, 2)

    // Ask if ambiguous
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

    // 4) codegen
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

    // Sanitize code
    let code = sanitizeOpenSCAD(codeRaw)

    if (!looksLikeSCAD(code)) {
      return NextResponse.json({
        type: 'questions',
        assistant_text: 'I still need a bit more info before I can safely generate code.',
        spec: mergedSpec,
        questions: ['Please clarify missing geometry details.'],
        actions: ['merged_spec', 'code_check_failed'],
      } satisfies ApiResp)
    }

    if (obviouslyInternalBoss(code)) {
      return NextResponse.json({
        type: 'questions',
        assistant_text:
          'The cylinder appears to be centered inside the cube (it won’t change the outer shape). Should it be a **boss** that sticks **out of the referenced face**, or a **hole** cut into the body?',
        spec: mergedSpec,
        questions: ['Boss or hole for this cylinder on the face? (default: boss)'],
        actions: ['merged_spec', 'guard_internal_boss'],
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

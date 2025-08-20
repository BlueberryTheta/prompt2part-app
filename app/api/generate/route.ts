// app/api/generate/route.ts
import { NextRequest, NextResponse } from 'next/server'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

export type Spec = {
  units?: 'mm' | 'inch'
  part_type?: string
  overall?: { x?: number; y?: number; z?: number }
  // Primary field the client expects:
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
    | { type: 'fillet'; radius?: number; edges?: 'all' | 'none' | 'some' }
    | { type: 'chamfer'; size?: number; edges?: 'all' | 'none' | 'some' }
    | {
        type: 'cylinder'
        diameter?: number
        radius?: number
        height?: number
        position?: {
          reference_face?: string
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
          offset?: number
        }
      }
  >
  // Some models may return this legacy/alternative key; we normalize it.
  // @ts-ignore
  geometry?: Array<{ type: string; [k: string]: any }>
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

// ---------- prompts ----------
function sysPromptClassifier() {
  return `
You are an intent classifier for a CAD assistant.
Decide if the user's message is:
- "question"
- "change"
- "ambiguous"
Return STRICT JSON: {"intent":"question"|"change"|"ambiguous","reason":"<short>"}`.trim()
}

function sysPromptSpecMerge() {
  return `
You are a CAD spec editor. Merge the new user request into the existing SPEC.

Rules:
- Keep units consistent. Default "mm".
- Do not change existing geometry unless explicitly requested.
- Resolve ellipsis/pronouns using LAST_ASSISTANT_TEXT and UI_SELECTED_FACE (e.g. "center" applies to that face).
- IMPORTANT DEFAULT: if a cylinder references a face (base_face/face/position.reference_face) and has no "operation", set "operation":"boss".
- If required info is missing, add "missing" and ask short, pointed "questions".
- NEVER output code here.

Output STRICT JSON:
{"spec": <merged spec>, "assumptions": string[], "questions": string[]}`.trim()
}

function sysPromptCode() {
  return `
You are an OpenSCAD generator. Produce only valid OpenSCAD (no markdown).

Rules:
- Units: mm if units == "mm".
- Start with named parameters.
- Single closed manifold.
- Combine all features in ONE top-level union()/difference().
- Boss on a face: cylinder base ON the face (center=false), protrude OUTWARD by height, include small attach_overlap into host.
- Cut on a face: subtract cylinder starting at face going INTO body by height/through.
- If a face center is referenced, use the face centroid.
- Do not include $fn (caller sets tessellation).
- RETURN ONLY CODE.`.trim()
}

// ---------- openai ----------
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

// ---------- utils ----------
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

// Convert "name = cube(...);" into "module name(){ cube(...); } name();"
function fixGeometryAssignments(scad: string) {
  const geomHeads =
    '(?:translate|rotate|scale|mirror|union|difference|intersection|hull|minkowski|cube|sphere|cylinder|polyhedron|linear_extrude|rotate_extrude)'
  const assignRe = new RegExp(String.raw`^(\s*)([A-Za-z_]\w*)\s*=\s*(${geomHeads})\s*\(`, 'mig')
  const converted = new Set<string>()
  let out = scad
  out = out.replace(assignRe, (_m, indent: string, name: string, head: string) => {
    converted.add(name)
    return `${indent}module ${name}() { ${head}(`
  })
  out = out.replace(/(\)\s*;)/g, '} $1')
  if (converted.size > 0) {
    const namesAlt = Array.from(converted).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const bareUseRe = new RegExp(String.raw`(^|\W)(${namesAlt})\s*;`, 'g')
    out = out.replace(bareUseRe, (_m, pre: string, nm: string) => `${pre}${nm}();`)
  }
  return out
}

function toGFace(s?: string) {
  if (!s || typeof s !== 'string') return s
  const m = s.match(/^[gG](\d+)$/)
  return m ? `G${m[1]}` : s
}

function normalizeFacesInSpec(spec: Spec): Spec {
  const out: Spec = JSON.parse(JSON.stringify(spec || {}))
  if (!Array.isArray(out.features)) return out
  for (const f of out.features as any[]) {
    if (f.base_face) f.base_face = toGFace(f.base_face)
    if (f.face) f.face = toGFace(f.face)
    if (f.position?.reference_face) f.position.reference_face = toGFace(f.position.reference_face)
    if (f.position?.face) f.position.face = toGFace(f.position.face)
  }
  return out
}

// Default cylinder-on-face -> boss
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

// If model used `spec.geometry` instead of `spec.features`, fold it into features for the client.
function normalizeGeometryToFeatures(spec: Spec): Spec {
  if (!spec || !Array.isArray((spec as any).geometry) || ((spec as any).geometry as any[]).length === 0) {
    return spec
  }
  const out: Spec = JSON.parse(JSON.stringify(spec))
  const geom: any[] = (out as any).geometry || []
  delete (out as any).geometry
  out.features = [...(out.features || [])]

  for (const g of geom) {
    const t = String(g?.type || '').toLowerCase()
    if (t === 'cube') {
      out.features.push({
        type: 'cube',
        side_length: g?.side_length ?? g?.dimensions?.side_length ?? g?.width ?? g?.height ?? g?.depth,
        dimensions: g?.dimensions,
        position: g?.position,
      } as any)
    } else if (t === 'cylinder') {
      out.features.push({
        type: 'cylinder',
        diameter: g?.diameter ?? g?.dimensions?.diameter ?? (g?.radius ? g.radius * 2 : undefined),
        radius: g?.radius ?? g?.dimensions?.radius,
        height: g?.height ?? g?.dimensions?.height,
        position: g?.position,
        base_face: g?.base_face ?? g?.face,
        operation: g?.operation,
      } as any)
    } else {
      // pass-through for other types
      out.features.push(g)
    }
  }
  return out
}

// Do we have any subtractive features in the spec?
function hasCutFeatures(spec: Spec): boolean {
  const feats = spec.features || []
  return feats.some((f: any) => {
    const t = String(f?.type || '').toLowerCase()
    if (t === 'hole' || t === 'slot') return true
    if (t === 'cylinder' && String(f?.operation || '').toLowerCase() === 'cut') return true
    return false
  })
}

// If the model emitted `difference(){ union(){...} SUBTRACT; }` but spec has no cuts,
// rewrite to `union(){ ... ; SUBTRACT; }` so additive-only edits still render.
function rewriteDifferenceIfNoCuts(code: string, spec: Spec): string {
  if (hasCutFeatures(spec)) return code
  const outerDiff = code.match(/^\s*difference\s*\{\s*([\s\S]+)\s*\}\s*;?\s*$/i)
  if (!outerDiff) return code
  const inner = outerDiff[1]
  const unionMatch = inner.match(/\bunion\s*\{\s*([\s\S]*?)\s*\}/i)
  if (!unionMatch) return code
  const unionBody = unionMatch[1].trim()
  const afterUnion = inner.slice(inner.indexOf(unionMatch[0]) + unionMatch[0].length).trim()
  const extras = afterUnion.replace(/^\s*;?/, '').replace(/\s*;?\s*$/, '')
  const rebuilt = `union(){\n${unionBody}\n${extras ? '\n' + extras + '\n' : ''}}`
  return rebuilt
}

// Detect internal-only boss pattern
function obviouslyInternalBoss(code: string) {
  const hasUnion = /\bunion\s*\(/i.test(code)
  const centeredCyl = /\bcylinder\s*\([^)]*center\s*=\s*true/i.test(code)
  const noCenterFalse = !/\bcylinder\s*\([^)]*center\s*=\s*false/i.test(code)
  return hasUnion && centeredCyl && noCenterFalse
}

// -------- NEW: fix common OpenSCAD syntax glitches from the model ----------
function fixCommonSyntaxScad(code: string) {
  let out = code

  // 1) Stray '}' before ')' like: center = true} );
  out = out.replace(/(center\s*=\s*(?:true|false))\s*}\s*\)/gi, '$1)')

  // 2) Trailing comma before ')' e.g., cube([..,], center=true, )
  out = out.replace(/,\s*\)/g, ')')

  // 3) Extra semicolons before '}' e.g., "foo(); }"
  out = out.replace(/;\s*}/g, '}')

  // 4) Balance parentheses and braces (best-effort)
  const balance = (text: string, openChar: string, closeChar: string) => {
    let count = 0
    for (const ch of text) {
      if (ch === openChar) count++
      else if (ch === closeChar) count = Math.max(0, count - 1)
    }
    return count
  }
  const needParen = balance(out, '(', ')')
  if (needParen > 0) out = out + ')'.repeat(needParen)
  const needBrace = balance(out, '{', '}')
  if (needBrace > 0) out = out + '}'.repeat(needBrace)

  return out
}

function sanitizeOpenSCAD(rawish: string) {
  let raw = (rawish || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim()
  const m = raw.match(/```(?:openscad|scad)?\s*([\s\S]*?)```/i)
  if (m) raw = m[1].trim()
  raw = raw.replace(/^\s*\$fn\s*=\s*[^;]+;\s*/gmi, '')

  // Convert "name = cube(...);" patterns into modules safely
  raw = fixGeometryAssignments(raw)

  // Heal common syntax glitches from the model
  raw = fixCommonSyntaxScad(raw)

  return raw
}

// ---------- handler ----------
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

    // 2) Q/A early
    if (intent === 'question') {
      const qaMsg: Msg[] = [
        {
          role: 'system',
          content:
            'You are a helpful CAD assistant. Answer briefly and concretely for 3D printable parts. No code, no JSON.',
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

    // 3) merge spec
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || ''
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
      return NextResponse.json({ error: 'Spec merge failed: invalid JSON' } as ApiResp, { status: 500 })
    }

    // Normalize face casing & geometry->features; enforce cylinder boss default
    mergedSpec = normalizeGeometryToFeatures(mergedSpec)
    mergedSpec = normalizeFacesInSpec(mergedSpec)
    mergedSpec = ensureCylinderBossDefault(mergedSpec)

    // Ask if still unclear
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

    // Sanitize & heal code
    let code = sanitizeOpenSCAD(codeRaw)
    // If no cuts requested but model used difference(), turn into union()
    code = rewriteDifferenceIfNoCuts(code, mergedSpec)

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
          'The cylinder appears to be centered inside the cube (no outward boss). Should it be a **boss** that sticks **out of the referenced face**, or a **hole** cut into the body?',
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

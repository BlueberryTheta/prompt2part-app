// app/api/generate/route.ts
import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'edge'

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
        feature_id?: string
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
        feature_id?: string
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
        feature_id?: string
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
        feature_id?: string
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
  selection?: { faceIndex?: number; point?: [number, number, number]; featureId?: string }
  acceptDefaults?: boolean
}

export type Adjustable = {
  key: string
  type: 'number' | 'enum' | 'boolean' | 'text' | 'vector3'
  label?: string
  unit?: 'mm' | 'inch'
  min?: number
  max?: number
  step?: number
  options?: string[]
  required?: boolean
  hint?: string
  group?: string
  order?: number
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
      // AI-driven Quick Setup (optional)
      objectType?: string
      adjustables?: Adjustable[]
      adjust_params?: Record<string, any>
      options?: Record<string, string[]>
      ask?: string[]
    }
  | { error: string }

// ---------- prompts ----------
function sysPromptSpecMerge() {
  return `
You are a CAD spec editor. Merge the new user request into the existing SPEC.

Goals:
- Infer intent and set spec.part_type when obvious (e.g., "cable holder", "phone stand", "L-bracket").
- Gather only the minimum information to produce a reasonable first model.

Rules:
- Keep units consistent. Default "mm".
- Do not change existing geometry unless explicitly requested.
- Resolve ellipsis/pronouns using LAST_ASSISTANT_TEXT and UI_SELECTED_FACE (e.g. "center" applies to that face).
- Do not force additive vs subtractive operations; infer from the user's intent. If ambiguous and ACCEPT_DEFAULTS is false, ask briefly; if ACCEPT_DEFAULTS is true, choose reasonable defaults and proceed.
- If required info is missing, add "missing" and ask up to 3 short, pointed "questions" with sensible defaults in parentheses, UNLESS ACCEPT_DEFAULTS is true.
- Prefer concrete numbers. Suggest typical ranges where helpful.
- NEVER output code here.

If UI_SELECTED_FEATURE is present, apply the change to that feature.
For holders/brackets/clamps/enclosures/knobs/adapters, choose 2–3 key questions with defaults; otherwise proceed with reasonable assumptions.

Additionally, you MUST return an AI-driven Quick Setup schema with ONLY the parameters that matter now:
- objectType: normalized short type for the current object (e.g., "cube", "cylinder", "cable_holder").
- params: a flat map of current parameter values used by the geometry (numbers/strings/booleans or nested objects).
- adjustables: an array of fields the user may edit NOW, each with: { key, type, label?, unit?, min?, max?, step?, options? }.
  - key uses dot-paths for nested (e.g., "position.x").
  - Include ONLY fields the user should edit now; do NOT include irrelevant defaults.
- ask: optional short questions for ambiguous/missing values, <= 3.
- options: optional map of enumerated choices per key.

Output STRICT JSON:
{"spec": <merged spec>, "assumptions": string[], "questions": string[], "objectType": string, "params": object, "adjustables": Array, "ask": string[], "options": object}`.trim()
}

function sysPromptCode() {
  return `
You are an OpenSCAD generator. Produce only valid OpenSCAD (no markdown).

Rules:
- Units: mm if units == "mm".
- Start with a clear block of named parameters (simple numeric values) for key dimensions. Use snake_case names reflecting SPEC (e.g., cable_diameter, slot_count, body_width, mount_hole_diameter).
- Single closed manifold.
- Combine all features in ONE top-level union()/difference().
- Boss on a face: cylinder base ON the face (center=false), protrude OUTWARD by height, include small attach_overlap into host.
- Cut on a face: subtract cylinder starting at face going INTO body by height/through.
- If a face center is referenced, use the face centroid.
- Do not include $fn (caller sets tessellation).
- If there is exactly one top-level module defined, ensure it is called at the end.
- RETURN ONLY CODE.`.trim()
}

// ---------- openai (with timeout) ----------
async function openai(
  messages: Msg[],
  max_tokens = 1200,
  temperature = 0.2,
  timeoutMs = 20000
) {
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: OPENAI_MODEL, messages, max_tokens, temperature }),
      signal: ac.signal,
    })
    const json = await res.json()
    return json?.choices?.[0]?.message?.content ?? ''
  } finally {
    clearTimeout(to)
  }
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
    if (!f.feature_id && f.id) f.feature_id = f.id
    if (f.base_face) f.base_face = toGFace(f.base_face)
    if (f.face) f.face = toGFace(f.face)
    if (f.position?.reference_face) f.position.reference_face = toGFace(f.position.reference_face)
    if (f.position?.face) f.position.face = toGFace(f.position.face)
  }
  return out
}

function ensureFeatureIds(spec: Spec): Spec {
  const out: Spec = JSON.parse(JSON.stringify(spec || {}))
  const feats: any[] = Array.isArray(out.features) ? out.features : []
  let seq = 1
  for (const f of feats) {
    if (!f.feature_id) {
      const t = String(f?.type || 'feature').toLowerCase()
      f.feature_id = `${t}-${seq++}-${Math.random().toString(36).slice(2, 6)}`
    }
  }
  out.features = feats
  return out
}

// Default cylinder-on-face -> boss
// Note: previously we defaulted cylinders-on-face to 'boss'.
// This was removed to let the model infer user intent (boss vs cut).

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

// Insert semicolons when a function/primitive call is immediately followed by a closing brace,
// e.g. "cube(...)}" -> "cube(...);}"
function fixMissingSemicolonsNearBraces(code: string) {
  let out = code;

  // If a call ends with ')' and is directly followed by '}', insert ';' before '}'
  out = out.replace(/(\))\s*}/g, '$1;}');

  // If file ends right after a ')', add a semicolon at EOF
  out = out.replace(/(\))\s*$/g, '$1;');

  return out;
}

// Build a minimal, data-driven adjustable set from the current spec (no registry, no defaults)
function buildAdjustablesFromSpec(spec: Spec, featureId?: string): {
  objectType?: string
  adjustables: Adjustable[]
  params: Record<string, any>
} {
  const outParams: Record<string, any> = {}
  const adjustables: Adjustable[] = []
  if (!spec) return { objectType: undefined, adjustables, params: outParams }

  // Helper to flatten numeric fields into dot-keys
  const flattenNumeric = (obj: any, base = '') => {
    if (!obj || typeof obj !== 'object') return
    for (const k of Object.keys(obj)) {
      const v = (obj as any)[k]
      const path = base ? `${base}.${k}` : k
      if (typeof v === 'number' && Number.isFinite(v)) {
        outParams[path] = v
      } else if (v && typeof v === 'object') {
        flattenNumeric(v, path)
      }
    }
  }

  // Prefer the most recently added feature (last), else first
  const feats = Array.isArray(spec.features) ? spec.features : []
  let feature: any = null
  if (featureId) {
    feature = feats.find((f: any) => (f?.feature_id || f?.id) === featureId) || null
  }
  if (!feature) {
    feature = feats.length > 0 ? feats[feats.length - 1] : null
  }
  if (feature) flattenNumeric(feature)
  // Also include overall dimensions if present
  if (spec.overall) flattenNumeric(spec.overall, 'overall')

  for (const key of Object.keys(outParams)) {
    adjustables.push({ key, type: 'number', label: key })
  }

  const objectType = (feature?.type as string) || spec.part_type
  return { objectType, adjustables, params: outParams }
}

// Heal broken empty/stray call endings like: name(} ); or name()}
function fixBrokenEmptyCalls(code: string) {
  let out = code
  // Replace identifier( } ) -> identifier()
  out = out.replace(/\b([A-Za-z_]\w*)\s*\(\s*\}\s*\)\s*;?/g, '$1();')
  // Replace identifier() } -> identifier();
  out = out.replace(/\b([A-Za-z_]\w*)\s*\(\s*\)\s*\}\s*;?/g, '$1();')
  return out
}

function sanitizeOpenSCAD(rawish: string) {
  let raw = (rawish || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim();

  // Strip fences if present
  const m = raw.match(/```(?:openscad|scad)?\s*([\s\S]*?)```/i);
  if (m) raw = m[1].trim();

  // Remove any $fn the model set; client controls tessellation
  raw = raw.replace(/^\s*\$fn\s*=\s*[^;]+;\s*/gmi, '');

  // Convert "name = cube(...);" into a safe module call
  raw = fixGeometryAssignments(raw);

  // Heal common syntax glitches (e.g. "center=true} )")
  raw = fixCommonSyntaxScad(raw);

  // 🔧 NEW: heal missing semicolons before '}' and at EOF
  raw = fixMissingSemicolonsNearBraces(raw);

  // Fix broken or empty call endings
  raw = fixBrokenEmptyCalls(raw);

  // Ensure 2D primitives are extruded into 3D when used in 3D CSG
  raw = ensure2DExtruded(raw);

  // Ensure a top-level call if exactly one module is declared
  try {
    const modRe = /^\s*module\s+([A-Za-z_]\w*)\s*\(/gim
    const mods = Array.from(raw.matchAll(modRe)).map(m => m[1])
    if (mods.length === 1) {
      const name = mods[0]
      const hasCall = new RegExp(String.raw`(^|\W)${name}\s*\(`).test(raw.replace(modRe, ''))
      if (!hasCall) raw = raw + `\n${name}();\n`
    }
  } catch {}

  return raw;
}

// Try to extract a numeric variable from code (simple assignments at top)
function findNumericVar(code: string, names: string[]): number | null {
  const head = code.replace(/\r\n/g, '\n').split('\n').slice(0, 200).join('\n');
  for (const name of names) {
    const re = new RegExp(String.raw`^\s*${name}\s*=\s*([-+]?\d*\.?\d+)\s*;`, 'mi');
    const m = head.match(re);
    if (m) {
      const val = Number(m[1]);
      if (Number.isFinite(val)) return val;
    }
  }
  return null;
}

// Best-effort: if 2D primitives (square/circle/polygon with optional offset) are used directly,
// wrap them in a small linear_extrude so they contribute to 3D CSG operations.
function ensure2DExtruded(code: string): string {
  // Choose an extrusion height from common thickness params, else default to 3
  const candidate = findNumericVar(code, [
    'handle_thickness',
    'wall_thickness',
    'thickness',
  ]);
  const height = (candidate && candidate > 0) ? candidate : 3;

  // Skip lines already under linear_extrude or rotate_extrude
  // Wrap patterns like: [transforms] [offset?] (square|circle|polygon)(...);
  const re = new RegExp(
    String.raw`(^|\n)([ \t]*(?:translate\([^)]*\)\s*)?(?:rotate\([^)]*\)\s*)?(?:scale\([^)]*\)\s*)?)(?!linear_extrude|rotate_extrude)((?:offset\([^)]*\)\s*)?(?:square\([^)]*\)|circle\([^)]*\)|polygon\([^)]*\)))\s*;`,
    'gmi'
  );

  return code.replace(re, (_m, pre: string, xfms: string, shape: string) => {
    return `${pre}${xfms}linear_extrude(height=${height}) { ${shape}; }`;
  });
}


// ---------- handler ----------
export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: incomingSpec = {}, selection, acceptDefaults = false } =
      (await req.json()) as ApiReq

    // Keep history short to reduce latency and cost
    const shortHistory = history.slice(-8)

    // 1) merge spec
    const lastAssistant = [...shortHistory].reverse().find(m => m.role === 'assistant')?.content || ''
  const uiFaceHint =
      selection?.faceIndex != null
        ? `UI_SELECTED_FACE: G${selection.faceIndex}${
            selection?.point ? ` @ ${JSON.stringify(selection.point)}` : ''
          }`
        : 'UI_SELECTED_FACE: none'
    const uiFeatureHint = selection?.featureId ? `UI_SELECTED_FEATURE: ${selection.featureId}` : 'UI_SELECTED_FEATURE: none'

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
          `\n${uiFeatureHint}` +
          (selection ? `\n\nSELECTION:\n${JSON.stringify(selection, null, 2)}` : '') +
          `\n\nHISTORY_SNIPPET:\n` +
          JSON.stringify(shortHistory, null, 2) +
          `\n\nACCEPT_DEFAULTS: ${acceptDefaults ? 'true' : 'false'}` +
          `\n\nUSER_REQUEST:\n` +
          prompt,
      },
    ]
    const mergedRaw = await openai(mergeMsg, 900, 0.1)

    let mergedSpec: Spec = incomingSpec
    let assumptions: string[] = []
    let missing: string[] = []
    let questions: string[] = []
    let objectType: string | undefined
    let adjustables: any[] | undefined
    let adjustParams: Record<string, any> | undefined
    let adjustAsk: string[] | undefined
    let adjustOptions: Record<string, string[]> | undefined
    try {
      const parsed = safeParseJson(mergedRaw)
      mergedSpec = parsed.spec || incomingSpec
      assumptions = parsed.assumptions || []
      missing = parsed.missing || []
      questions = parsed.questions || []
      objectType = parsed.objectType || parsed.part_type || undefined
      adjustables = Array.isArray(parsed.adjustables) ? parsed.adjustables : undefined
      adjustParams = parsed.params || undefined
      adjustAsk = Array.isArray(parsed.ask) ? parsed.ask : undefined
      adjustOptions = parsed.options || undefined
    } catch (e: any) {
      console.error('Spec merge parse error:', e?.message, mergedRaw)
      return NextResponse.json({ error: 'Spec merge failed: invalid JSON' } as ApiResp, { status: 500 })
    }

    // Normalize face casing & geometry->features and assign feature ids
    mergedSpec = normalizeGeometryToFeatures(mergedSpec)
    mergedSpec = normalizeFacesInSpec(mergedSpec)
    mergedSpec = ensureFeatureIds(mergedSpec)

    // If the model did not provide adjustables, ask it for a minimal adaptive schema now (AI-only, no defaults)
    if (!adjustables || adjustables.length === 0) {
      try {
        const schemaMsg: Msg[] = [
          { role: 'system', content: `You are a UI schema generator. Return STRICT JSON with keys: { "objectType": string, "params": object, "adjustables": Array, "ask": string[], "options": object }. Include ONLY the parameters the user should edit now for the current object. Use dot-paths for nested keys (e.g., position.x). Do not invent irrelevant defaults. Keep adjustables concise and relevant.` },
          { role: 'user', content: `SPEC:\n${JSON.stringify(mergedSpec, null, 2)}\n\nIf applicable, base the objectType on the main feature or part_type.` },
        ]
        const schemaRaw = await openai(schemaMsg, 700, 0.2)
        const schema = safeParseJson(schemaRaw)
        objectType = schema.objectType || objectType
        adjustables = Array.isArray(schema.adjustables) ? schema.adjustables : adjustables
        adjustParams = schema.params || adjustParams
        adjustAsk = Array.isArray(schema.ask) ? schema.ask : adjustAsk
        adjustOptions = schema.options || adjustOptions
      } catch {}
    }

    // Final safety: if still no adjustables, derive directly from the current spec (no registry, purely data-driven)
    if (!adjustables || adjustables.length === 0) {
      const derived = buildAdjustablesFromSpec(mergedSpec, selection?.featureId)
      objectType = objectType || derived.objectType
      adjustables = derived.adjustables
      adjustParams = derived.params
    }

    // Ask if still unclear
    if (missing.length > 0 || questions.length > 0) {
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
        objectType,
        adjustables,
        adjust_params: adjustParams,
        options: adjustOptions,
        ask: adjustAsk,
        actions: ['merged_spec', assumptions.length ? 'applied_defaults' : 'no_defaults'],
      } satisfies ApiResp)
    }

    // 2) codegen
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
      objectType,
      adjustables,
      adjust_params: adjustParams,
      options: adjustOptions,
      ask: adjustAsk,
      actions: ['merged_spec', assumptions.length ? 'applied_defaults' : 'no_defaults', 'generated_code'],
    } satisfies ApiResp)
  } catch (err: any) {
    console.error('🛑 /api/generate fatal error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}

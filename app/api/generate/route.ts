// app/api/generate/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { ChatMessage, getOpenAIText } from '@/lib/openai'
import { sanitizeOpenSCAD as baseSanitizeOpenSCAD } from '@/lib/scad'
export const runtime = 'nodejs'
export const maxDuration = 60

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5'

// Soft character budgets to keep inputs within model context limits.
// These are conservative approximations (tokens ~ chars/4 for English; code varies).
// You can tune via env if needed.
// Aggressive default budgets; can be tuned via env
const SPEC_CHAR_BUDGET = Number(process.env.SPEC_CHAR_BUDGET || '') || 20000
const CODE_CHAR_BUDGET = Number(process.env.CODE_CHAR_BUDGET || '') || 30000

// Feature flag: disable legacy multi-phase flow (merge/schema/codegen)
const DISABLE_LEGACY_FLOW = (process.env.DISABLE_LEGACY_FLOW ?? '1') === '1'

type Msg = ChatMessage

const SPEC_DEBUG_PREFIX = '[SpecDebug]'

function previewText(text: unknown, max = 400) {
  if (typeof text !== 'string') return ''
  return text.length > max ? text.slice(0, max) + '...' : text
}

function logSpecDebug(label: string, content: string) {
  console.debug(SPEC_DEBUG_PREFIX, label, { length: content?.length, preview: previewText(content) })
}

function isLikelyJson(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return false
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function isLikelyCode(text: string) {
  const t = (text || '').trim()
  if (!t) return false
  // Quick signals of OpenSCAD-like code
  if (/\b(module|union|difference|intersection|cube\s*\(|cylinder\s*\(|polyhedron\s*\()/.test(t)) return true
  if (/;\s*$/.test(t)) return true
  if (/^\s*\$fn\s*=/.test(t)) return true
  return false
}

// Extremely small local fallback code generator for common requests
function quickFallbackCode(prompt: string, history: Msg[]): { code: string; note: string } | null {
  const text = [String(prompt || ''), ...history.map(h => String(h?.content || ''))].join(' ').toLowerCase()
  const has = (k: string) => text.includes(k)

  // Coffee mug: simple hollow cylinder with a handle
  if (has('mug') || has('coffee mug') || has('cup')) {
    const code = `// Parameters (mm)
mug_outer_d = 80;
mug_inner_d = 74;
mug_height  = 100;
handle_radius = 35;
handle_thick  = 8;
attach_overlap = 2;

module mug_body() {
  difference() {
    cylinder(d = mug_outer_d, h = mug_height, center = false);
    translate([0,0,2]) cylinder(d = mug_inner_d, h = mug_height, center = false);
  }
}

module mug_handle() {
  // Torus-like handle: two cylinders and a connector
  translate([(mug_outer_d/2) - handle_thick, 0, mug_height/2])
    rotate([0,90,0])
      union() {
        cylinder(d = handle_thick*2, h = handle_radius, center=false);
        translate([handle_radius-attach_overlap,0,0]) cylinder(d = handle_thick*2, h = handle_radius, center=false);
        // Connector
        translate([0,-handle_thick,0]) cube([handle_radius, handle_thick*2, handle_thick*2], center=false);
      }
}

union() {
  mug_body();
  mug_handle();
}
`
    return { code, note: 'Generated a default coffee mug with handle.' }
  }

  // Cube
  if (has('cube') || has('box')) {
    const code = `// Parameters (mm)
size_x = 40; size_y = 40; size_z = 40;
translate([0,0,0]) cube([size_x, size_y, size_z], center=false);
`
    return { code, note: 'Generated a default cube (40mm).' }
  }

  // Cylinder
  if (has('cylinder')) {
    const code = `// Parameters (mm)
diameter = 40; height = 50;
cylinder(d = diameter, h = height, center=false);
`
    return { code, note: 'Generated a default cylinder.' }
  }

  return null
}

// --------- simplified single-call path (fast path) ---------
function sysPromptSimple() {
  return `
You are an OpenSCAD assistant.

Task:
 - If the user provided enough info (dimensions, counts, positions) to build a reasonable first model, return ONLY OpenSCAD code (no markdown/fences, no '$fn').
 - If not, ask up to 3 short, specific questions to gather the missing dimensions, as STRICT JSON only:
   {"type":"questions","assistant_text": string, "questions": string[]}

Code requirements:
- Include a small parameter block at the top using snake_case variables.
- Ensure at least one solid primitive and a single top-level union()/difference().
- If CURRENT_CODE is provided, modify it minimally and preserve positions/transforms.
`.trim()
}

// Even simpler: when defaults are accepted, produce code now without asking questions.
function sysPromptCodeOnly() {
  return `
You are an OpenSCAD assistant. Produce ONLY valid OpenSCAD code now.

Rules:
- No markdown/fences. Do not include $fn.
- If information is missing, choose reasonable defaults and proceed; do NOT ask questions.
- Start with a small parameter block (snake_case numbers) for key dimensions.
- Use millimeters when units are unspecified or set to mm.
- Ensure at least one solid primitive and a single top-level union() or difference().
- If CURRENT_CODE is provided, modify it minimally and preserve positions/transforms.
`.trim()
}

// Truncate long text by keeping head and tail with a marker, to preserve
// important headers and endings (useful for code and pretty-printed JSON).
function truncateMiddle(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text
  const keep = Math.max(0, maxChars - 80) // reserve room for marker
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  const omitted = text.length - (head + tail)
  return (
    text.slice(0, head) +
    `\n/* … [TRUNCATED ${omitted} chars for length] … */\n` +
    text.slice(text.length - tail)
  )
}


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
  currentCode?: string
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
// legacy sysPromptSpecMerge removed

// legacy sysPromptCode removed; using sysPromptCodeOnly

// ---------- openai (with timeout) ----------
async function openai(
  messages: Msg[],
  max_tokens = 1200,
  temperature = 0.2,
  timeoutMs = 45000,
  validate?: (text: string) => boolean,
  opts?: { json?: boolean }
) {
  const isGpt5 = OPENAI_MODEL.toLowerCase().startsWith('gpt-5')
  return getOpenAIText({
    messages,
    model: OPENAI_MODEL,
    maxOutputTokens: max_tokens,
    temperature: isGpt5 ? undefined : temperature,
    timeoutMs,
    validate,
    responseFormatJson: !!opts?.json,
  })
}

// ---------- utils ----------
function safeParseJson(jsonish: string) {
  if (typeof jsonish !== 'string') {
    console.error(SPEC_DEBUG_PREFIX, 'safeParseJson: non-string input', { preview: previewText(String(jsonish)) })
    throw new Error('Input must be string')
  }
  const match = jsonish.match(/\{[\s\S]*\}/)
  if (!match) {
    console.error(SPEC_DEBUG_PREFIX, 'safeParseJson: no JSON block found', { preview: previewText(jsonish) })
    throw new Error('No JSON block found')
  }
  try {
    return JSON.parse(match[0])
  } catch (err: any) {
    console.error(SPEC_DEBUG_PREFIX, 'safeParseJson: JSON.parse failed', { preview: previewText(match[0]), error: err?.message })
    throw err
  }
}


function toGFace(s?: string) {
  if (!s || typeof s !== 'string') return s
  const m = s.match(/^[gG](\d+)$/)
  return m ? `G${m[1]}` : s
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
  return baseSanitizeOpenSCAD(rawish)
}

// Remove sequences like "} } )" or "} )" that accidentally appear inside argument lists
function fixStrayBracesInCalls(code: string) {
  let out = code;
  const heads = '(?:translate|rotate|scale|mirror|union|difference|intersection|hull|minkowski|cube|sphere|cylinder|square|circle|polygon|polyhedron|linear_extrude|rotate_extrude)';
  // Double stray braces before )
  const re2 = new RegExp(String.raw`(\b${heads}\s*\([^)]*)\}\s*\}\s*\)`, 'g');
  out = out.replace(re2, '$1)');
  // Single stray brace before )
  const re1 = new RegExp(String.raw`(\b${heads}\s*\([^)]*)\}\s*\)`, 'g');
  out = out.replace(re1, '$1)');
  // Also handle cases with a trailing semicolon
  const re2s = new RegExp(String.raw`(\b${heads}\s*\([^)]*)\}\s*\}\s*\)\s*;`, 'g');
  out = out.replace(re2s, '$1);');
  const re1s = new RegExp(String.raw`(\b${heads}\s*\([^)]*)\}\s*\)\s*;`, 'g');
  out = out.replace(re1s, '$1);');
  return out;
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
  ])
  const height = (candidate && candidate > 0) ? candidate : 3

  const lines = code.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []

  const isModifierLine = (s: string) => /^(\s*)(translate|rotate|scale|mirror|offset)\([^)]*\)\s*$/.test(s)
  const isExtrudePresent = (s: string) => /\b(linear_extrude|rotate_extrude)\b/i.test(s)
  const primRe = /^\s*(square|circle|polygon)\([^;]*\)\s*;\s*$/i

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isExtrudePresent(line)) { out.push(line); continue }
    if (!primRe.test(line)) { out.push(line); continue }

    // Collect contiguous modifier lines above (no semicolons)
    let begin = i
    const chain: string[] = []
    for (let j = i - 1; j >= 0; j--) {
      const lj = lines[j]
      if (lj.trim() === '') { begin = j; continue }
      if (isModifierLine(lj)) { begin = j; chain.unshift(lj.trim()); continue }
      break
    }

    const primLine = line.trim().replace(/;\s*$/, '')
    // Split modifiers into non-offset transforms vs offset modifiers
    const nonOffset: string[] = []
    const offsets: string[] = []
    for (const m of chain) {
      if (/^offset\(/i.test(m.trim())) offsets.push(m.trim())
      else nonOffset.push(m.trim())
    }

    const indentMatch = (lines[begin] || '').match(/^(\s*)/)
    const indent = indentMatch ? indentMatch[1] : ''

    const prefix = (nonOffset.length > 0 ? nonOffset.join(' ') + ' ' : '')
    const mid = `linear_extrude(height=${height}) `
    const post = (offsets.length > 0 ? offsets.join(' ') + ' ' : '')
    const rebuilt = `${indent}${prefix}${mid}${post}${primLine};`

    // Replace lines [begin..i] with single rebuilt line
    out.length = Math.max(0, out.length - (i - begin))
    out.push(rebuilt)
  }

  return out.join('\n')
}


// ---------- handler ----------
export async function POST(req: NextRequest) {
  try {
    const { prompt, history = [], spec: incomingSpec = {}, selection, acceptDefaults = false, currentCode } =
      (await req.json()) as ApiReq

    // Keep history ultra-short to reduce latency and cost
    const shortHistory = history.slice(-2)

    // Attempt a simplified single-call path first for speed
    try {
      const lastAssistant = [...shortHistory].reverse().find(m => m.role === 'assistant')?.content || ''
      let safeCurrent = typeof currentCode === 'string' ? currentCode : ''
      if (safeCurrent && safeCurrent.length > CODE_CHAR_BUDGET) {
        safeCurrent = truncateMiddle(safeCurrent, CODE_CHAR_BUDGET)
      }

      const wantsDefaults = !!acceptDefaults || /default/i.test(String(prompt || ''))
      const simpleMsg: Msg[] = wantsDefaults
        ? [
            { role: 'system', content: sysPromptCodeOnly() },
            {
              role: 'user',
              content:
                (safeCurrent ? `CURRENT_CODE:\n${safeCurrent}\n\n` : '') +
                `UNITS: ${(incomingSpec?.units || 'mm').toString()}` +
                `\n\nUSER_REQUEST:\n${prompt}`,
            },
          ]
        : [
            { role: 'system', content: sysPromptSimple() },
            {
              role: 'user',
              content:
                (lastAssistant ? `LAST_ANSWER:\n${lastAssistant}\n\n` : '') +
                (safeCurrent ? `CURRENT_CODE:\n${safeCurrent}\n\n` : '') +
                `USER_REQUEST:\n${prompt}`,
            },
          ]

      // Basic input size logging for observability
      console.debug(
        SPEC_DEBUG_PREFIX,
        'simple_call_input_sizes',
        {
          promptLen: String(prompt ?? '').length,
          currentCodeLen: safeCurrent.length,
          wantsDefaults,
          maxTokens: wantsDefaults ? 1200 : 900,
          timeoutMs: wantsDefaults ? 28000 : 25000,
        }
      )

      const simpleRaw = wantsDefaults
        ? await openai(simpleMsg, 1200, 0.05, 28000, isLikelyJson, { json: true })
        : await openai(simpleMsg, 900, 0.1, 25000, isLikelyJson, { json: true })
      logSpecDebug('simpleRaw', simpleRaw)
      // Try structured path first
      try {
        const simple = safeParseJson(simpleRaw)
        // Defaults path: expect a minimal JSON with just { code } or { type, code/questions }
        if (simple && typeof simple === 'object') {
          if (typeof simple.code === 'string' && simple.code.trim().length > 0) {
            const code = sanitizeOpenSCAD(simple.code)
            return NextResponse.json({
              type: 'code',
              assistant_text: wantsDefaults ? 'Generated code using defaults.' : (typeof simple.assistant_text === 'string' ? simple.assistant_text : 'Generated code.'),
              spec: incomingSpec,
              code,
              actions: ['simple_code'],
            } satisfies ApiResp)
          }
          if (simple.type === 'questions') {
            return NextResponse.json({
              type: 'questions',
              assistant_text: typeof simple.assistant_text === 'string' ? simple.assistant_text : 'I need a bit more info.',
              spec: incomingSpec,
              questions: Array.isArray(simple.questions) ? simple.questions.slice(0, 3) : [],
              actions: ['simple_questions'],
            } satisfies ApiResp)
          }
        }
      } catch {}
      // If not JSON but looks like raw code, accept it directly
      if (isLikelyCode(simpleRaw)) {
        const code = sanitizeOpenSCAD(simpleRaw)
        return NextResponse.json({
          type: 'code',
          assistant_text: wantsDefaults ? 'Generated code using defaults.' : 'Generated code.',
          spec: incomingSpec,
          code,
          actions: ['simple_code_raw'],
        } satisfies ApiResp)
      }
      // Minimal mode: if we reach here, do not attempt complex merge/codegen.
      return NextResponse.json({ error: 'Could not interpret AI output' }, { status: 502 })
    } catch (e: any) {
      const msg = String(e?.message || '')
      console.warn(SPEC_DEBUG_PREFIX, 'simple path failed', { error: msg })
      if (msg.toLowerCase().includes('timed out')) {
        return NextResponse.json({ error: 'OpenAI request timed out' }, { status: 504 })
      }
      // else: do not fall back to legacy flow
      return NextResponse.json({ error: 'AI request failed' }, { status: 502 })
    }

    // Legacy flow is disabled by default to avoid timeouts
    if (DISABLE_LEGACY_FLOW) {
      return NextResponse.json({ error: 'Legacy flow disabled' }, { status: 501 })
    }
    // Stringify and cap the existing spec to avoid blowing past context limits
    let existingSpecJson = JSON.stringify(incomingSpec || {}, null, 2)
    if (existingSpecJson.length > SPEC_CHAR_BUDGET) {
      existingSpecJson = truncateMiddle(existingSpecJson, SPEC_CHAR_BUDGET)
    }

    } catch (err: any) {
    console.error('ðŸ›‘ /api/generate fatal error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}




// Shared OpenSCAD helpers used by API routes

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

// -------- fix common OpenSCAD syntax glitches ----------
function fixCommonSyntaxScad(code: string) {
  let out = code
  // 1) Stray '}' before ')' like: center = true} );
  out = out.replace(/(center\s*=\s*(?:true|false))\s*}\s*\)/gi, '$1)')
  // 2) Trailing comma before ')' e.g., cube([..,], center=true, )
  out = out.replace(/,\s*\)/g, ')')
  // 3) Extra semicolons before '}' e.g., "foo(); }"
  out = out.replace(/;\s*}/g, '}')
  // 4) Best-effort balance
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

// Insert semicolons when a call is immediately followed by a closing brace or EOF
function fixMissingSemicolonsNearBraces(code: string) {
  let out = code
  out = out.replace(/(\))\s*}/g, '$1;}')
  out = out.replace(/(\))\s*$/g, '$1;')
  return out
}

// Heal broken empty/stray call endings like: name(} ); or name()}
function fixBrokenEmptyCalls(code: string) {
  let out = code
  out = out.replace(/\b([A-Za-z_]\w*)\s*\(\s*\}\s*\)\s*;?/g, '$1();')
  out = out.replace(/\b([A-Za-z_]\w*)\s*\(\s*\)\s*\}\s*;?/g, '$1();')
  return out
}

// Remove sequences like "} } )" or "} )" that accidentally appear inside argument lists
function fixStrayBracesInCalls(code: string) {
  let out = code
  const heads = '(?:translate|rotate|scale|mirror|union|difference|intersection|hull|minkowski|cube|sphere|cylinder|square|circle|polygon|polyhedron|linear_extrude|rotate_extrude)'
  const re2 = new RegExp(String.raw`(\b${heads}\s*\([^)]*)\}\s*\}\s*\)`, 'g')
  out = out.replace(re2, '$1)')
  const re1 = new RegExp(String.raw`(\b${heads}\s*\([^)]*)\}\s*\)`, 'g')
  out = out.replace(re1, '$1)')
  const re2s = new RegExp(String.raw`(\b${heads}\s*\([^)]*)\}\s*\}\s*\)\s*;`, 'g')
  out = out.replace(re2s, '$1);')
  const re1s = new RegExp(String.raw`(\b${heads}\s*\([^)]*)\}\s*\)\s*;`, 'g')
  out = out.replace(re1s, '$1);')
  return out
}

// Try to extract a numeric variable from code (simple assignments at top)
function findNumericVar(code: string, names: string[]): number | null {
  const head = code.replace(/\r\n/g, '\n').split('\n').slice(0, 200).join('\n')
  for (const name of names) {
    const re = new RegExp(String.raw`^\s*${name}\s*=\s*([-+]?\d*\.?\d+)\s*;`, 'mi')
    const m = head.match(re)
    if (m) {
      const val = Number(m[1])
      if (Number.isFinite(val)) return val
    }
  }
  return null
}

// Best-effort: if 2D primitives are used directly, extrude them a bit to contribute to 3D CSG
function ensure2DExtruded(code: string): string {
  const candidate = findNumericVar(code, ['handle_thickness', 'wall_thickness', 'thickness'])
  const height = candidate && candidate > 0 ? candidate : 3
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

export function sanitizeOpenSCAD(rawish: string) {
  let raw = (rawish || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim()
  // Strip fences if present
  const m = raw.match(/```(?:openscad|scad)?\s*([\s\S]*?)```/i)
  if (m) raw = m[1].trim()
  // Remove any $fn the model set; client controls tessellation
  raw = raw.replace(/^\s*\$fn\s*=\s*[^;]+;\s*/gmi, '')
  // Convert assignments to module calls
  raw = fixGeometryAssignments(raw)
  // Heal common syntax glitches
  raw = fixCommonSyntaxScad(raw)
  // Heal missing semicolons before '}' and at EOF
  raw = fixMissingSemicolonsNearBraces(raw)
  // Fix broken or empty call endings
  raw = fixBrokenEmptyCalls(raw)
  // Remove stray closing braces that leaked into function call argument lists
  raw = fixStrayBracesInCalls(raw)
  // Ensure 2D primitives are extruded when used in 3D CSG
  raw = ensure2DExtruded(raw)

  // Remove trailing non-code stray tokens (e.g., accidental words like "medium")
  try {
    const lines = raw.split('\n')
    const codeHead = /^(module|function)\b/i
    const callHead = /^(translate|rotate|scale|mirror|offset|union|difference|intersection|hull|minkowski|cube|sphere|cylinder|square|circle|polygon|polyhedron|linear_extrude|rotate_extrude)\s*\(/i
    const assignLine = /^\s*[A-Za-z_]\w*\s*=\s*[^;]+;\s*$/
    const closing = /^[}\]]\s*;?\s*$/
    const endsSemicolon = /;\s*$/
    const isCodey = (t: string) => {
      if (t === '') return false
      if (t.startsWith('//')) return true
      if (closing.test(t)) return true
      if (endsSemicolon.test(t)) return true
      if (codeHead.test(t)) return true
      if (callHead.test(t)) return true
      if (assignLine.test(t)) return true
      return false
    }
    while (lines.length > 0 && !isCodey(lines[lines.length - 1].trim())) {
      lines.pop()
    }
    raw = lines.join('\n')
  } catch {}
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
  return raw
}

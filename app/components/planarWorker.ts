// Web Worker: planar face grouping for STL geometry
// Receives: { positions: Float32Array, indices?: Uint32Array|null }
// Returns: { faceToGroup: Int32Array, groups: Array<{ id:number; label:[number,number,number] }> }

export type PlanarIn = {
  positions: Float32Array
  indices?: Uint32Array | null
}

export type PlanarOut = {
  faceToGroup: Int32Array
  groups: Array<{ id: number; label: [number, number, number] }>
}

// Use loosely-typed worker globals to avoid requiring the 'webworker' lib in tsconfig
// eslint-disable-next-line no-restricted-globals
const ctx: any = self as any

ctx.addEventListener('message', (e: any) => {
  const { positions, indices } = (e && e.data) as PlanarIn
  try {
    const out = buildPlanarGroups(positions, indices || null)
    ;(ctx.postMessage as any)(out, [out.faceToGroup.buffer])
  } catch (err) {
    ;(ctx.postMessage as any)({ faceToGroup: new Int32Array(0), groups: [] } as PlanarOut)
  }
})

function buildPlanarGroups(positions: Float32Array, indices: Uint32Array | null): PlanarOut {
  const hasIndex = !!indices && indices.length > 0
  const triCount = hasIndex ? (indices!.length / 3) : (positions.length / 9)
  const faceToGroup = new Int32Array(triCount).fill(-1)

  // rough quantization params
  const normalQuant = 0.05
  // distance quantization based on a rough diagonal estimate
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i+1], z = positions[i+2]
    if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z
    if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z
  }
  const dx = maxx - minx, dy = maxy - miny, dz = maxz - minz
  const diag = Math.sqrt(dx*dx + dy*dy + dz*dz) || 100
  const dQuant = Math.max(diag * 0.002, 0.2)

  const groups: Array<{ id: number; tris: number[]; label: [number, number, number] }> = []
  const keyToGroup = new Map<string, number>()

  const read = (i: number, out: [number,number,number]) => {
    out[0] = positions[i*3]; out[1] = positions[i*3+1]; out[2] = positions[i*3+2]
  }

  const vA: [number,number,number] = [0,0,0]
  const vB: [number,number,number] = [0,0,0]
  const vC: [number,number,number] = [0,0,0]

  for (let t = 0; t < triCount; t++) {
    const i0 = hasIndex ? indices![t*3] : t*3
    const i1 = hasIndex ? indices![t*3+1] : t*3+1
    const i2 = hasIndex ? indices![t*3+2] : t*3+2

    read(i0, vA); read(i1, vB); read(i2, vC)

    // normal = (vB-vA) x (vC-vA)
    const e1x = vB[0]-vA[0], e1y = vB[1]-vA[1], e1z = vB[2]-vA[2]
    const e2x = vC[0]-vA[0], e2y = vC[1]-vA[1], e2z = vC[2]-vA[2]
    let nx = e1y*e2z - e1z*e2y
    let ny = e1z*e2x - e1x*e2z
    let nz = e1x*e2y - e1y*e2x
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) continue
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz }

    const d = nx*vA[0] + ny*vA[1] + nz*vA[2]
    const qx = Math.round(nx / normalQuant) * normalQuant
    const qy = Math.round(ny / normalQuant) * normalQuant
    const qz = Math.round(nz / normalQuant) * normalQuant
    const qd = Math.round(d / dQuant) * dQuant
    const key = `${qx.toFixed(2)}|${qy.toFixed(2)}|${qz.toFixed(2)}|${qd.toFixed(3)}`

    let gid = keyToGroup.get(key)
    const cx = (vA[0]+vB[0]+vC[0])/3
    const cy = (vA[1]+vB[1]+vC[1])/3
    const cz = (vA[2]+vB[2]+vC[2])/3
    if (gid == null) {
      gid = groups.length
      keyToGroup.set(key, gid)
      groups.push({ id: gid, tris: [t], label: [cx, cy, cz] })
      faceToGroup[t] = gid
    } else {
      const g = groups[gid]
      g.tris.push(t)
      // running average
      const n = g.tris.length
      g.label[0] = g.label[0] + (cx - g.label[0]) / n
      g.label[1] = g.label[1] + (cy - g.label[1]) / n
      g.label[2] = g.label[2] + (cz - g.label[2]) / n
      faceToGroup[t] = gid
    }
  }

  return { faceToGroup, groups: groups.map(g => ({ id: g.id, label: g.label })) }
}

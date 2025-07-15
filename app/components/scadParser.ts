// app/components/scadParser.ts

'use client'

import * as THREE from 'three'

// @ts-ignore: No types available for internal JSCAD module
import { cube } from '@jscad/modeling/src/primitives'
// @ts-ignore
import { geom3 } from '@jscad/modeling/src/geometries'

export function geometriesFromScad(scadCode: string): THREE.BufferGeometry[] {
  const shape = cube({ size: 20 }) // ✅ TODO: Replace with parsed output
  const geometries: THREE.BufferGeometry[] = []

  if (!geom3.isA(shape)) return geometries

  const polygons = shape.polygons ?? []
  const positions: number[] = []

  polygons.forEach((polygon: { vertices: any[] }) => {
    const vertices = polygon.vertices
    for (let i = 1; i < vertices.length - 1; i++) {
      const v0 = vertices[0]
      const v1 = vertices[i]
      const v2 = vertices[i + 1]
      positions.push(...v0, ...v1, ...v2)
    }
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()

  geometries.push(geometry)
  return geometries
}

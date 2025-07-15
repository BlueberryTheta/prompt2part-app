// app/components/scadParser.ts
'use client'

import * as THREE from 'three'

// @ts-ignore
import { desugar } from '@jscad/openjscad/src/openjscad-parser'
// @ts-ignore
import { compile } from '@jscad/openjscad/src/openjscad-compiler'
// @ts-ignore
import { rebuildSolids } from '@jscad/openjscad/src/utils/rebuildSolids'
// @ts-ignore
import { geom3 } from '@jscad/modeling/src/geometries'

export function geometriesFromScad(scadCode: string): THREE.BufferGeometry[] {
  try {
    const ast = desugar(scadCode)
    const compiled = compile(ast)
    const solids = rebuildSolids(compiled)

    const geometries: THREE.BufferGeometry[] = []

    solids.forEach((shape: any) => {
      if (!geom3.isA(shape)) return

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
    })

    return geometries
  } catch (err) {
    console.error('Failed to parse SCAD:', err)
    return []
  }
}

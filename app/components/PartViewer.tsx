'use client'

import React, { useRef, useState, useEffect, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import { STLLoader } from 'three-stdlib'
import * as THREE from 'three'
import { BufferGeometry, Mesh } from 'three'

type PartViewerProps = {
  stlUrl: string
}

/** ---------- helpers ---------- **/

function computeBoundingBoxInfo(geometry: THREE.BufferGeometry | null) {
  if (!geometry) return null
  const geom = geometry.clone()
  geom.computeBoundingBox()
  const bb = geom.boundingBox!
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  bb.getSize(size)
  bb.getCenter(center)
  return { bb, size, center }
}

/**
 * Group triangles into logical planar faces by quantizing plane normals & offsets.
 * This collapses hundreds of triangles on a flat face (like a cube side) into 1 group.
 * Note: curved surfaces (cylinders) are *not* planar and will remain multi-triangle.
 */
function buildPlanarGroups(geometry: BufferGeometry) {
  // Ensure we have positions
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
  if (!posAttr) return { faceToGroup: new Int32Array(0), groups: [] as Array<{ id: number; tris: number[]; label: THREE.Vector3 }> }

  const indexAttr = geometry.getIndex()
  const hasIndex = !!indexAttr
  const indices = hasIndex ? (indexAttr!.array as ArrayLike<number>) : null

  const triCount = hasIndex ? indices!.length / 3 : posAttr.count / 3
  const faceToGroup = new Int32Array(triCount).fill(-1)

  const groups: Array<{ id: number; tris: number[]; label: THREE.Vector3 }> = []
  const keyToGroup = new Map<string, number>()

  // quantization tolerances
  const normalQuant = 0.05 // ~3° buckets
  // plane offset tolerance relative to part size
  const info = computeBoundingBoxInfo(geometry)
  const diag = info ? info.size.length() : 100
  const dQuant = Math.max(diag * 0.002, 0.2) // ~0.2mm or 0.2% diag

  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vC = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const n = new THREE.Vector3()

  function readVertex(i: number, target: THREE.Vector3) {
    target.set(
      posAttr.getX(i),
      posAttr.getY(i),
      posAttr.getZ(i),
    )
  }

  for (let t = 0; t < triCount; t++) {
    const i0 = hasIndex ? indices![t * 3 + 0] : t * 3 + 0
    const i1 = hasIndex ? indices![t * 3 + 1] : t * 3 + 1
    const i2 = hasIndex ? indices![t * 3 + 2] : t * 3 + 2

    readVertex(i0, vA)
    readVertex(i1, vB)
    readVertex(i2, vC)

    edge1.subVectors(vB, vA)
    edge2.subVectors(vC, vA)
    n.crossVectors(edge1, edge2).normalize()
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) continue

    // Normalize the normal so the major direction points consistently (optional)
    // Flip to make z >= 0 preference for stability
    if (n.z < 0) n.multiplyScalar(-1)

    // plane offset d = n · p
    const d = n.dot(vA)

    // quantize
    const qx = Math.round(n.x / normalQuant) * normalQuant
    const qy = Math.round(n.y / normalQuant) * normalQuant
    const qz = Math.round(n.z / normalQuant) * normalQuant
    const qd = Math.round(d / dQuant) * dQuant

    const key = `${qx.toFixed(2)}|${qy.toFixed(2)}|${qz.toFixed(2)}|${qd.toFixed(3)}`

    let gid = keyToGroup.get(key)
    if (gid == null) {
      gid = groups.length
      keyToGroup.set(key, gid)
      const centroid = new THREE.Vector3().addVectors(vA, vB).add(vC).multiplyScalar(1 / 3)
      groups.push({ id: gid, tris: [t], label: centroid })
      faceToGroup[t] = gid
    } else {
      groups[gid].tris.push(t)
      // update label position (average)
      const g = groups[gid]
      const count = g.tris.length
      const centroid = new THREE.Vector3().addVectors(vA, vB).add(vC).multiplyScalar(1 / 3)
      g.label.lerp(centroid, 1 / count)
      faceToGroup[t] = gid
    }
  }

  return { faceToGroup, groups }
}

/** ---------- small UI bits ---------- **/

function OrientationLabels({ geometry }: { geometry: BufferGeometry | null }) {
  const info = useMemo(() => computeBoundingBoxInfo(geometry), [geometry])
  if (!info) return null
  const { bb, size, center } = info
  const pad = Math.max(size.length() * 0.04, 6)

  const positions = [
    { name: 'Front', pos: [center.x, center.y - size.y * 0.7, bb.max.z + pad] }, // +Z
    { name: 'Back', pos: [center.x, center.y - size.y * 0.7, bb.min.z - pad] },  // -Z
    { name: 'Right', pos: [bb.max.x + pad, center.y - size.y * 0.9, center.z] }, // +X
    { name: 'Left', pos: [bb.min.x - pad, center.y - size.y * 1, center.z] },  // -X
    { name: 'Top', pos: [center.x, bb.max.y + pad, center.z] },                  // +Y
    { name: 'Bottom', pos: [center.x, bb.min.y - pad, center.z] },               // -Y
  ] as const

  return (
    <>
      {positions.map((o) => (
        <Html
          key={o.name}
          position={o.pos as [number, number, number]}
          center
          distanceFactor={8}
          /** ensure visible even when behind geometry */
          transform={false}
          occlude={false}
          zIndexRange={[10, 0]}
        >
          <div
            style={{
              background: 'rgba(53,126,221,0.92)',
              color: 'white',
              padding: '6px 10px',
              borderRadius: 8,
              fontWeight: 700,
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
              fontSize: 12,
              textTransform: 'uppercase',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          >
            {o.name}
          </div>
        </Html>
      ))}
    </>
  )
}

function GroupMarker({ position, groupId }: { position: THREE.Vector3; groupId: number }) {
  return (
    <>
      <mesh position={position}>
        <sphereGeometry args={[1.5, 14, 14]} />
        <meshStandardMaterial color="#ff6b6b" emissive="#ff6b6b" emissiveIntensity={0.3} />
      </mesh>
      <Html position={position} center zIndexRange={[20, 0]} transform={false} occlude={false}>
        <div
          style={{
            background: 'rgba(0,0,0,0.75)',
            color: 'white',
            padding: '4px 6px',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          Face G{groupId}
        </div>
      </Html>
    </>
  )
}

/** ---------- model ---------- **/

function STLModel({
  stlUrl,
  autoRotate,
  onGroupPick,
}: {
  stlUrl: string
  autoRotate: boolean
  onGroupPick: (info: { point: THREE.Vector3; groupId: number }) => void
}) {
  const meshRef = useRef<Mesh>(null)
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null)
  const [faceToGroup, setFaceToGroup] = useState<Int32Array | null>(null)
  const [groups, setGroups] = useState<Array<{ id: number; tris: number[]; label: THREE.Vector3 }>>([])
  const [hoverGid, setHoverGid] = useState<number | null>(null)
  const [hoverPoint, setHoverPoint] = useState<THREE.Vector3 | null>(null)

  useEffect(() => {
    if (!stlUrl) return
    const ac = new AbortController()
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(stlUrl, { signal: ac.signal, cache: 'no-store' })
        const buf = await res.arrayBuffer()
        if (!alive) return
        const loader = new STLLoader()
        const geom = loader.parse(buf)
        geom.computeVertexNormals()
        if (!alive) return
        setGeometry(geom)
        const { faceToGroup: map, groups } = buildPlanarGroups(geom)
        if (!alive) return
        setFaceToGroup(map)
        setGroups(groups)
      } catch (e: any) {
        if (e?.name !== 'AbortError') console.error('Failed to load STL:', e)
      }
    })()
    return () => {
      alive = false
      ac.abort()
    }
  }, [stlUrl])

  useFrame(() => {
    if (autoRotate && meshRef.current) {
      meshRef.current.rotation.y += 0.003
    }
  })

  const baseMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#357edd',
        metalness: 0.4,
        roughness: 0.35,
      }),
    []
  )
  const hoverMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#4c9aff',
        metalness: 0.2,
        roughness: 0.5,
      }),
    []
  )

  const useHover = hoverGid !== null

  return geometry ? (
    <>
      <OrientationLabels geometry={geometry} />

      <mesh
        ref={meshRef}
        geometry={geometry}
        material={useHover ? hoverMaterial : baseMaterial}
        onPointerMove={(e) => {
          e.stopPropagation()
          if (faceToGroup == null) return
          const fi = e.faceIndex ?? -1
          if (fi < 0) {
            setHoverGid(null)
            setHoverPoint(null)
            return
          }
          const gid = faceToGroup[fi]
          setHoverGid(gid >= 0 ? gid : null)
          setHoverPoint(e.point.clone())
        }}
        onPointerOut={() => {
          setHoverGid(null)
          setHoverPoint(null)
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (faceToGroup == null || e.faceIndex == null) return
          const gid = faceToGroup[e.faceIndex]
          if (gid >= 0) {
            onGroupPick({ point: e.point.clone(), groupId: gid })
          }
        }}
      />

      {hoverPoint != null && hoverGid != null && (
        <Html position={hoverPoint} center zIndexRange={[15, 0]} transform={false} occlude={false}>
          <div
            style={{
              background: 'rgba(0,0,0,0.7)',
              color: 'white',
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 11,
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          >
            G{hoverGid}
          </div>
        </Html>
      )}
    </>
  ) : null
}

/** ---------- main viewer ---------- **/

export default function PartViewer({ stlUrl }: PartViewerProps) {
  const [picked, setPicked] = useState<{ point: THREE.Vector3; groupId: number } | null>(null)
  const [autoRotate, setAutoRotate] = useState<boolean>(true)

  return (
    <div className="w-full h-[400px] border rounded bg-white relative">
      {/* HUD */}
      <div className="absolute left-2 top-2 z-10 text-xs px-2 py-1 rounded bg-black/60 text-white pointer-events-none">
        {picked ? (
          <span>
            Selected <strong>Face G{picked.groupId}</strong> — reference this in your prompt.
          </span>
        ) : (
          <span>Hover to see group IDs; click to select a planar face (G#).</span>
        )}
      </div>

      {/* Auto-rotate toggle */}
      <div className="absolute right-2 top-2 z-10">
        <button
          className="px-3 py-1 rounded bg-gray-900 text-white text-xs shadow hover:bg-black"
          onClick={() => setAutoRotate(v => !v)}
        >
          {autoRotate ? '⏸ Pause Rotate' : '▶️ Auto Rotate'}
        </button>
      </div>

      {/* Copy selection */}
      {picked && (
        <div className="absolute right-2 bottom-2 z-10">
          <button
            className="px-3 py-1 rounded bg-indigo-600 text-white text-xs shadow hover:bg-indigo-700"
            onClick={() => {
              navigator.clipboard?.writeText(`Face G${picked.groupId}`)
            }}
          >
            Copy “Face G{picked.groupId}”
          </button>
        </div>
      )}

      <Canvas camera={{ position: [70, 70, 70], near: 0.1, far: 2000 }}>
        <ambientLight intensity={0.8} />
        <directionalLight position={[50, 50, 50]} intensity={0.7} />
        <OrbitControls enablePan enableZoom enableRotate />
        <STLModel
          key={stlUrl} /* force remount on new STL */
          stlUrl={stlUrl}
          autoRotate={autoRotate}
          onGroupPick={({ point, groupId }) => setPicked({ point, groupId })}
        />
        {/* Selected group marker (at last click point) */}
        {picked && <GroupMarker position={picked.point} groupId={picked.groupId} />}
      </Canvas>
    </div>
  )
}

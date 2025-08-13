'use client'

import React, { useRef, useState, useEffect, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import { STLLoader } from 'three-stdlib'
import * as THREE from 'three'
import { BufferGeometry, Mesh } from 'three'

/** ---------- types ---------- **/

export type Feature = {
  id: string
  label: string
  groupId?: number
  position?: [number, number, number]
}

type PartViewerProps = {
  stlUrl: string
  /** Optional list of model features you maintain in the app state */
  features?: Feature[]
  /** Called when user selects a feature from the list or the scene (feature list click) */
  onFeatureSelect?: (featureId: string | null) => void
  /** Called when the user clicks a planar face in the scene (groupId + 3D point) */
  onScenePick?: (args: { groupId: number; point: [number, number, number] }) => void
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
 * Note: curved surfaces (cylinders) are *not* planar and stay split.
 */
function buildPlanarGroups(geometry: BufferGeometry) {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
  if (!posAttr) {
    return {
      faceToGroup: new Int32Array(0),
      groups: [] as Array<{ id: number; tris: number[]; label: THREE.Vector3 }>,
    }
  }

  const indexAttr = geometry.getIndex()
  const hasIndex = !!indexAttr
  const indices = hasIndex ? (indexAttr!.array as ArrayLike<number>) : null

  const triCount = hasIndex ? indices!.length / 3 : posAttr.count / 3
  const faceToGroup = new Int32Array(triCount).fill(-1)

  const groups: Array<{ id: number; tris: number[]; label: THREE.Vector3 }> = []
  const keyToGroup = new Map<string, number>()

  const normalQuant = 0.05 // ~3°
  const info = computeBoundingBoxInfo(geometry)
  const diag = info ? info.size.length() : 100
  const dQuant = Math.max(diag * 0.002, 0.2)

  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vC = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const n = new THREE.Vector3()

  const readVertex = (i: number, target: THREE.Vector3) => {
    target.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i))
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

    // stabilize orientation (optional)
    if (n.z < 0) n.multiplyScalar(-1)

    // plane offset
    const d = n.dot(vA)

    // quantize
    const qx = Math.round(n.x / normalQuant) * normalQuant
    const qy = Math.round(n.y / normalQuant) * normalQuant
    const qz = Math.round(n.z / normalQuant) * normalQuant
    const qd = Math.round(d / dQuant) * dQuant

    const key = `${qx.toFixed(2)}|${qy.toFixed(2)}|${qz.toFixed(2)}|${qd.toFixed(3)}`
    let gid = keyToGroup.get(key)
    const centroid = new THREE.Vector3().addVectors(vA, vB).add(vC).multiplyScalar(1 / 3)

    if (gid == null) {
      gid = groups.length
      keyToGroup.set(key, gid)
      groups.push({ id: gid, tris: [t], label: centroid })
      faceToGroup[t] = gid
    } else {
      const g = groups[gid]
      g.tris.push(t)
      g.label.lerp(centroid, 1 / g.tris.length) // running average
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
    { name: 'Front', pos: [center.x, center.y - size.y * 0.3, bb.max.z + pad] }, // +Z
    { name: 'Back', pos: [center.x, center.y - size.y * 0.3, bb.min.z - pad] }, // -Z
    { name: 'Right', pos: [bb.max.x + pad, center.y - size.y * 0.3, center.z] }, // +X
    { name: 'Left', pos: [bb.min.x - pad, center.y - size.y * 0.3, center.z] },  // -X
    { name: 'Top', pos: [center.x, bb.max.y + pad, center.z] },                  // +Y
    { name: 'Bottom', pos: [center.x, bb.min.y - pad, center.z] },               // -Y
  ] as const

  return (
    <>
      {positions.map(o => (
        <Html
          key={o.name}
          position={o.pos as [number, number, number]}
          center
          distanceFactor={8}
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
  selectedGroupId,
  selectedPoint,
}: {
  stlUrl: string
  autoRotate: boolean
  onGroupPick: (info: { point: THREE.Vector3; groupId: number }) => void
  selectedGroupId?: number | null
  selectedPoint?: THREE.Vector3 | null
}) {
  const meshRef = useRef<Mesh>(null)
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null)
  const [faceToGroup, setFaceToGroup] = useState<Int32Array | null>(null)
  const [groups, setGroups] = useState<Array<{ id: number; tris: number[]; label: THREE.Vector3 }>>([])
  const [hoverGid, setHoverGid] = useState<number | null>(null)
  const [hoverPoint, setHoverPoint] = useState<THREE.Vector3 | null>(null)

  // Load STL with no-store to avoid caching + clean up geometry on unmount
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
      // dispose geometry/materials on unmount
      if (meshRef.current) {
        meshRef.current.geometry?.dispose()
        // @ts-ignore
        meshRef.current.material?.dispose?.()
      }
    }
  }, [stlUrl])

  // Apply external selection (feature click) as a persistent highlight
  useEffect(() => {
    if (selectedGroupId == null) return
    if (selectedPoint) {
      setHoverPoint(selectedPoint.clone())
    } else {
      const g = groups.find(g => g.id === selectedGroupId)
      if (g) setHoverPoint(g.label.clone())
    }
    setHoverGid(selectedGroupId)
  }, [selectedGroupId, selectedPoint, groups])

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
          if (fi < 0) return
          const gid = faceToGroup[fi]
          setHoverGid(gid >= 0 ? gid : null)
          setHoverPoint(e.point.clone())
        }}
        onPointerOut={() => {
          // keep external selection; don't wipe on pointer out
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (faceToGroup == null || e.faceIndex == null) return
          const gid = faceToGroup[e.faceIndex]
          if (gid >= 0) onGroupPick({ point: e.point.clone(), groupId: gid })
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

/** ---------- main viewer + feature list ---------- **/

export default function PartViewer({
  stlUrl,
  features = [],
  onFeatureSelect,
  onScenePick,
}: PartViewerProps) {
  const [picked, setPicked] = useState<{ point: THREE.Vector3; groupId: number } | null>(null)
  const [autoRotate, setAutoRotate] = useState<boolean>(true)

  // feature selection within the viewer (list click)
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null)

  const selectedFeature = useMemo(
    () => features.find((f) => f.id === selectedFeatureId) || null,
    [features, selectedFeatureId]
  )

  // Derive selected group/point for scene highlight from the selected feature
  const selectedGroupId = selectedFeature?.groupId ?? null
  const selectedPoint = useMemo(() => {
    if (!selectedFeature?.position) return null
    const [x, y, z] = selectedFeature.position
    return new THREE.Vector3(x, y, z)
  }, [selectedFeature])

  // Scene pick -> bubble up (for your dashboard to map/record), also clear feature list selection
  const handleScenePick = ({ point, groupId }: { point: THREE.Vector3; groupId: number }) => {
    setPicked({ point, groupId })
    setSelectedFeatureId(null)
    onFeatureSelect?.(null)
    // >>> changed: send tuple, not Vector3
    onScenePick?.({ groupId, point: [point.x, point.y, point.z] })
  }

  // Feature list click -> local selection + callback
  const handleFeatureClick = (f: Feature) => {
    setSelectedFeatureId(f.id)
    onFeatureSelect?.(f.id)
    setPicked(null) // switch to feature-driven highlight
  }

  return (
    <div className="w-full border rounded bg-white relative">
      {/* HUD */}
      <div className="absolute left-2 top-2 z-10 text-xs px-2 py-1 rounded bg-black/60 text-white pointer-events-none">
        {picked ? (
          <span>
            Selected <strong>Face G{picked.groupId}</strong> — reference this in your prompt.
          </span>
        ) : selectedFeature ? (
          <span>
            Selected feature <strong>{selectedFeature.label}</strong>
            {selectedGroupId != null ? ` (G${selectedGroupId})` : ''}
          </span>
        ) : (
          <span>Hover to see group IDs; click to select a planar face (G#).</span>
        )}
      </div>

      {/* Auto-rotate toggle */}
      <div className="absolute right-2 top-2 z-10">
        <button
          className="px-3 py-1 rounded bg-gray-900 text-white text-xs shadow hover:bg-black"
          onClick={() => setAutoRotate((v) => !v)}
        >
          {autoRotate ? '⏸ Pause Rotate' : '▶️ Auto Rotate'}
        </button>
      </div>

      {/* Canvas */}
      <div className="w-full h-[400px]">
        <Canvas camera={{ position: [70, 70, 70], near: 0.1, far: 2000 }}>
          <ambientLight intensity={0.8} />
          <directionalLight position={[50, 50, 50]} intensity={0.7} />
          <OrbitControls enablePan enableZoom enableRotate />
          <STLModel
            key={stlUrl} // force remount on each new STL
            stlUrl={stlUrl}
            autoRotate={autoRotate}
            onGroupPick={handleScenePick}
            selectedGroupId={selectedGroupId}
            selectedPoint={selectedPoint}
          />
          {/* Marker for last scene-picked face */}
          {picked && <GroupMarker position={picked.point} groupId={picked.groupId} />}
          {/* If a feature is selected (with group/position), show a marker too */}
          {!picked && selectedGroupId != null && selectedPoint && (
            <GroupMarker position={selectedPoint} groupId={selectedGroupId} />
          )}
        </Canvas>
      </div>

      {/* Feature list (scrollable) */}
      <div className="p-2 border-t">
        <div className="text-sm font-semibold mb-1">Features</div>
        {features.length === 0 ? (
          <div className="text-xs text-gray-600">No features yet.</div>
        ) : (
          <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
            {features.map((f) => {
              const isActive = f.id === selectedFeatureId
              return (
                <button
                  key={f.id}
                  onClick={() => handleFeatureClick(f)}
                  className={`w-full text-left px-2 py-1 rounded text-sm transition
                    ${isActive ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-900'}`}
                  title={f.groupId != null ? `Face G${f.groupId}` : undefined}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{f.label}</span>
                    {f.groupId != null && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${isActive ? 'bg-white/20' : 'bg-gray-200 text-gray-700'}`}>
                        G{f.groupId}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

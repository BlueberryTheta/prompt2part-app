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

type GroupPickInfo = {
  point: THREE.Vector3
  groupId: number
  groupLabel?: THREE.Vector3
  nearestVertex?: THREE.Vector3
}

type PartViewerProps = {
  stlUrl: string
  /** Optional list of model features you maintain in the app state */
  features?: Feature[]
  /** Called when user selects a feature from the list or the scene (feature list click) */
  onFeatureSelect?: (featureId: string | null) => void
  /** Called when the user clicks a planar face in the scene (groupId + 3D point) */
  onScenePick?: (args: { groupId: number; point: THREE.Vector3 }) => void
  /** Optional externally controlled selected feature id */
  selectedFeatureId?: string | null
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

/** Draw a simple line segment between two points without relying on drei's Line */
function SimpleMeasureLine({ a, b, color = '#ffffff' }: { a: THREE.Vector3; b: THREE.Vector3; color?: string }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const arr = new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z])
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    return g
  }, [a, b])
  useEffect(() => () => geom.dispose(), [geom])
  return (
    <line>
      <primitive object={geom} attach="geometry" />
      <lineBasicMaterial attach="material" color={color} />
    </line>
  )
}

/** Build a sub-geometry (copy of selected triangles only) for highlight overlay */
function buildSubGeometryForGroup(
  geometry: BufferGeometry,
  faceToGroup: Int32Array,
  targetGid: number
): BufferGeometry | null {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
  if (!posAttr) return null

  const indexAttr = geometry.getIndex()
  const hasIndex = !!indexAttr
  const indices = hasIndex ? (indexAttr!.array as ArrayLike<number>) : null
  const triCount = hasIndex ? indices!.length / 3 : posAttr.count / 3

  // Collect vertex positions for triangles belonging to target gid
  const verts: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (faceToGroup[t] !== targetGid) continue
    const i0 = hasIndex ? indices![t * 3 + 0] : t * 3 + 0
    const i1 = hasIndex ? indices![t * 3 + 1] : t * 3 + 1
    const i2 = hasIndex ? indices![t * 3 + 2] : t * 3 + 2

    verts.push(
      posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0),
      posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1),
      posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2),
    )
  }
  if (verts.length === 0) return null

  const sub = new THREE.BufferGeometry()
  sub.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  sub.computeVertexNormals()
  return sub
}

/** ---------- small UI bits ---------- **/

// Orientation labels removed per UI request

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
  markCenterFallback,
}: {
  stlUrl: string
  autoRotate: boolean
  onGroupPick: (info: GroupPickInfo) => void
  selectedGroupId?: number | null
  selectedPoint?: THREE.Vector3 | null
  markCenterFallback?: boolean
}) {
  const meshRef = useRef<Mesh>(null)
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null)
  const [faceToGroup, setFaceToGroup] = useState<Int32Array | null>(null)
  const [groups, setGroups] = useState<Array<{ id: number; tris: number[]; label: THREE.Vector3 }>>([])
  const [hoverGid, setHoverGid] = useState<number | null>(null)
  const [hoverPoint, setHoverPoint] = useState<THREE.Vector3 | null>(null)

  // Load STL with no-store to avoid caching + planargroup via worker for large meshes
  useEffect(() => {
    if (!stlUrl) return
    const ac = new AbortController()
    let alive = true
    let worker: Worker | null = null

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
        const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | null
        const indexAttr = geom.getIndex()
        const triCount = posAttr ? (indexAttr ? (indexAttr.count / 3) : (posAttr.count / 3)) : 0
        if (posAttr && triCount > 50000) {
          // Offload to worker
          const positions = posAttr.array as Float32Array
          const rawIndex: any = indexAttr?.array ?? null
          const indices = rawIndex ? new Uint32Array(rawIndex.buffer.slice(rawIndex.byteOffset, rawIndex.byteOffset + rawIndex.byteLength)) : null
          worker = new Worker(new URL('./planarWorker.ts', import.meta.url), { type: 'module' })
          worker.onmessage = (ev: MessageEvent<any>) => {
            if (!alive) return
            const out = ev.data as { faceToGroup: Int32Array; groups: Array<{ id:number; label:[number,number,number] }> }
            setFaceToGroup(out.faceToGroup)
            setGroups(out.groups.map(g => ({ id: g.id, tris: [], label: new THREE.Vector3(g.label[0], g.label[1], g.label[2]) })))
          }
          worker.postMessage({ positions, indices }, [positions.buffer, indices?.buffer].filter(Boolean) as any)
        } else {
          const { faceToGroup: map, groups } = buildPlanarGroups(geom)
          if (!alive) return
          setFaceToGroup(map)
          setGroups(groups)
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError') console.error('Failed to load STL:', e)
      }
    })()

    return () => {
      alive = false
      ac.abort()
      if (worker) {
        try { worker.terminate() } catch {}
      }
      if (meshRef.current) {
        meshRef.current.geometry?.dispose()
        // @ts-ignore
        meshRef.current.material?.dispose?.()
      }
    }
  }, [stlUrl])

  // Keep a persistent selection even when pointer leaves
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
  useEffect(() => () => baseMaterial.dispose(), [baseMaterial])

  // 🔹 Highlight material (semi-transparent overlay for selected group)
  const highlightMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#ffd166',
        emissive: '#ffbf00' as any,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      }),
    []
  )
  useEffect(() => () => highlightMaterial.dispose(), [highlightMaterial])

  // Which group should be highlighted right now?
  const activeHighlightGid = selectedGroupId ?? hoverGid ?? null

  const subGeom = useMemo(() => {
    if (!geometry || !faceToGroup || activeHighlightGid == null) return null
    return buildSubGeometryForGroup(geometry, faceToGroup, activeHighlightGid)
  }, [geometry, faceToGroup, activeHighlightGid])

  // Where to put the marker label (centroid of the active group, or pointer point)
  const activeMarkerPoint = useMemo(() => {
    if (selectedPoint) return selectedPoint
    if (activeHighlightGid != null) {
      const g = groups.find(x => x.id === activeHighlightGid)
      if (g) return g.label
    }
    // Fallback: when requested (feature selected without group/point), mark the model center
    if (markCenterFallback && geometry) {
      const info = computeBoundingBoxInfo(geometry)
      if (info) return info.center.clone()
    }
    return hoverPoint || null
  }, [selectedPoint, activeHighlightGid, groups, hoverPoint, markCenterFallback, geometry])

  return geometry ? (
    <>
      {/* Orientation labels removed */}

      {/* Base mesh (never tinted fully by selection) */}
      <mesh
        ref={meshRef}
        geometry={geometry}
        material={baseMaterial}
        onPointerMove={(e) => {
          e.stopPropagation()
          if (!faceToGroup) return
          const fi = e.faceIndex ?? -1
          if (fi < 0) return
          const gid = faceToGroup[fi]
          setHoverGid(gid >= 0 ? gid : null)
          setHoverPoint(e.point.clone())
        }}
        onPointerOut={() => {
          // keep external selection; only clear transient hover
          setHoverGid(null)
          setHoverPoint(null)
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (!faceToGroup || e.faceIndex == null) return
          const gid = faceToGroup[e.faceIndex]
          if (gid >= 0) onGroupPick({
            point: e.point.clone(),
            groupId: gid,
          })
        }}
      />

      {/* Overlay submesh for the selected/hovered group */}
      {subGeom && (
        <mesh geometry={subGeom} material={highlightMaterial} />
      )}

      {/* Marker label for selected/hovered group */}
      {activeHighlightGid != null && activeMarkerPoint && (
        <Html position={activeMarkerPoint} center zIndexRange={[18, 0]} transform={false} occlude={false}>
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
            G{activeHighlightGid}
          </div>
        </Html>
      )}

      {/* Fallback visual marker when a feature is selected without a group/point */}
      {markCenterFallback && activeMarkerPoint && (
        <>
          <mesh position={activeMarkerPoint}>
            <sphereGeometry args={[1.8, 16, 16]} />
            <meshBasicMaterial color="#ffd166" depthTest={false} depthWrite={false} transparent opacity={0.95} />
          </mesh>
          <Html position={activeMarkerPoint} center zIndexRange={[22, 0]} transform={false} occlude={false}>
            <div style={{ background: 'rgba(255, 209, 102, 0.95)', color: '#1a1a1a', padding: '3px 6px', borderRadius: 6, fontSize: 11, fontWeight: 700, boxShadow: '0 2px 6px rgba(0,0,0,0.35)', userSelect: 'none' }}>
              Selected
            </div>
          </Html>
        </>
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
  selectedFeatureId: selectedFeatureIdProp = null,
}: PartViewerProps) {
  const [picked, setPicked] = useState<{ point: THREE.Vector3; groupId: number } | null>(null)
  const [autoRotate, setAutoRotate] = useState<boolean>(true)
  // grid removed per UI request
  const [measureMode, setMeasureMode] = useState<boolean>(false)
  const [measurePts, setMeasurePts] = useState<THREE.Vector3[]>([])
  const [snapMode, setSnapMode] = useState<'none'|'face'|'vertex'>('none')
  const [units, setUnits] = useState<'mm'|'inch'>('mm')

  // feature selection within the viewer (list click) with optional external control
  const [internalSelectedFeatureId, setInternalSelectedFeatureId] = useState<string | null>(null)
  const selectedFeatureId = selectedFeatureIdProp ?? internalSelectedFeatureId


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
    setInternalSelectedFeatureId(null)
    onFeatureSelect?.(null)
    onScenePick?.({ groupId, point })
  }

  // Feature list click -> local selection + callback
  const handleFeatureClick = (f: Feature) => {
    setInternalSelectedFeatureId(f.id)
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

      {/* Tools */}
      <div className="absolute right-2 top-12 z-10 flex gap-1">
        <button
          className="px-2 py-1 rounded bg-gray-900 text-white text-xs shadow hover:bg-black"
          onClick={() => { setMeasureMode(v => !v); setMeasurePts([]) }}
        >
          {measureMode ? 'Exit Measure' : 'Measure'}
        </button>
        <select className="px-1 py-1 rounded bg-gray-900 text-white text-xs shadow" value={snapMode} onChange={e => setSnapMode(e.target.value as any)}>
          <option value="none">Snap: None</option>
          <option value="face">Snap: Face</option>
          <option value="vertex">Snap: Vertex</option>
        </select>
        <select className="px-1 py-1 rounded bg-gray-900 text-white text-xs shadow" value={units} onChange={e => setUnits(e.target.value as any)}>
          <option value="mm">mm</option>
          <option value="inch">inch</option>
        </select>
      </div>

      {/* Canvas */}
      <div className="w-full h-[400px]">
        <Canvas
          camera={{ position: [70, 70, 70], near: 0.1, far: 2000 }}
          frameloop={autoRotate ? 'always' : 'demand'}
          dpr={[1, 1.5]}
        >
          {/* grid removed */}
          <ambientLight intensity={0.8} />
          <directionalLight position={[50, 50, 50]} intensity={0.7} />
          <OrbitControls enablePan enableZoom enableRotate />
          <STLModel
            key={stlUrl} // force remount on each new STL
            stlUrl={stlBlobSafe(stlUrl)}
            autoRotate={autoRotate}
            onGroupPick={(info) => {
              if (measureMode) {
                const p = snapMode === 'face' && info.groupLabel ? info.groupLabel
                  : snapMode === 'vertex' && info.nearestVertex ? info.nearestVertex
                  : info.point
                setMeasurePts(prev => {
                  const next = [...prev, p.clone()]
                  return next.slice(-2)
                })
              } else {
                handleScenePick({ point: info.point, groupId: info.groupId })
              }
            }}
            selectedGroupId={selectedGroupId}
            selectedPoint={selectedPoint}
            markCenterFallback={!!(selectedFeature && !selectedGroupId && !selectedPoint)}
          />
          {/* Optional marker for last scene-picked face */}
          {picked && <GroupMarker position={picked.point} groupId={picked.groupId} />}
          {measureMode && measurePts.length === 2 && (
            <>
              <SimpleMeasureLine a={measurePts[0]} b={measurePts[1]} color="#ffffff" />
              <Html position={measurePts[1]} center zIndexRange={[21, 0]} transform={false} occlude={false}>
                <div style={{ background: 'rgba(0,0,0,0.75)', color: 'white', padding: '4px 6px', borderRadius: 6, fontSize: 12 }}>
                  {(() => { const mm = measurePts[0].distanceTo(measurePts[1]); return units === 'mm' ? `${mm.toFixed(2)} mm` : `${(mm/25.4).toFixed(3)} in`; })()}
                </div>
              </Html>
            </>
          )}
          {measureMode && measurePts.length === 2 && (
            <Html position={measurePts[1]} center zIndexRange={[21, 0]} transform={false} occlude={false}>
              <div style={{ background: 'rgba(0,0,0,0.75)', color: 'white', padding: '4px 6px', borderRadius: 6, fontSize: 12 }}>
                {measurePts[0].distanceTo(measurePts[1]).toFixed(2)} mm
              </div>
            </Html>
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

/** Ensure URL is treated as unique for R3F keying but not re-downloaded unnecessarily */
function stlBlobSafe(url: string) {
  return url
}

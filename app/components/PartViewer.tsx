'use client'

import React, { useRef, useState, useEffect, useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import { STLLoader } from 'three-stdlib'
import * as THREE from 'three'
import { BufferGeometry, Mesh } from 'three'

type PartViewerProps = {
  stlUrl: string
}

// =============== Helpers ===============
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

// =============== Face Label ===============
function FaceMarker({
  position,
  faceIndex,
}: {
  position: [number, number, number]
  faceIndex: number
}) {
  return (
    <>
      {/* small marker sphere */}
      <mesh position={position}>
        <sphereGeometry args={[1.2, 12, 12]} />
        <meshStandardMaterial color="#ff6b6b" emissive="#ff6b6b" emissiveIntensity={0.25} />
      </mesh>
      {/* floating HTML label */}
      <Html position={position} center zIndexRange={[10, 0]}>
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
          }}
        >
          Face F{faceIndex}
        </div>
      </Html>
    </>
  )
}

// =============== Orientation Labels ===============
function OrientationLabels({ geometry }: { geometry: BufferGeometry | null }) {
  const info = useMemo(() => computeBoundingBoxInfo(geometry), [geometry])
  if (!info) return null
  const { bb, size, center } = info
  const pad = Math.max(size.length() * 0.02, 4) // small offset outward

  const positions = [
    { name: 'Front', pos: [center.x, center.y - size.y * 0.3, bb.max.z + pad] }, // +Z
    { name: 'Back', pos: [center.x, center.y - size.y * 0.3, bb.min.z - pad] },  // -Z
    { name: 'Right', pos: [bb.max.x + pad, center.y - size.y * 0.3, center.z] }, // +X
    { name: 'Left', pos: [bb.min.x - pad, center.y - size.y * 0.3, center.z] },  // -X
    { name: 'Top', pos: [center.x, bb.max.y + pad, center.z] },                  // +Y
    { name: 'Bottom', pos: [center.x, bb.min.y - pad, center.z] },               // -Y
  ] as const

  return (
    <>
      {positions.map((o) => (
        <Html key={o.name} position={o.pos as [number, number, number]} center distanceFactor={8} zIndexRange={[0, 0]}>
          <div
            style={{
              background: 'rgba(53,126,221,0.85)',
              color: 'white',
              padding: '6px 10px',
              borderRadius: 8,
              fontWeight: 700,
              boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
              fontSize: 12,
              textTransform: 'uppercase',
              userSelect: 'none',
            }}
          >
            {o.name}
          </div>
        </Html>
      ))}
    </>
  )
}

// =============== STL Model ===============
function STLModel({
  stlUrl,
  onFacePick,
}: {
  stlUrl: string
  onFacePick: (info: { point: THREE.Vector3; faceIndex: number }) => void
}) {
  const meshRef = useRef<Mesh>(null)
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null)
  const [hoverPoint, setHoverPoint] = useState<THREE.Vector3 | null>(null)
  const [hoverFaceIndex, setHoverFaceIndex] = useState<number | null>(null)

  useEffect(() => {
    if (!stlUrl) return
    let isMounted = true
    ;(async () => {
      try {
        const res = await fetch(stlUrl)
        const buf = await res.arrayBuffer()
        const loader = new STLLoader()
        const geom = loader.parse(buf)
        geom.computeVertexNormals()
        if (isMounted) setGeometry(geom)
      } catch (e) {
        console.error('Failed to load STL:', e)
      }
    })()
    return () => {
      isMounted = false
    }
  }, [stlUrl])

  // gentle autorotation
  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.0025
    }
  })

  const material = useMemo(
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

  return geometry ? (
    <>
      {/* Orientation labels (Front/Back/Top/Bottom/Left/Right) */}
      <OrientationLabels geometry={geometry} />

      <mesh
        ref={meshRef}
        geometry={geometry}
        material={hoverFaceIndex !== null ? hoverMaterial : material}
        onPointerMove={(e) => {
          e.stopPropagation()
          const i = e.faceIndex ?? null
          setHoverFaceIndex(i)
          // world-space hit point
          const p = e.point.clone()
          setHoverPoint(p)
        }}
        onPointerOut={() => {
          setHoverFaceIndex(null)
          setHoverPoint(null)
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (e.faceIndex == null) return
          onFacePick({ point: e.point.clone(), faceIndex: e.faceIndex })
        }}
      />
      {/* Hover tip (not selected, just feedback) */}
      {hoverPoint && hoverFaceIndex !== null && (
        <Html position={hoverPoint} center zIndexRange={[5, 0]}>
          <div
            style={{
              background: 'rgba(0,0,0,0.7)',
              color: 'white',
              padding: '2px 5px',
              borderRadius: 4,
              fontSize: 11,
              userSelect: 'none',
            }}
          >
            F{hoverFaceIndex}
          </div>
        </Html>
      )}
    </>
  ) : null
}

// =============== Main Viewer ===============
export default function PartViewer({ stlUrl }: PartViewerProps) {
  const [picked, setPicked] = useState<{ point: THREE.Vector3; faceIndex: number } | null>(null)

  return (
    <div className="w-full h-[400px] border rounded bg-white relative">
      {/* Small HUD for instructions + picked face */}
      <div className="absolute left-2 top-2 z-10 text-xs px-2 py-1 rounded bg-black/60 text-white pointer-events-none">
        {picked ? (
          <span>
            Selected <strong>Face F{picked.faceIndex}</strong> — reference this in your prompt.
          </span>
        ) : (
          <span>Click a face to select it (Face IDs show as F#).</span>
        )}
      </div>

      <Canvas camera={{ position: [70, 70, 70], near: 0.1, far: 2000 }}>
        <ambientLight intensity={0.8} />
        <directionalLight position={[50, 50, 50]} intensity={0.7} />
        <OrbitControls enablePan enableZoom enableRotate />
        <STLModel
          stlUrl={stlUrl}
          onFacePick={({ point, faceIndex }) => {
            setPicked({ point, faceIndex })
          }}
        />
      </Canvas>

      {/* Persist selected marker label in overlay */}
      {picked && (
        <div className="absolute right-2 bottom-2 z-10">
          <button
            className="px-3 py-1 rounded bg-indigo-600 text-white text-xs shadow hover:bg-indigo-700"
            onClick={() => {
              navigator.clipboard?.writeText(`Face F${picked.faceIndex}`)
            }}
          >
            Copy “Face F{picked.faceIndex}”
          </button>
        </div>
      )}
    </div>
  )
}

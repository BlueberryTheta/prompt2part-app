'use client'

import React, { useRef, useState, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { STLLoader } from 'three-stdlib'
import { BufferGeometry, MeshStandardMaterial, Mesh } from 'three'

type PartViewerProps = {
  stlUrl: string
}

function STLModel({ stlUrl }: { stlUrl: string }) {
  const meshRef = useRef<Mesh>(null)
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null)

  useEffect(() => {
    if (!stlUrl) return

    fetch(stlUrl)
      .then(res => res.arrayBuffer())
      .then(data => {
        const loader = new STLLoader()
        const geom = loader.parse(data)
        setGeometry(geom)
      })
      .catch(err => console.error('Failed to load STL:', err))
  }, [stlUrl])

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.005
    }
  })

  return geometry ? (
    <mesh ref={meshRef} geometry={geometry}>
      <meshStandardMaterial color="#357edd" metalness={0.5} roughness={0.3} />
    </mesh>
  ) : null
}

export default function PartViewer({ stlUrl }: PartViewerProps) {
  return (
    <div className="w-full h-[400px] border rounded bg-white">
      <Canvas camera={{ position: [70, 70, 70], near: 0.1, far: 1000 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[50, 50, 50]} intensity={0.5} />
        <OrbitControls enablePan={true} enableZoom={true} enableRotate={true} />
        <STLModel stlUrl={stlUrl} />
      </Canvas>
    </div>
  )
}

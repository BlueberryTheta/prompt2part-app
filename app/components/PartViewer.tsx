'use client'

import React, { useRef } from 'react'
import { Canvas, useFrame, useLoader } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { STLLoader } from 'three-stdlib'
import { BufferGeometry, MeshStandardMaterial, Mesh } from 'three'

type PartViewerProps = {
  stlUrl: string
}

function STLModel({ stlUrl }: { stlUrl: string }) {
  const geometry = useLoader(STLLoader, stlUrl)
  const meshRef = useRef<Mesh>(null)

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.005
    }
  })

  return (
    <mesh ref={meshRef} geometry={geometry as BufferGeometry}>
      <meshStandardMaterial color="#357edd" metalness={0.5} roughness={0.3} />
    </mesh>
  )
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

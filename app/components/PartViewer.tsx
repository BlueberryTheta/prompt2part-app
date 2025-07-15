'use client'

import React, { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { geometriesFromScad } from '../components/scadParser'
import { BufferGeometry } from 'three'

export default function PartViewer({ code }: { code: string }) {
  const shapes = useMemo(() => geometriesFromScad(code), [code])

  return (
    <div className="w-full h-[500px] bg-black rounded">
      <Canvas>
        <PerspectiveCamera makeDefault position={[150, 150, 150]} />
        <ambientLight intensity={0.5} />
        <pointLight position={[50, 50, 50]} />
        <OrbitControls />

        {shapes.map((geometry: BufferGeometry, idx: number) => (
          <mesh key={idx} geometry={geometry}>
            <meshStandardMaterial color="orange" />
          </mesh>
        ))}
      </Canvas>
    </div>
  )
}

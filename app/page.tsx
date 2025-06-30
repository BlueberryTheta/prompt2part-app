'use client'

import Link from 'next/link'

export default function Home() {
  return (
    <main style={{ padding: '2rem' }}>
      <h1>Welcome to Prompt2Part</h1>
      <p>
        <Link href="/login">Click here to log in</Link>
      </p>
    </main>
  )
}

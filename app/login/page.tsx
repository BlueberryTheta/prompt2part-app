'use client'

import React, { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLogin, setIsLogin] = useState(true)
  const [message, setMessage] = useState('')

  const handleAuth = async () => {
    setMessage('')
    console.log('🔁 handleAuth triggered')

    try {
      if (isLogin) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) {
          console.error('❌ Login error:', error)
          setMessage(`Error: ${error.message}`)
        } else {
          console.log('✅ Logged in:', data)
          setMessage('Successfully logged in!')
          window.location.href = '/dashboard' // Optional: redirect on login
        }
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: 'https://prompt2part.vercel.app/auth/callback',
          },
        })

        if (error) {
          console.error('❌ Sign up error:', error)
          setMessage(`Error: ${error.message}`)
        } else {
          console.log('✅ Sign up initiated:', data)
          setMessage('Success! Please check your email to verify your account.')
        }
      }
    } catch (err: any) {
      console.error('⚠️ Unexpected error:', err)
      setMessage(`Unexpected error: ${err.message || err}`)
    }
  }

  return (
    <div className="p-8 max-w-md mx-auto">
      <h1 className="text-xl font-bold mb-4">{isLogin ? 'Login' : 'Sign Up'}</h1>

      <input
        type="email"
        placeholder="Email"
        className="border p-2 w-full mb-2"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <input
        type="password"
        placeholder="Password"
        className="border p-2 w-full mb-2"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <button
        onClick={handleAuth}
        className="bg-blue-600 text-white px-4 py-2 w-full rounded mb-2"
      >
        {isLogin ? 'Login' : 'Sign Up'}
      </button>

      <button
        onClick={() => setIsLogin(!isLogin)}
        className="text-blue-500 underline text-sm"
      >
        {isLogin ? 'Switch to Sign Up' : 'Switch to Login'}
      </button>

      {message && <p className="mt-2 text-sm">{message}</p>}
    </div>
  )
}

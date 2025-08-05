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
    try {
      if (isLogin) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) {
          setMessage(`❌ ${error.message}`)
        } else {
          setMessage('✅ Successfully logged in!')
          window.location.href = '/dashboard'
        }
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: 'https://prompt2part.vercel.app/auth/callback' },
        })
        if (error) {
          setMessage(`❌ ${error.message}`)
        } else {
          setMessage('✅ Success! Check your email to verify your account.')
        }
      }
    } catch (err: any) {
      setMessage(`⚠️ Unexpected error: ${err.message || err}`)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-100 via-white to-blue-200 px-4">
      <div className="bg-white shadow-xl rounded-xl p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">
          {isLogin ? 'Welcome Back 👋' : 'Create an Account'}
        </h1>

        <input
          type="email"
          placeholder="Email"
          className="border border-gray-300 p-3 w-full mb-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          type="password"
          placeholder="Password"
          className="border border-gray-300 p-3 w-full mb-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          onClick={handleAuth}
          className="bg-blue-600 hover:bg-blue-700 transition text-white w-full py-3 rounded font-medium mb-4"
        >
          {isLogin ? 'Login' : 'Sign Up'}
        </button>

        <p className="text-center text-sm">
          {isLogin ? 'New to Prompt2Part?' : 'Already have an account?'}{' '}
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="text-blue-600 underline font-medium"
          >
            {isLogin ? 'Sign Up' : 'Login'}
          </button>
        </p>

        {message && (
          <div
            className={`mt-4 text-sm text-center p-2 rounded ${
              message.startsWith('✅')
                ? 'bg-green-100 text-green-700'
                : 'bg-red-100 text-red-700'
            }`}
          >
            {message}
          </div>
        )}
      </div>
    </div>
  )
}

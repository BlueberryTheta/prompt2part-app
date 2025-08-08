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

  const handleForgotPassword = async () => {
    if (!email) {
      setMessage('❌ Please enter your email to reset your password.')
      return
    }

    console.log('Sending reset with redirectTo:', 'https://prompt2part-app.vercel.app/update-password')

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://prompt2part-app.vercel.app/update-password',
    })
    if (error) {
      setMessage(`❌ ${error.message}`)
    } else {
      setMessage('✅ Password reset link sent! Check your email.')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="bg-white shadow-xl rounded-xl p-8 w-full max-w-md border border-gray-200">
        <h1 className="text-3xl font-extrabold text-gray-900 text-center mb-6">
          {isLogin ? 'Welcome Back 👋' : 'Create an Account'}
        </h1>

        <label className="block text-sm font-medium text-gray-800 mb-1">Email</label>
        <input
          type="email"
          placeholder="you@example.com"
          className="border border-gray-400 p-3 w-full mb-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-600 text-gray-900 placeholder-gray-500"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />

        <label className="block text-sm font-medium text-gray-800 mb-1">Password</label>
        <input
          type="password"
          placeholder="••••••••"
          className="border border-gray-400 p-3 w-full mb-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-600 text-gray-900 placeholder-gray-500"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={isLogin ? 'current-password' : 'new-password'}
        />

        {/* Row with Forgot Password (only in Login mode) */}
        {isLogin && (
          <div className="flex items-center justify-end mb-4">
            <button
              type="button"
              onClick={handleForgotPassword}
              className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline"
            >
              Forgot password?
            </button>
          </div>
        )}

        <button
          onClick={handleAuth}
          className="bg-blue-700 hover:bg-blue-800 transition text-white w-full py-3 rounded font-semibold mb-4"
        >
          {isLogin ? 'Login' : 'Sign Up'}
        </button>

        <p className="text-center text-sm text-gray-800">
          {isLogin ? 'New to Prompt2Part?' : 'Already have an account?'}{' '}
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="text-blue-700 underline font-medium hover:text-blue-900"
            type="button"
          >
            {isLogin ? 'Sign Up' : 'Login'}
          </button>
        </p>

        {message && (
          <div
            className={`mt-4 text-sm text-center p-3 rounded ${
              message.startsWith('✅')
                ? 'bg-green-100 text-green-800 border border-green-300'
                : 'bg-red-100 text-red-800 border border-red-300'
            }`}
          >
            {message}
          </div>
        )}
      </div>
    </div>
  )
}

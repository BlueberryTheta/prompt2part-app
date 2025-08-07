'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function UpdatePassword() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState<string>('')

  useEffect(() => {
    // Ensure we have a session created by the recovery link
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setMessage('❌ This reset link is invalid or expired. Please request a new one.')
      }
      setReady(true)
    }
    init()
  }, [])

  const handleUpdate = async () => {
    setMessage('')
    if (!newPassword || !confirmPassword) {
      setMessage('❌ Please fill out both fields.')
      return
    }
    if (newPassword !== confirmPassword) {
      setMessage('❌ Passwords do not match.')
      return
    }
    if (newPassword.length < 8) {
      setMessage('❌ Password must be at least 8 characters.')
      return
    }

    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) {
      setMessage(`❌ ${error.message}`)
      return
    }

    setMessage('✅ Password updated! Redirecting to login…')
    setTimeout(() => router.push('/login'), 1500)
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
        <div className="bg-white shadow-xl rounded-xl p-8 w-full max-w-md border border-gray-200">
          <p className="text-gray-800">Checking your reset link…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="bg-white shadow-xl rounded-xl p-8 w-full max-w-md border border-gray-200">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Reset your password</h1>

        <label className="block text-sm font-medium text-gray-800 mb-1">New password</label>
        <input
          type="password"
          className="border border-gray-400 p-3 w-full mb-3 rounded focus:outline-none focus:ring-2 focus:ring-blue-600 text-gray-900"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="••••••••"
        />

        <label className="block text-sm font-medium text-gray-800 mb-1">Confirm new password</label>
        <input
          type="password"
          className="border border-gray-400 p-3 w-full mb-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-600 text-gray-900"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="••••••••"
        />

        <button
          onClick={handleUpdate}
          className="bg-blue-700 hover:bg-blue-800 transition text-white w-full py-3 rounded font-semibold"
        >
          Update Password
        </button>

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

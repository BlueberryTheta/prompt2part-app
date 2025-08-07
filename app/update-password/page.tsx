'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function UpdatePassword() {
  const [newPassword, setNewPassword] = useState('')
  const [message, setMessage] = useState('')
  const router = useRouter()

  const handlePasswordUpdate = async () => {
    const { data, error } = await supabase.auth.updateUser({
      password: newPassword,
    })

    if (error) {
      setMessage(`❌ ${error.message}`)
    } else {
      setMessage('✅ Password updated! Redirecting to login...')
      setTimeout(() => router.push('/login'), 2000)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
      <div className="bg-white p-6 rounded shadow-lg w-full max-w-md">
        <h1 className="text-xl font-bold mb-4">🔒 Set New Password</h1>

        <input
          type="password"
          placeholder="New password"
          className="border border-gray-400 p-3 w-full mb-4 rounded"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />

        <button
          onClick={handlePasswordUpdate}
          className="bg-blue-700 hover:bg-blue-800 text-white w-full py-2 rounded"
        >
          Update Password
        </button>

        {message && (
          <p className="mt-3 text-sm text-center">
            {message}
          </p>
        )}
      </div>
    </div>
  )
}

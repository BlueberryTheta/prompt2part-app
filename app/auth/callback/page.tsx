'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function AuthCallback() {
  const router = useRouter()

  useEffect(() => {
    const handleAuthRedirect = async () => {
      const { data, error } = await supabase.auth.getSession()

      if (error) {
        console.error('Error retrieving session:', error)
      } else if (data.session) {
        router.push('/dashboard') // ✅ redirect to dashboard on success
      } else {
        router.push('/login') // fallback
      }
    }

    handleAuthRedirect()
  }, [router])

  return <p>Logging you in...</p>
}

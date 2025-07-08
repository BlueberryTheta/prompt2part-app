'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function AuthCallback() {
  const router = useRouter()

  useEffect(() => {
    const handleAuthRedirect = async () => {
      const { data, error } = await supabase.auth.getSessionFromUrl()

      if (error) {
        console.error('❌ Error retrieving session from URL:', error)
        router.push('/login')
      } else if (data?.session) {
        console.log('✅ Session established:', data.session)
        router.push('/dashboard')
      }
    }

    handleAuthRedirect()
  }, [router])

  return <p className="text-center p-4">🔄 Finishing login…</p>
}

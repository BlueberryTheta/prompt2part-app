'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function AuthCallback() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const exchangeCode = async () => {
      const code = searchParams.get('code')
      if (!code) {
        console.error('No auth code found in URL')
        return router.push('/login')
      }

      const { data, error } = await supabase.auth.exchangeCodeForSession(code)

      if (error) {
        console.error('❌ Error exchanging code for session:', error.message)
        router.push('/login')
      } else if (data?.session) {
        console.log('✅ Session established:', data.session)
        router.push('/dashboard')
      }
    }

    exchangeCode()
  }, [searchParams, router])

  return <p className="text-center p-4">🔄 Finishing login…</p>
}

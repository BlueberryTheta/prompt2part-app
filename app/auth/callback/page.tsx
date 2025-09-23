'use client'
export const dynamic = 'force-dynamic'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

function CallbackHandler() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const exchangeCode = async () => {
      const code = searchParams.get('code')
      if (!code) {
        console.error('No auth code found in URL')
        router.push('/login')
        return
      }

      const { data, error } = await supabase.auth.exchangeCodeForSession(code)

      if (error) {
        console.error('Error exchanging code:', error.message)
        router.push('/login')
        return
      }

      console.log('Session established:', data.session)
      router.push('/dashboard')
    }

    exchangeCode()
  }, [searchParams, router])

  return <p className='text-center p-4'>Finishing login...</p>
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<p className='text-center p-4'>Loading...</p>}>
      <CallbackHandler />
    </Suspense>
  )
}

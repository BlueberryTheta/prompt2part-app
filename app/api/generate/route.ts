import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies as getCookies } from 'next/headers'

export async function POST(req: NextRequest) {
  const { prompt, history = [] } = await req.json()

  const messages = [
    {
      role: 'system',
      content: `You are a helpful assistant who generates OpenSCAD code for custom parts. 
If the user hasn't given enough information (e.g. dimensions, hole placement, etc.), 
ask them exactly what is needed. Only provide code once the design is clear.`,
    },
    ...history,
    {
      role: 'user',
      content: prompt,
    },
  ]

  try {
    // 1. Get cookies (SYNC, not async)
    const cookieStore = getCookies()

    // 2. Create Supabase client
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get: async (name: string) => (await cookieStore).get(name)?.value,
          set: () => {}, // Not needed for read-only API calls
          remove: () => {} // Not needed for read-only API calls
        },
      }
    )

    // 3. Contact OpenAI
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        temperature: 0.3,
        max_tokens: 1000,
      }),
    })

    const data = await openaiRes.json()
    const reply = data.choices?.[0]?.message?.content || ''
    const isCode = reply.includes('module') || reply.includes(';') || reply.includes('//')

    // 4. Save response to Supabase if logged in
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession()

    if (session && isCode) {
      const { error: dbError } = await supabase.from('projects').insert({
        user_id: session.user.id,
        prompt,
        response: reply,
        title: `Untitled Project - ${new Date().toLocaleString()}`
      })

      if (dbError) {
        console.error('❌ Error saving project:', dbError)
      }
    }

    // 5. Return result
    return NextResponse.json({
      code: isCode ? reply : null,
      question: isCode ? null : reply,
      role: 'assistant',
      content: reply,
    })
  } catch (err) {
    console.error('❌ Failed to contact OpenAI or Supabase:', err)
    return NextResponse.json({ error: 'Failed to generate response' }, { status: 500 })
  }
}

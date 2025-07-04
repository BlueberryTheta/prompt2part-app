'use client'

import React, { useState } from 'react'

export default function DashboardPage() {
  const [prompt, setPrompt] = useState('')
  const [history, setHistory] = useState<{ role: string; content: string }[]>([])
  const [response, setResponse] = useState('')
  const [codeGenerated, setCodeGenerated] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    if (!prompt) return
    setLoading(true)

    const newHistory = [...history, { role: 'user', content: prompt }]

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, history: newHistory }),
      })

      const data = await res.json()
      console.log('Response from API:', data)

      setHistory([...newHistory, { role: 'assistant', content: data.content ?? '' }])
      setResponse(data?.code ?? data?.question ?? '')
      setCodeGenerated(!!data?.code)
      setPrompt('')
    } catch (error) {
      console.error('Error:', error)
      setResponse('❌ Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-4">
      <h1 className="text-xl font-bold">Generate a Custom 3D Part</h1>

      <div className="space-y-2">
        {history.map((msg, i) => (
          <div key={i} className={`p-2 ${msg.role === 'user' ? 'bg-black-100' : 'bg-black-100'} rounded`}>
            <strong>{msg.role === 'user' ? 'You' : 'AI'}:</strong> {msg.content}
          </div>
        ))}
      </div>

      <textarea
        className="border p-2 w-full"
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe your part, or answer the AI's question..."
      />

      <button
        onClick={handleSubmit}
        disabled={loading}
        className="bg-white-600 text-white px-4 py-2 rounded"
      >
        {loading ? 'Generating...' : 'Send'}
      </button>

      {codeGenerated && (
        <div className="mt-4 p-4 bg-green-100 rounded">
          <h2 className="font-bold mb-2">✅ Your OpenSCAD Code:</h2>
          <pre className="bg-white p-2 overflow-auto max-h-96">{response}</pre>
        </div>
      )}
    </div>
  )
}

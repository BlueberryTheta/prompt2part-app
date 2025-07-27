
'use client'

import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import PartViewer from '../components/PartViewer'

export default function DashboardPage() {
  const [userPrompt, setUserPrompt] = useState('')
  const [history, setHistory] = useState<{ role: string; content: string }[]>([])
  const [response, setResponse] = useState('')
  const [codeGenerated, setCodeGenerated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [projects, setProjects] = useState<any[]>([])
  const [showSaveSuccess, setShowSaveSuccess] = useState(false)
  const [stlBlobUrl, setStlBlobUrl] = useState<string | null>(null)
  const [resolution, setResolution] = useState(100)
  const [darkMode, setDarkMode] = useState(false)

  const router = useRouter()

  useEffect(() => {
    const fetchData = async () => {
      const { data: { session }, error } = await supabase.auth.getSession()
      if (!session || error) {
        router.push('/login')
        return
      }

      setUserEmail(session.user.email ?? null)

      const { data, error: projectError } = await supabase
        .from('projects')
        .select('id, title, prompt, response, history, created_at')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })

      if (!projectError) {
        setProjects(data ?? [])
      }
    }

    fetchData()
  }, [router])

  const extractOpenSCAD = (input: string): string => {
    const match = input.match(/```(?:scad|openscad)?\n([\s\S]*?)```/)
    if (match) return match[1].trim()

    const lines = input.split('\n')
    const codeLines = lines.filter(line =>
      line.trim().startsWith('//') ||
      line.includes('=') ||
      line.includes('cube') ||
      line.includes('cylinder') ||
      line.includes('translate') ||
      line.includes('difference') ||
      line.includes('{') ||
      line.includes('}')
    )
    return codeLines.join('\n').trim()
  }

  const handleSubmit = async () => {
    if (!userPrompt) return
    setLoading(true)

    const newHistory = [...history, { role: 'user', content: userPrompt }]

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userPrompt, history: newHistory }),
      })

      const data = await res.json()
      const code = extractOpenSCAD(data?.code ?? data?.question ?? '')

      setHistory([...newHistory, { role: 'assistant', content: '✅ Model generated successfully.' }])
      setResponse(code)
      setCodeGenerated(!!code)
      setUserPrompt('')

      if (!code) throw new Error('No OpenSCAD code returned from API.')

      const formData = new FormData()
      formData.append('code', `$fn = ${resolution};\n` + code)

      const backendRes = await fetch('https://scad-backend-production.up.railway.app/render', {
        method: 'POST',
        body: formData,
      })

      const contentType = backendRes.headers.get('Content-Type') || ''
      const debugText = await backendRes.clone().text()
      console.log('Backend response body:', debugText)

      if (!backendRes.ok) throw new Error(`Failed to render STL: ${backendRes.statusText}`)

      const blob = await backendRes.blob()
      if (blob.size === 0) throw new Error('The STL file is empty.')

      const url = URL.createObjectURL(blob)
      setStlBlobUrl(url)
    } catch (error) {
      console.error('Error:', error)
      setResponse('❌ Something went wrong. Please try again.')
      setStlBlobUrl(null)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveProject = async () => {
    if (!userPrompt && !response) return
    const title = window.prompt('Enter a title for your project:')
    if (!title) return

    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return

    const { error: insertError } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        title,
        prompt: userPrompt,
        response,
        history,
      })

    if (!insertError) {
      setShowSaveSuccess(true)
      setTimeout(() => setShowSaveSuccess(false), 3000)
    }
  }

  const handleDownload = () => {
    if (!stlBlobUrl) return
    const link = document.createElement('a')
    link.href = stlBlobUrl
    link.download = 'model.stl'
    link.click()
  }

  const handleLoadProject = (projectId: string) => {
    const project = projects.find(p => p.id === projectId)
    if (!project) return
    setUserPrompt(project.prompt)
    setResponse(project.response)
    setCodeGenerated(true)
    setHistory(project.history ?? [])
  }

  const handleRename = async (projectId: string) => {
    const newTitle = window.prompt('Enter a new name:')
    if (!newTitle) return

    await supabase
      .from('projects')
      .update({ title: newTitle })
      .eq('id', projectId)

    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, title: newTitle } : p))
  }

  const handleDelete = async (projectId: string) => {
    const confirmDelete = confirm('Delete this project?')
    if (!confirmDelete) return

    await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)

    setProjects(prev => prev.filter(p => p.id !== projectId))
  }

  return (
    <div className={`flex flex-col lg:flex-row min-h-screen ${darkMode ? 'bg-gray-900 text-white' : 'bg-white text-black'}`}>
      <div className="flex-1 p-6 max-w-4xl space-y-6">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-xl font-bold">🛠️ Prompt2Part Dashboard</h1>
          <div className="flex items-center space-x-2">
            <span className="text-sm">{userEmail}</span>
            <button onClick={() => supabase.auth.signOut().then(() => router.push('/login'))} className="text-blue-400 underline text-sm">Logout</button>
            <button onClick={() => setDarkMode(!darkMode)} className="text-xs px-2 py-1 border rounded">{darkMode ? '☀️ Light' : '🌙 Dark'}</button>
          </div>
        </div>

        {showSaveSuccess && (
          <div className="p-2 text-green-800 bg-green-100 border border-green-300 rounded dark:bg-green-900 dark:text-green-200">
            ✅ Project saved successfully!
          </div>
        )}

        <div>
          <label htmlFor="resolution" className="text-sm font-medium">Curve Resolution ($fn):</label>
          <select
            id="resolution"
            value={resolution}
            onChange={e => setResolution(Number(e.target.value))}
            className="ml-2 border px-2 py-1 rounded text-black"
          >
            <option value={10}>10 (Low)</option>
            <option value={50}>50 (Medium)</option>
            <option value={100}>100 (High)</option>
            <option value={200}>200 (Very High)</option>
          </select>
        </div>

        <div className="h-64 overflow-y-auto border p-2 rounded bg-white dark:bg-gray-800 text-black dark:text-white">
          {history.map((msg, i) => (
            <div key={i} className={`p-2 rounded mb-1 ${msg.role === 'user' ? 'bg-gray-200' : 'bg-gray-100'} dark:bg-gray-700`}>
              <strong>{msg.role === 'user' ? 'You' : 'AI'}:</strong> {msg.content}
            </div>
          ))}
        </div>

        <textarea
          className="border p-2 w-full rounded text-black"
          rows={3}
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          placeholder="Describe your part..."
        />

        <div className="flex gap-2">
          <button onClick={handleSubmit} disabled={loading} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
            {loading ? 'Generating...' : 'Send'}
          </button>
          <button onClick={handleSaveProject} disabled={!userPrompt && history.length === 0} className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded disabled:opacity-50">
            Save Project
          </button>
        </div>
      </div>

      {codeGenerated && stlBlobUrl && (
        <div className="lg:w-[40%] w-full p-4 bg-gray-100 dark:bg-gray-800 sticky top-0">
          <h2 className="font-bold text-lg mb-2">🧱 3D Preview:</h2>
          <PartViewer stlUrl={stlBlobUrl} />
          <button onClick={handleDownload} className="mt-4 bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-900">⬇️ Download STL</button>
        </div>
      )}
    </div>
  )
}

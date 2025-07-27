
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
  <div className={`flex flex-col lg:flex-row gap-4 min-h-screen ${darkMode ? 'bg-gray-900 text-white' : 'bg-white text-black'}`}>
    {/* Left: Chat and Controls */}
    <div className="flex-1 p-4 space-y-4 max-w-full">
      {/* Everything from your dashboard content should remain inside here:
          - User info
          - Projects list
          - History
          - Text input
          - Submit/save buttons
      */}
      {/* PLACEHOLDER: Replace with your existing content */}
    </div>

    {/* Right: 3D Viewer (desktop side panel, stacked on mobile) */}
    {codeGenerated && stlBlobUrl && (
      <div className="lg:w-[40%] w-full p-4 bg-gray-100 dark:bg-gray-800 rounded">
        <h2 className="font-bold text-lg mb-2">🧱 3D Preview:</h2>
        <PartViewer stlUrl={stlBlobUrl} />
        <button
          onClick={handleDownload}
          className="mt-4 bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-900"
        >
          ⬇️ Download STL
        </button>
      </div>
    )}
  </div>
)
}

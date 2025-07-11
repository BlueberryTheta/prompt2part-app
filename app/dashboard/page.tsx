'use client'

import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function DashboardPage() {
  const [userPrompt, setUserPrompt] = useState('')
  const [history, setHistory] = useState<{ role: string; content: string }[]>([])
  const [response, setResponse] = useState('')
  const [codeGenerated, setCodeGenerated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [projects, setProjects] = useState<{ id: string; title: string; prompt: string; response: string; history: any }[]>([])
  const [showSaveSuccess, setShowSaveSuccess] = useState(false)
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

      if (projectError) {
        console.error('Failed to load projects:', projectError)
      } else {
        setProjects(data ?? [])
      }
    }

    fetchData()
  }, [router])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleRename = async (projectId: string) => {
    const newTitle = window.prompt('Enter new project name:')
    if (!newTitle) return

    const { error } = await supabase
      .from('projects')
      .update({ title: newTitle })
      .eq('id', projectId)

    if (error) {
      console.error('Rename failed:', error)
      return
    }

    setProjects(prev =>
      prev.map(p => (p.id === projectId ? { ...p, title: newTitle } : p))
    )
  }

  const handleDelete = async (projectId: string) => {
    if (!confirm('Are you sure you want to delete this project?')) return

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)

    if (error) {
      console.error('Delete failed:', error)
      return
    }

    setProjects(prev => prev.filter(p => p.id !== projectId))
  }

  const handleLoadProject = (projectId: string) => {
    const project = projects.find(p => p.id === projectId)
    if (project) {
      setUserPrompt(project.prompt)
      setResponse(project.response)
      setCodeGenerated(!!project.response)
      setHistory(project.history ?? [])
    }
  }

  const handleSaveProject = async () => {
    const title = window.prompt('Enter a title for your project:')
    if (!title) return

    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      console.error('No user found:', userError)
      return
    }

    const { error: insertError } = await supabase.from('projects').insert({
      user_id: user.id,
      title,
      prompt: userPrompt,
      response,
      history,
    })

    if (insertError) {
      console.error('Save failed:', insertError)
      return
    }

    const { data: freshProjects, error: refreshError } = await supabase
      .from('projects')
      .select('id, title, prompt, response, history, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (refreshError) {
      console.error('Failed to refresh project list:', refreshError)
    } else {
      setProjects(freshProjects ?? [])
      setShowSaveSuccess(true)
      setTimeout(() => setShowSaveSuccess(false), 3000)
    }
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
      setHistory([...newHistory, { role: 'assistant', content: data.content ?? '' }])
      setResponse(data?.code ?? data?.question ?? '')
      setCodeGenerated(!!data?.code)
      setUserPrompt('')
    } catch (error) {
      console.error('Error:', error)
      setResponse('❌ Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-xl font-bold">Generate a Custom 3D Part</h1>
        {userEmail && (
          <div className="text-sm text-gray-600">
            Signed in as: {userEmail}{' '}
            <button onClick={handleLogout} className="ml-2 text-blue-500 underline">Logout</button>
          </div>
        )}
      </div>

      {showSaveSuccess && (
        <div className="p-2 text-green-800 bg-green-100 border border-green-300 rounded">
          ✅ Project saved successfully!
        </div>
      )}

      {/* 📁 Project List */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">📁 Saved Projects</h2>
        {projects.length === 0 ? (
          <p className="text-sm text-gray-500">No saved projects yet.</p>
        ) : (
          projects.map(project => (
            <div
              key={project.id}
              className="flex justify-between items-center border border-gray-200 p-2 rounded"
            >
              <span className="truncate text-gray-900">{project.title}</span>
              <div className="space-x-2">
                <button onClick={() => handleLoadProject(project.id)} className="text-sm text-green-600 underline">
                  Load
                </button>
                <button onClick={() => handleRename(project.id)} className="text-sm text-blue-600 underline">
                  Rename
                </button>
                <button onClick={() => handleDelete(project.id)} className="text-sm text-red-600 underline">
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 🧠 Conversation */}
      <div className="space-y-2">
        {history.map((msg, i) => (
          <div key={i} className={`p-2 rounded ${msg.role === 'user' ? 'bg-gray-200' : 'bg-gray-100'}`}>
            <strong className="text-gray-800">{msg.role === 'user' ? 'You' : 'AI'}:</strong>{' '}
            <span className="text-gray-800">{msg.content}</span>
          </div>
        ))}
      </div>

      <textarea
        className="border p-2 w-full text-black bg-white"
        rows={3}
        value={userPrompt}
        onChange={(e) => setUserPrompt(e.target.value)}
        placeholder="Describe your part, or answer the AI's question..."
      />

      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
        >
          {loading ? 'Generating...' : 'Send'}
        </button>
        <button
          onClick={handleSaveProject}
          disabled={!userPrompt && history.length === 0}
          className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          Save Project
        </button>
      </div>

      {response && (
        <div className="mt-4 p-4 bg-green-100 rounded">
          <h2 className="font-bold mb-2">✅ Your OpenSCAD Code:</h2>
          <pre className="bg-white p-2 overflow-auto max-h-96 text-black">{response}</pre>
        </div>
      )}
    </div>
  )
}

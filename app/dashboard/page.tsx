'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import PartViewer from '../components/PartViewer'
import { Spec } from '../api/generate/route'

type ChatMsg = { role: 'user' | 'assistant'; content: string }

// NEW: Feature type for PartViewer list/selection
type Feature = {
  id: string
  label: string
  groupId?: number
  position?: [number, number, number]
}

export default function DashboardPage() {
  const [userPrompt, setUserPrompt] = useState('')
  const [history, setHistory] = useState<ChatMsg[]>([])
  const [response, setResponse] = useState('')                    // OpenSCAD code (when present)
  const [codeGenerated, setCodeGenerated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [projects, setProjects] = useState<any[]>([])
  const [showSaveSuccess, setShowSaveSuccess] = useState(false)
  const [stlBlobUrl, setStlBlobUrl] = useState<string | null>(null)
  const [resolution, setResolution] = useState(100)
  const [darkMode, setDarkMode] = useState(false)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)

  // NEW: features + selection for PartViewer
  const [features, setFeatures] = useState<Feature[]>([])
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null)

  const chatContainerRef = useRef<HTMLDivElement | null>(null)
  const router = useRouter()

  // === Undo / Redo ===
  type ModelSnapshot = {
    history: ChatMsg[]
    response: string
    stlBlobUrl: string | null
    userPrompt: string
    codeGenerated: boolean
    currentProjectId: string | null
    resolution: number
    features: Feature[]            // NEW: include features in snapshots
  }
  const [pastStates, setPastStates] = useState<ModelSnapshot[]>([])
  const [futureStates, setFutureStates] = useState<ModelSnapshot[]>([])
  function takeSnapshot() {
    setPastStates(prev => [
      ...prev,
      {
        history,
        response,
        stlBlobUrl,
        userPrompt,
        codeGenerated,
        currentProjectId,
        resolution,
        features,                  // NEW
      },
    ])
    setFutureStates([])
  }

  // === Config ===
  const RENDER_URL =
    process.env.NEXT_PUBLIC_RENDER_URL || 'http://localhost:8000/render'

  // === Session + projects ===
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

      if (!projectError) setProjects(data ?? [])
    }
    fetchData()
  }, [router])

  // === Prompt helper ===
  function buildGuidedPrompt(currentCode: string, userInstruction: string, res: number) {
    return [
      'You are an expert OpenSCAD assistant. Build a new model or modify the existing model as requested.',
      '',
      '### RULES',
      '- Preserve existing features unless explicitly asked to remove them.',
      '- Do not add any items to the model unless explicitly asked to.',
      '- If the model has holes, DO NOT remove them unless asked.',
      '- When adding fillets/rounds, subtract holes AFTER filleting so they remain.',
      '- Keep units consistent with the existing code.',
      '- Return a short human message AND a single fenced OpenSCAD code block.',
      '',
      '### CURRENT_OPENSCAD',
      '```openscad',
      currentCode || '// (no prior code) put your full OpenSCAD model here',
      '```',
      '',
      '### USER_REQUEST',
      userInstruction,
      '',
      '### OUTPUT FORMAT',
      'Message: one short paragraph describing the change.',
      '',
      'Code:',
      '```openscad',
      '// complete, compilable OpenSCAD code here',
      '```',
    ].join('\n')
  }

  function parseAIResponse(raw: string): { message: string; code: string } {
    const codeMatch = raw.match(/```(?:scad|openscad)?\n([\s\S]*?)```/i)
    const code = codeMatch ? codeMatch[1].trim() : ''
    let message = raw
    if (codeMatch) message = raw.replace(codeMatch[0], '').trim()
    if (!message) message = 'Model updated based on your request.'
    return { message, code }
  }

  async function renderStlFromCodeStrict(code: string, res: number): Promise<string> {
    const formData = new FormData()
    // prepend $fn for curve resolution
    formData.append('code', `$fn = ${res};\n` + code)

    const backendRes = await fetch(RENDER_URL, {
      method: 'POST',
      body: formData,
    })

    const cloneText = await backendRes.clone().text()
    if (!backendRes.ok) {
      throw new Error(`Backend render error ${backendRes.status}: ${cloneText}`)
    }

    const ct = backendRes.headers.get('Content-Type') || ''
    if (ct.includes('application/json')) {
      throw new Error(`Backend returned JSON instead of STL: ${cloneText}`)
    }

    const blob = await backendRes.blob()
    if (!blob || blob.size === 0) throw new Error('Empty STL blob received.')

    return URL.createObjectURL(blob)
  }

  // Auto-scroll chat
  useEffect(() => {
    const el = chatContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [history])

  // Undo/Redo keybindings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey

      if (ctrlOrCmd && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      }
      if (ctrlOrCmd && e.key === 'z' && e.shiftKey) {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastStates, futureStates])

  const handleUndo = async () => {
    if (pastStates.length === 0) return
    setFutureStates(prev => [
      ...prev,
      { history, response, stlBlobUrl, userPrompt, codeGenerated, currentProjectId, resolution, features },
    ])
    const prevStack = [...pastStates]
    const snapshot = prevStack.pop()!
    setPastStates(prevStack)

    setHistory(snapshot.history)
    setResponse(snapshot.response)
    setUserPrompt(snapshot.userPrompt)
    setCodeGenerated(snapshot.codeGenerated)
    setCurrentProjectId(snapshot.currentProjectId)
    setResolution(snapshot.resolution)
    setFeatures(snapshot.features) // NEW

    if (snapshot.response) {
      try {
        const url = await renderStlFromCodeStrict(snapshot.response, snapshot.resolution)
        setStlBlobUrl(url)
      } catch (e) {
        console.error('Undo render error:', e)
        setStlBlobUrl(null)
      }
    } else {
      setStlBlobUrl(null)
    }
  }

  const handleRedo = async () => {
    if (futureStates.length === 0) return
    setPastStates(prev => [
      ...prev,
      { history, response, stlBlobUrl, userPrompt, codeGenerated, currentProjectId, resolution, features },
    ])
    const nextStack = [...futureStates]
    const snapshot = nextStack.pop()!
    setFutureStates(nextStack)

    setHistory(snapshot.history)
    setResponse(snapshot.response)
    setUserPrompt(snapshot.userPrompt)
    setCodeGenerated(snapshot.codeGenerated)
    setCurrentProjectId(snapshot.currentProjectId)
    setResolution(snapshot.resolution)
    setFeatures(snapshot.features) // NEW

    if (snapshot.response) {
      try {
        const url = await renderStlFromCodeStrict(snapshot.response, snapshot.resolution)
        setStlBlobUrl(url)
      } catch (e) {
        console.error('Redo render error:', e)
        setStlBlobUrl(null)
      }
    } else {
      setStlBlobUrl(null)
    }
  }

  // === Submit ===
  // state:
  const [spec, setSpec] = useState<Spec>({ units: 'mm' })
  const [assumptions, setAssumptions] = useState<string[]>([])

  // handleSubmit:
  const handleSubmit = async () => {
    if (!userPrompt) return
    setLoading(true)

    const baseHistory: ChatMsg[] = [...history, { role: 'user', content: userPrompt }]

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userPrompt,
          history: baseHistory, // chat as-is
          spec,                  // 🚀 keep spec in the loop
        }),
      })
      const data = await res.json()

      // Always show assistant_text
      const assistantText = data?.assistant_text || 'Okay.'
      setHistory([...baseHistory, { role: 'assistant', content: assistantText }])
      takeSnapshot();  // After updating history
      // Always update spec if provided
      if (data?.spec) setSpec(data.spec)
      setAssumptions(data?.assumptions || [])

      if (data?.type === 'code' && data?.code) {
        const code = data.code as string
        setResponse(code)
        setCodeGenerated(true)

        // Render STL
        try {
          const url = await renderStlFromCodeStrict(code, resolution)
          setStlBlobUrl(url)

          // NEW: append a simple feature entry to the list for this update (heuristic)
          setFeatures(prev => [
            ...prev,
            {
              id: `feat-${Date.now()}`,
              label: userPrompt.trim().slice(0, 80) || 'Update',
              // groupId/position can be filled when available from backend later
            }
          ])
        } catch (e: any) {
          console.error('Render error:', e)
        }
      }

      setUserPrompt('')
    } catch (err) {
      console.error('Client submit error:', err)
      setHistory([...baseHistory, { role: 'assistant', content: '❌ Something went wrong.' }])
      takeSnapshot();  // After updating history
    } finally {
      setLoading(false)
    }
  }

  // === Projects: Save new / Update / Load / Rename / Delete ===
  const refreshProjects = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase
      .from('projects')
      .select('id, title, prompt, response, history, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    setProjects(data ?? [])
  }

  const handleSaveProject = async () => {
    if (!userPrompt && !response) return
    const title = window.prompt('Enter a title for your project:')
    if (!title) return

    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return

    // return the inserted row so we can set currentProjectId
    const { data: inserted, error: insertError } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        title,
        prompt: userPrompt,
        response,
        history,
      })
      .select('*')
      .single()

    if (!insertError) {
      setCurrentProjectId(inserted?.id ?? null)
      await refreshProjects()
      setShowSaveSuccess(true)
      setTimeout(() => setShowSaveSuccess(false), 3000)
    }
  }

  const handleNewProject = () => {
    const proceed = confirm('⚠️ This will clear your current work. Make sure to save before starting a new project. Continue?')
    if (!proceed) return

    setHistory([])
    setUserPrompt('')
    setResponse('')
    setCodeGenerated(false)
    setStlBlobUrl(null)
    setCurrentProjectId(null)
    setPastStates([])
    setFutureStates([])
    setFeatures([])               // NEW: clear features
    setSelectedFeatureId(null)    // optional
  }

  const handleUpdateProject = async () => {
    if (!currentProjectId) return
    const { error } = await supabase
      .from('projects')
      .update({
        prompt: userPrompt,
        response,
        history,
      })
      .eq('id', currentProjectId)

    if (!error) {
      await refreshProjects()
      setShowSaveSuccess(true)
      setTimeout(() => setShowSaveSuccess(false), 3000)
    }
  }

  const handleLoadProject = async (projectId: string) => {
    const project = projects.find(p => p.id === projectId)
    if (!project) return

    takeSnapshot()

    setCurrentProjectId(projectId)
    setUserPrompt(project.prompt || '')
    setResponse(project.response || '')
    setCodeGenerated(!!project.response)
    setHistory(project.history ?? [])
    setFeatures([])               // NEW: reset features unless you load them from DB
    setSelectedFeatureId(null)    // optional

    if (project.response) {
      try {
        const url = await renderStlFromCodeStrict(project.response, resolution)
        setStlBlobUrl(url)
      } catch (e) {
        console.error('Error rendering saved project:', e)
        setStlBlobUrl(null)
      }
    } else {
      setStlBlobUrl(null)
    }
  }

  const handleRename = async (projectId: string) => {
    const newTitle = window.prompt('Enter a new name:')
    if (!newTitle) return
    await supabase.from('projects').update({ title: newTitle }).eq('id', projectId)
    setProjects(prev => prev.map(p => (p.id === projectId ? { ...p, title: newTitle } : p)))
  }

  const handleDelete = async (projectId: string) => {
    const confirmDelete = confirm('Delete this project?')
    if (!confirmDelete) return
    await supabase.from('projects').delete().eq('id', projectId)
    setProjects(prev => prev.filter(p => p.id !== projectId))
    if (currentProjectId === projectId) {
      setCurrentProjectId(null)
      setUserPrompt('')
      setResponse('')
      setHistory([])
      setCodeGenerated(false)
      setStlBlobUrl(null)
      setFeatures([])             // NEW: clear on delete of current project
      setSelectedFeatureId(null)  // optional
    }
  }

  const handleDownload = () => {
    if (!stlBlobUrl) return
    const link = document.createElement('a')
    link.href = stlBlobUrl
    link.download = 'model.stl'
    link.click()
  }

  // === UI ===
  return (
    <div
      className={`flex flex-col lg:flex-row gap-6 p-6 min-h-screen transition-colors duration-300 ${
        darkMode ? 'bg-gray-950 text-gray-100' : 'bg-gray-100 text-gray-900'
      }`}
    >
      {/* LEFT PANEL */}
      <div className="flex-1 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center pb-3 border-b border-gray-400 dark:border-gray-700">
          <h1 className="text-2xl font-bold">🛠️ Prompt2Part</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm opacity-80">{userEmail}</span>
            <button
              onClick={() => supabase.auth.signOut().then(() => router.push('/login'))}
              className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-sm font-medium shadow-sm transition"
            >
              Logout
            </button>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="px-2 py-1 rounded border border-gray-500 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700 text-xs font-medium transition"
            >
              {darkMode ? '☀️ Light' : '🌙 Dark'}
            </button>
          </div>
        </div>

        {/* Save Success Message */}
        {showSaveSuccess && (
          <div className="p-3 rounded bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border border-green-400 dark:border-green-700 shadow-sm">
            ✅ Project saved successfully!
          </div>
        )}

        {/* Resolution Selector */}
        <div className={`shadow-md rounded-lg p-4 border transition ${
          darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-300'
        }`}>
          <label htmlFor="resolution" className="text-sm font-medium block mb-2">
            Curve Resolution ($fn)
          </label>
          <select
            id="resolution"
            value={resolution}
            onChange={(e) => setResolution(Number(e.target.value))}
            className={`border px-3 py-2 rounded w-full transition ${
              darkMode
                ? 'bg-gray-700 text-white border-gray-600'
                : 'bg-white text-gray-900 border-gray-500'
            }`}
          >
            <option value={10}>10 (Low)</option>
            <option value={50}>50 (Medium)</option>
            <option value={100}>100 (High)</option>
            <option value={200}>200 (Very High)</option>
          </select>
        </div>

        {/* Saved Projects */}
        <div className={`shadow-md rounded-lg p-4 border transition ${
          darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-300'
        }`}>
          <h2 className="text-lg font-semibold mb-3">📁 Saved Projects</h2>
          {projects.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-300">No saved projects yet.</p>
          ) : (
            <div className="space-y-2">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className={`flex justify-between items-center p-3 rounded-lg border transition hover:shadow-md ${
                    darkMode
                      ? 'bg-gray-750 bg-gray-700 border-gray-600 hover:bg-gray-650 hover:bg-gray-600'
                      : 'bg-gray-50 border-gray-400 hover:bg-gray-200'
                  }`}
                >
                  <span className="truncate">{project.title}</span>
                  <div className="flex gap-3 text-sm font-medium">
                    <button
                      onClick={() => handleLoadProject(project.id)}
                      className="text-green-700 dark:text-green-300 hover:underline"
                    >
                      Load
                    </button>
                    <button
                      onClick={() => handleRename(project.id)}
                      className="text-blue-700 dark:text-blue-300 hover:underline"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => handleDelete(project.id)}
                      className="text-red-700 dark:text-red-300 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Chat (HIGH CONTRAST) */}
        <div className={`shadow-md rounded-lg p-4 border flex flex-col gap-3 transition ${
          darkMode
            ? 'bg-gray-900 border-gray-700'
            : 'bg-white border-gray-400'
        }`}>
          <div
            ref={chatContainerRef}
            className="max-h-64 overflow-y-auto space-y-2"
          >
            {history.map((msg, i) => {
              const isUser = msg.role === 'user'
              return (
                <div
                  key={i}
                  className={`p-3 rounded-lg text-sm border ${
                    isUser
                      ? // USER bubble: strong indigo in both modes
                        darkMode
                        ? 'bg-indigo-600 text-white border-indigo-400'
                        : 'bg-indigo-50 text-indigo-900 border-indigo-300'
                      : // AI bubble: strong neutral contrast in both modes
                        darkMode
                        ? 'bg-gray-800 text-gray-100 border-gray-600'
                        : 'bg-gray-50 text-gray-900 border-gray-300'
                  }`}
                >
                  <strong className={`${isUser ? '' : ''}`}>
                    {isUser ? 'You' : 'AI'}:
                  </strong>{' '}
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                </div>
              )
            })}
          </div>

          <textarea
            className={`border px-3 py-2 w-full rounded transition placeholder:opacity-80 ${
              darkMode
                ? 'bg-gray-800 text-white border-gray-600 placeholder:text-gray-300'
                : 'bg-white text-gray-900 border-gray-500 placeholder:text-gray-600'
            }`}
            rows={3}
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            placeholder="Describe your part or answer the AI's question..."
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              className="bg-blue-700 hover:bg-blue-800 text-white px-4 py-2 rounded font-medium transition"
            >
              {loading ? 'Generating...' : 'Send'}
            </button>
            <button
              onClick={handleUndo}
              disabled={pastStates.length === 0}
              className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded disabled:opacity-50 font-medium transition"
            >
              Undo
            </button>
            <button
              onClick={handleRedo}
              disabled={futureStates.length === 0}
              className="bg-indigo-700 hover:bg-indigo-800 text-white px-4 py-2 rounded disabled:opacity-50 font-medium transition"
            >
              Redo
            </button>
            <button
              onClick={handleNewProject}
              className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded font-medium transition"
            >
              🆕 New Project
            </button>
            {currentProjectId ? (
              <button
                onClick={handleUpdateProject}
                className="bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded font-medium transition"
              >
                Save Changes
              </button>
            ) : (
              <button
                onClick={handleSaveProject}
                disabled={!userPrompt && history.length === 0}
                className="bg-green-700 hover:bg-green-800 text-white px-4 py-2 rounded disabled:opacity-50 font-medium transition"
              >
                Save as New Project
              </button>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className={`lg:w-[40%] w-full p-4 shadow-md rounded-lg border space-y-4 transition ${
        darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-400'
      }`}>
        <h2 className="font-bold text-lg">🧱 3D Preview</h2>
        {stlBlobUrl ? (
          <>
            <PartViewer
              key={stlBlobUrl}                 // ensure fresh mount on new STL
              stlUrl={stlBlobUrl}
              features={features}
              onFeatureSelect={(id) => setSelectedFeatureId(id)}
            />
            <button
              onClick={handleDownload}
              className="bg-gray-900 text-white px-4 py-2 rounded hover:bg-black transition font-medium"
            >
              ⬇️ Download STL
            </button>
          </>
        ) : (
          <div className="text-sm text-gray-700 dark:text-gray-300 italic">
            Nothing to show yet. Submit a prompt to generate a model.
          </div>
        )}
      </div>
    </div>
  )
}

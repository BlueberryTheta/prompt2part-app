
'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
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
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)

  const chatContainerRef = useRef<HTMLDivElement | null>(null)

  const router = useRouter()

  // 👇 Add this type (optional if you’re in JS, helpful in TS)
type ModelSnapshot = {
  history: { role: string; content: string }[];
  response: string;
  stlBlobUrl: string | null;
  userPrompt: string;
  codeGenerated: boolean;
  currentProjectId: string | null;
  resolution: number;
};

const [pastStates, setPastStates] = useState<ModelSnapshot[]>([]);
const [futureStates, setFutureStates] = useState<ModelSnapshot[]>([]);

// Take a snapshot of the CURRENT model/chat before you apply a new change.
// This makes "Undo" go back to this captured state.
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
    },
  ]);
  // any new action invalidates redo stack
  setFutureStates([]);
}

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

// Undo to previous snapshot (and push current to Redo stack)
const handleUndo = async () => {
  if (pastStates.length === 0) return;

  // Move current → future (for redo)
  setFutureStates(prev => [
    ...prev,
    {
      history,
      response,
      stlBlobUrl,
      userPrompt,
      codeGenerated,
      currentProjectId,
      resolution,
    },
  ]);

  // Pop last from past
  const prevStack = [...pastStates];
  const snapshot = prevStack.pop()!;
  setPastStates(prevStack);

  // Restore snapshot
  setHistory(snapshot.history);
  setResponse(snapshot.response);
  setUserPrompt(snapshot.userPrompt);
  setCodeGenerated(snapshot.codeGenerated);
  setCurrentProjectId(snapshot.currentProjectId);
  setResolution(snapshot.resolution);

  // Re-render STL for that snapshot
  if (snapshot.response) {
    try {
      const url = await renderStlFromCodeStrict(snapshot.response, snapshot.resolution);
      setStlBlobUrl(url);
    } catch (e) {
      console.error('Undo render error:', e);
      setStlBlobUrl(null);
    }
  } else {
    setStlBlobUrl(null);
  }
};

// Redo to next snapshot (and push current to Undo stack)
const handleRedo = async () => {
  if (futureStates.length === 0) return;

  // Move current → past (so we can undo the redo)
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
    },
  ]);

  // Pop from future
  const nextStack = [...futureStates];
  const snapshot = nextStack.pop()!;
  setFutureStates(nextStack);

  // Restore snapshot
  setHistory(snapshot.history);
  setResponse(snapshot.response);
  setUserPrompt(snapshot.userPrompt);
  setCodeGenerated(snapshot.codeGenerated);
  setCurrentProjectId(snapshot.currentProjectId);
  setResolution(snapshot.resolution);

  // Re-render STL for that snapshot
  if (snapshot.response) {
    try {
      const url = await renderStlFromCodeStrict(snapshot.response, snapshot.resolution);
      setStlBlobUrl(url);
    } catch (e) {
      console.error('Redo render error:', e);
      setStlBlobUrl(null);
    }
  } else {
    setStlBlobUrl(null);
  }
};

useEffect(() => {
  const el = chatContainerRef.current
  if (!el) return
  // Jump to bottom (fast and reliable)
  el.scrollTop = el.scrollHeight
  // If you prefer animated scrolling, use:
  // el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}, [history])


useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey

    // Undo: Ctrl+Z / Cmd+Z
    if (ctrlOrCmd && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      handleUndo()
    }

    // Redo: Ctrl+Shift+Z / Cmd+Shift+Z
    if (ctrlOrCmd && e.key === 'z' && e.shiftKey) {
      e.preventDefault()
      handleRedo()
    }
  }

  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
}, [handleUndo, handleRedo])

// Strong guided prompt
function buildGuidedPrompt(currentCode: string, userInstruction: string, res: number) {
  return [
    "You are an expert OpenSCAD assistant. Build a new model or modify the existing model as requested.",
    "",
    "### RULES",
    "- Preserve existing features unless explicitly asked to remove them.",
    "- If the model has holes, DO NOT remove them unless asked.",
    "- When adding fillets/rounds, subtract holes AFTER filleting so they remain.",
    "- Keep units consistent with the existing code.",
    "- Return a short human message AND a single fenced OpenSCAD code block.",
    "",
    "### CURRENT_OPENSCAD",
    "```openscad",
    currentCode || "// (no prior code) put your full OpenSCAD model here",
    "```",
    "",
    "### USER_REQUEST",
    userInstruction,
    "",
    "### OUTPUT FORMAT",
    "Message: one short paragraph describing the change.",
    "",
    "Code:",
    "```openscad",
    "// complete, compilable OpenSCAD code here",
    "```",
  ].join("\n");
}

// Parse AI text -> { message, code }
function parseAIResponse(raw: string): { message: string; code: string } {
  const codeMatch = raw.match(/```(?:scad|openscad)?\n([\s\S]*?)```/i);
  const code = codeMatch ? codeMatch[1].trim() : "";
  let message = raw;
  if (codeMatch) message = raw.replace(codeMatch[0], "").trim();
  if (!message) message = "Model updated based on your request.";
  return { message, code };
}

// Strict STL renderer — throws with backend errors; returns blob URL
async function renderStlFromCodeStrict(code: string, resolution: number): Promise<string> {
  const formData = new FormData();
  formData.append("code", `$fn = ${resolution};\n` + code);

  const backendRes = await fetch("https://scad-backend-production.up.railway.app/render", {
    method: "POST",
    body: formData,
  });

  const cloneText = await backendRes.clone().text();
  if (!backendRes.ok) throw new Error(`Backend render error ${backendRes.status}: ${cloneText}`);

  const ct = backendRes.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    throw new Error(`Backend returned JSON instead of STL: ${cloneText}`);
  }

  const blob = await backendRes.blob();
  if (!blob || blob.size === 0) throw new Error("Empty STL blob received.");

  return URL.createObjectURL(blob);
}

// One self-heal retry using compiler error
async function renderWithSelfHeal(
  code: string,
  resolution: number,
  callGenerate: (prompt: string) => Promise<string>
): Promise<{ ok: boolean; blobUrl?: string; message?: string; fixedCode?: string }> {
  try {
    const url = await renderStlFromCodeStrict(code, resolution);
    return { ok: true, blobUrl: url, fixedCode: code };
  } catch (e: any) {
    const firstError = String(e?.message || e);
    const repairPrompt = [
      "Fix the following OpenSCAD code so it compiles successfully. Keep the intent unchanged.",
      "",
      "### COMPILER_ERROR",
      firstError,
      "",
      "### BROKEN_CODE",
      "```openscad",
      code,
      "```",
      "",
      "### OUTPUT",
      "Return only one fenced OpenSCAD code block and a short explanation of the fix."
    ].join("\n");

    const repairRaw = await callGenerate(repairPrompt);
    const { message: repairMsg, code: repairedCode } = parseAIResponse(repairRaw);
    if (!repairedCode) return { ok: false, message: "Automatic repair failed: no code returned." };

    try {
      const url2 = await renderStlFromCodeStrict(repairedCode, resolution);
      return { ok: true, blobUrl: url2, message: repairMsg, fixedCode: repairedCode };
    } catch (e2: any) {
      return {
        ok: false,
        message: "Automatic repair failed with another compile error. Please try rephrasing your request.\n\n" + String(e2?.message || e2),
      };
    }
  }
}

  const handleSubmit = async () => {
  if (!userPrompt) return;
  setLoading(true);

  // add the user's message to the pending history
  const baseHistory = [...history, { role: 'user', content: userPrompt }];

  try {
    // Build a guided prompt that includes the current code
    const guidedPrompt = buildGuidedPrompt(userPrompt, response, resolution);

    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: guidedPrompt,
        history: baseHistory,
      }),
    });

    const data = await res.json();
    const aiText = data?.code ?? data?.question ?? data?.content ?? '';

    // Try to pull OpenSCAD code out of the response
    const code = extractOpenSCAD(aiText);

    if (code && code.trim().length > 0) {
      // We got code -> update model, render STL, and add a short status line
      setResponse(code);
      setCodeGenerated(true);

      // Keep your existing renderer
      await renderStlFromCode(code);

      // Show a brief status message (no code) so the user knows something changed
      setHistory([
        ...baseHistory,
        { role: 'assistant', content: '✅ Updated the model.' },
      ]);
    } else {
      // No code -> show the AI message as regular chat
      const msg = (aiText || '').toString().trim();
      setHistory([
        ...baseHistory,
        { role: 'assistant', content: msg || '✉️ (No response text)' },
      ]);
    }

    setUserPrompt('');
  } catch (err) {
    console.error('Error:', err);
    setHistory([
      ...baseHistory,
      { role: 'assistant', content: '❌ Something went wrong. Please try again.' },
    ]);
    setStlBlobUrl(null);
  } finally {
    setLoading(false);
  }
};

  const renderStlFromCode = async (code: string) => {
  try {
    const formData = new FormData()
    formData.append('code', `$fn = ${resolution};\n` + code)

    const backendRes = await fetch('https://scad-backend-production.up.railway.app/render', {
      method: 'POST',
      body: formData,
    })

    const debugText = await backendRes.clone().text()
    console.log('Backend response (from renderStlFromCode):', debugText)

    if (!backendRes.ok) throw new Error(`Failed to render STL: ${backendRes.statusText}`)

    const blob = await backendRes.blob()
    if (blob.size === 0) throw new Error('The STL file is empty.')

    const url = URL.createObjectURL(blob)
    setStlBlobUrl(url)
  } catch (error) {
    console.error('Render STL error:', error)
    setStlBlobUrl(null)
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

  const handleLoadProject = async (projectId: string) => {
  const project = projects.find(p => p.id === projectId);
  if (!project) return;

  // Snapshot current state BEFORE loading a new one
  takeSnapshot();

  setCurrentProjectId(projectId);
  setUserPrompt(project.prompt);
  setResponse(project.response);
  setCodeGenerated(true);
  setHistory(project.history ?? []);

  try {
    const url = await renderStlFromCodeStrict(project.response, resolution);
    setStlBlobUrl(url);
  } catch (e) {
    console.error('Error rendering saved project:', e);
    setStlBlobUrl(null);
  }
};

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
    setShowSaveSuccess(true)
    setTimeout(() => setShowSaveSuccess(false), 3000)
  }
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
  <div className={`flex flex-col lg:flex-row gap-4 p-4 min-h-screen ${darkMode ? 'bg-gray-900 text-white' : 'bg-white text-black'}`}>

    {/* Left Panel */}
    <div className="flex-1 space-y-6">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-xl font-bold">🛠️ Prompt2Part Dashboard</h1>
        <div className="flex items-center space-x-2">
          <span className="text-sm">{userEmail}</span>
          <button
            onClick={() => supabase.auth.signOut().then(() => router.push('/login'))}
            className="text-blue-500 dark:text-blue-300 underline text-sm"
          >
            Logout
          </button>
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="text-xs px-2 py-1 border border-gray-400 dark:border-gray-600 rounded"
          >
            {darkMode ? '☀️ Light' : '🌙 Dark'}
          </button>
        </div>
      </div>

      {showSaveSuccess && (
        <div className="p-2 text-green-800 bg-green-100 border border-green-300 rounded dark:bg-green-900 dark:text-green-200">
          ✅ Project saved successfully!
        </div>
      )}

      <div>
        <label htmlFor="resolution" className="text-sm font-medium">
          Curve Resolution ($fn):
        </label>
        <select
          id="resolution"
          value={resolution}
          onChange={e => setResolution(Number(e.target.value))}
          className="ml-2 border px-2 py-1 rounded bg-white dark:bg-gray-700 dark:text-white"
        >
          <option value={10}>10 (Low)</option>
          <option value={50}>50 (Medium)</option>
          <option value={100}>100 (High)</option>
          <option value={200}>200 (Very High)</option>
        </select>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-2">📁 Saved Projects</h2>
        {projects.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">No saved projects yet.</p>
        ) : (
          projects.map(project => (
            <div key={project.id} className="flex justify-between items-center border border-gray-300 dark:border-gray-600 p-2 rounded bg-gray-50 dark:bg-gray-700">
              <span className="truncate">{project.title}</span>
              <div className="space-x-2 text-sm">
                <button onClick={() => handleLoadProject(project.id)} className="text-green-600 dark:text-green-400 underline">Load</button>
                <button onClick={() => handleRename(project.id)} className="text-blue-600 dark:text-blue-400 underline">Rename</button>
                <button onClick={() => handleDelete(project.id)} className="text-red-600 dark:text-red-400 underline">Delete</button>
              </div>
            </div>
          ))
        )}
      </div>

      <div 
      ref={chatContainerRef}
      className="max-h-64 overflow-y-auto space-y-2 border border-gray-300 dark:border-gray-600 p-2 rounded bg-gray-50 dark:bg-gray-700">
  {history.map((msg, i) => (
    <div
      key={i}
      className={`p-2 rounded text-sm ${
        msg.role === 'user'
          ? 'bg-gray-200 dark:bg-gray-600'
          : 'bg-gray-100 dark:bg-gray-800'
      }`}
    >
      <strong>{msg.role === 'user' ? 'You' : 'AI'}:</strong> {msg.content}
    </div>
        ))}
      </div>

      <textarea
        className="border px-2 py-1 w-full rounded bg-white dark:bg-gray-700 dark:text-white"
        rows={3}
        value={userPrompt}
        onChange={(e) => setUserPrompt(e.target.value)}
        placeholder="Describe your part..."
      />

      <div className="flex gap-2">
  <button
  type="button"
  onClick={handleSubmit}
  disabled={loading}
  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
>
  {loading ? 'Generating...' : 'Send'}
</button>

  <button
  onClick={handleUndo}
  disabled={pastStates.length === 0}
  className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded disabled:opacity-50"
>
  Undo
</button>

<button
  onClick={handleRedo}
  disabled={futureStates.length === 0}
  className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
>
  Redo
</button>

  {currentProjectId ? (
    <button
      onClick={handleUpdateProject}
      className="bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded"
    >
      Save Changes
    </button>
  ) : (
    <button
      onClick={handleSaveProject}
      disabled={!userPrompt && history.length === 0}
      className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded disabled:opacity-50"
    >
      Save as New Project
    </button>
  )}
</div>
    </div>

    {/* Right Panel: 3D Viewer */}
    <div className="lg:w-[40%] w-full p-4 bg-gray-100 dark:bg-gray-800 rounded space-y-4">
      <h2 className="font-bold text-lg">🧱 3D Preview:</h2>
      {stlBlobUrl ? (
        <>
          <PartViewer stlUrl={stlBlobUrl} />
          <button
            onClick={handleDownload}
            className="bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-900"
          >
            ⬇️ Download STL
          </button>
        </>
      ) : (
        <div className="text-sm text-gray-600 dark:text-gray-300 italic">
          Nothing to show yet. Submit a prompt to generate a model.
        </div>
      )}
    </div>
  </div>
)
}

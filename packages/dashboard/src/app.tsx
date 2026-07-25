/**
 * Placeholder shell. The real dashboard — router, API client, entry index and detail
 * screens — is built in Phase 4 (P4.2, P4.3). Phase 0 ships this so the Vite + Tailwind
 * pipeline is exercised end to end and `packages/periscope/build/dashboard` exists.
 */
export function App() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-6">
        <h1 className="font-mono text-3xl font-semibold tracking-tight">periscope</h1>
        <p className="text-sm text-zinc-400">
          Build pipeline is live. The dashboard interface ships in Phase 4.
        </p>
      </div>
    </main>
  )
}

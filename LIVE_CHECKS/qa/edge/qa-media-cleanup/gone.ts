// ASALOCAL · qa-media-cleanup — retired. Deployed after the QA run so the function
// can no longer delete anything (same pattern as adim2-dispatch-once).
Deno.serve(() => new Response(JSON.stringify({ error: "gone" }), { status: 410, headers: { "content-type": "application/json", "cache-control": "no-store" } }));

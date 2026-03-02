/**
 * KCB POS — Cloudflare Worker
 * Serves static assets + D1 API for persistent data
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // API routes
        if (url.pathname.startsWith('/api/')) {
            return handleAPI(url, request, env);
        }

        // Static assets handled by Cloudflare's asset binding
        return env.ASSETS.fetch(request);
    }
};

// ═══════════════════════════════════════
// API HANDLER
// ═══════════════════════════════════════
async function handleAPI(url, request, env) {
    const path = url.pathname;
    const method = request.method;
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

    // CORS preflight
    if (method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            }
        });
    }

    try {
        // ── ORDERS ──
        if (path === '/api/orders' && method === 'GET') {
            const limit = parseInt(url.searchParams.get('limit') || '200');
            const rows = await env.DB.prepare('SELECT id, data, created_at FROM orders ORDER BY created_at DESC LIMIT ?').bind(limit).all();
            const orders = rows.results.map(r => JSON.parse(r.data));
            return new Response(JSON.stringify(orders), { headers });
        }

        if (path === '/api/orders' && method === 'POST') {
            const order = await request.json();
            await env.DB.prepare('INSERT OR REPLACE INTO orders (id, data, created_at) VALUES (?, ?, ?)').bind(order.id, JSON.stringify(order), Math.floor(order.time / 1000)).run();
            return new Response(JSON.stringify({ ok: true }), { headers });
        }

        // ── SETTINGS ──
        if (path === '/api/settings' && method === 'GET') {
            const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
            const settings = {};
            rows.results.forEach(r => { settings[r.key] = r.value; });
            return new Response(JSON.stringify(settings), { headers });
        }

        if (path === '/api/settings' && method === 'PUT') {
            const body = await request.json();
            const stmt = env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())');
            const batch = Object.entries(body).map(([k, v]) => stmt.bind(k, typeof v === 'string' ? v : JSON.stringify(v)));
            if (batch.length) await env.DB.batch(batch);
            return new Response(JSON.stringify({ ok: true }), { headers });
        }

        // ── ORDER COUNTER ──
        if (path === '/api/counter' && method === 'GET') {
            const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'orderCounter'").first();
            return new Response(JSON.stringify({ counter: parseInt(row?.value || '1000') }), { headers });
        }

        if (path === '/api/counter' && method === 'PUT') {
            const { counter } = await request.json();
            await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('orderCounter', ?, unixepoch())").bind(String(counter)).run();
            return new Response(JSON.stringify({ ok: true }), { headers });
        }

        // ── RUNNING ORDERS ──
        if (path === '/api/running' && method === 'GET') {
            const rows = await env.DB.prepare('SELECT id, data FROM running_orders ORDER BY created_at DESC').all();
            const orders = rows.results.map(r => JSON.parse(r.data));
            return new Response(JSON.stringify(orders), { headers });
        }

        if (path === '/api/running' && method === 'POST') {
            const order = await request.json();
            await env.DB.prepare('INSERT INTO running_orders (id, data) VALUES (?, ?)').bind(order.id, JSON.stringify(order)).run();
            return new Response(JSON.stringify({ ok: true }), { headers });
        }

        if (path.startsWith('/api/running/') && method === 'DELETE') {
            const id = path.split('/api/running/')[1];
            await env.DB.prepare('DELETE FROM running_orders WHERE id = ?').bind(decodeURIComponent(id)).run();
            return new Response(JSON.stringify({ ok: true }), { headers });
        }

        // ── SYNC (bulk upload all data at once) ──
        if (path === '/api/sync' && method === 'POST') {
            const body = await request.json();

            // Sync orders
            if (body.orders?.length) {
                const stmt = env.DB.prepare('INSERT OR REPLACE INTO orders (id, data, created_at) VALUES (?, ?, ?)');
                // Batch in chunks of 50
                for (let i = 0; i < body.orders.length; i += 50) {
                    const chunk = body.orders.slice(i, i + 50);
                    const batch = chunk.map(o => stmt.bind(o.id, JSON.stringify(o), Math.floor((o.time || Date.now()) / 1000)));
                    await env.DB.batch(batch);
                }
            }

            // Sync settings
            if (body.settings) {
                const stmt = env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())');
                const batch = Object.entries(body.settings).map(([k, v]) => stmt.bind(k, typeof v === 'string' ? v : JSON.stringify(v)));
                if (batch.length) await env.DB.batch(batch);
            }

            // Sync running orders
            if (body.runningOrders) {
                await env.DB.prepare('DELETE FROM running_orders').run();
                if (body.runningOrders.length) {
                    const stmt = env.DB.prepare('INSERT INTO running_orders (id, data) VALUES (?, ?)');
                    const batch = body.runningOrders.map(o => stmt.bind(o.id, JSON.stringify(o)));
                    await env.DB.batch(batch);
                }
            }

            // Sync counter
            if (body.orderCounter !== undefined) {
                await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('orderCounter', ?, unixepoch())").bind(String(body.orderCounter)).run();
            }

            return new Response(JSON.stringify({ ok: true, synced: true }), { headers });
        }

        // ── RESET (clear running orders + counter only — orders are preserved for reports) ──
        if (path === '/api/reset' && method === 'DELETE') {
            await env.DB.prepare('DELETE FROM running_orders').run();
            await env.DB.prepare("DELETE FROM settings WHERE key = 'orderCounter'").run();
            return new Response(JSON.stringify({ ok: true, reset: true }), { headers });
        }

        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
}

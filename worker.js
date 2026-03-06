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

        // ══════════════════════════════════════
        // RESTOVA ADMIN ENDPOINTS
        // (These expose POS data for the admin panel)
        // ══════════════════════════════════════

        // ── MENU ITEMS (read from settings or return static defaults) ──
        if (path === '/api/menu' && method === 'GET') {
            const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'menuData'").first();
            if (row?.value) {
                return new Response(row.value, { headers });
            }
            // Return empty — menu is static in data.js on client side
            return new Response(JSON.stringify({ source: 'static', message: 'Menu is loaded from static data.js on POS client' }), { headers });
        }

        // ── TABLE STATUS (synced from POS via settings) ──
        if (path === '/api/tables' && method === 'GET') {
            const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'tableData'").first();
            if (row?.value) {
                try {
                    const tables = JSON.parse(row.value);
                    return new Response(JSON.stringify(tables), { headers });
                } catch (e) {
                    return new Response(JSON.stringify([]), { headers });
                }
            }
            // Default: 20 available tables
            const defaultTables = Array.from({ length: 20 }, (_, i) => ({
                id: i + 1, status: 'available', guests: 0, amount: 0
            }));
            return new Response(JSON.stringify(defaultTables), { headers });
        }

        // ── STAFF (synced from POS via settings) ──
        if (path === '/api/staff' && method === 'GET') {
            const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'staffData'").first();
            if (row?.value) {
                try {
                    const staff = JSON.parse(row.value);
                    return new Response(JSON.stringify(staff), { headers });
                } catch (e) {
                    return new Response(JSON.stringify([]), { headers });
                }
            }
            return new Response(JSON.stringify([]), { headers });
        }

        // ── KITCHEN / KDS STATUS ──
        if (path === '/api/kitchen' && method === 'GET') {
            // KDS orders are synced from the POS via settings.kdsData
            let activeKOTs = [];
            const kdsRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'kdsData'").first();
            if (kdsRow?.value) {
                try {
                    const allKOTs = JSON.parse(kdsRow.value);
                    // Only show active KOTs (not 'done' or 'ready')
                    activeKOTs = allKOTs.filter(k => k.status !== 'done' && k.status !== 'ready');
                } catch (e) { }
            }

            const stations = [
                { id: 'wok', name: 'Wok Station', icon: '🔥', categories: ['noodles', 'rice', 'chopsuey', 'ramen'] },
                { id: 'grill', name: 'Grill & Fry', icon: '🍳', categories: ['snacks', 'spring-roll', 'egg-magic', 'fish', 'kurkure-momos'] },
                { id: 'steam', name: 'Steam & Momo', icon: '♨️', categories: ['momos', 'tandoori-momos', 'thuppa', 'soup', 'chicken-soup', 'laphing'] },
                { id: 'pasta-stn', name: 'Pasta Station', icon: '🍝', categories: ['pasta'] },
                { id: 'prep', name: 'Prep & Veg', icon: '🥦', categories: ['vegetables', 'combo'] },
                { id: 'drinks', name: 'Drinks Station', icon: '🍹', categories: ['mocktails', 'shakes', 'bobba', 'popping-tea', 'cold-drink'] },
            ];

            return new Response(JSON.stringify({
                stations,
                activeKOTs: activeKOTs.length,
                orders: activeKOTs,
            }), { headers });
        }

        // ── DEVICE HEARTBEAT ──
        if (path === '/api/heartbeat' && method === 'GET') {
            const settings = {};
            const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
            rows.results.forEach(r => { settings[r.key] = r.value; });

            const orderCount = await env.DB.prepare('SELECT COUNT(*) as count FROM orders').first();
            const runningCount = await env.DB.prepare('SELECT COUNT(*) as count FROM running_orders').first();
            const lastOrder = await env.DB.prepare('SELECT created_at FROM orders ORDER BY created_at DESC LIMIT 1').first();

            return new Response(JSON.stringify({
                status: 'online',
                timestamp: Date.now(),
                posVersion: '2.4.1',
                restaurantName: settings.restaurantName || 'King Chinese Bowl',
                totalOrders: orderCount?.count || 0,
                activeOrders: runningCount?.count || 0,
                lastOrderAt: lastOrder?.created_at ? lastOrder.created_at * 1000 : null,
                uptime: Date.now(),
                dbSize: rows.results.length + ' keys',
            }), { headers });
        }

        // ── FULL DASHBOARD (aggregated data for Restova) ──
        if (path === '/api/dashboard' && method === 'GET') {
            const settings = {};
            const sRows = await env.DB.prepare('SELECT key, value FROM settings').all();
            sRows.results.forEach(r => { settings[r.key] = r.value; });

            const orderCount = await env.DB.prepare('SELECT COUNT(*) as count FROM orders').first();
            const runningCount = await env.DB.prepare('SELECT COUNT(*) as count FROM running_orders').first();

            // Get today's orders
            const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
            const todayOrders = await env.DB.prepare('SELECT data FROM orders WHERE created_at >= ?').bind(todayStart).all();
            let todayRevenue = 0;
            todayOrders.results.forEach(r => {
                try { todayRevenue += JSON.parse(r.data).total || 0; } catch (e) { }
            });

            // Tables
            let tables = [];
            if (settings.tableData) {
                try { tables = JSON.parse(settings.tableData); } catch (e) { }
            }
            const occupiedTables = tables.filter(t => t.status !== 'available').length;

            // Staff
            let staff = [];
            if (settings.staffData) {
                try { staff = JSON.parse(settings.staffData); } catch (e) { }
            }

            return new Response(JSON.stringify({
                restaurantName: settings.restaurantName || 'King Chinese Bowl',
                totalOrders: orderCount?.count || 0,
                todayOrders: todayOrders.results.length,
                todayRevenue,
                activeOrders: runningCount?.count || 0,
                totalTables: tables.length || 20,
                occupiedTables,
                totalStaff: staff.length,
                activeStaff: staff.filter(s => s.role).length,
                posVersion: '2.4.1',
                status: 'online',
                timestamp: Date.now(),
            }), { headers });
        }

        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
}

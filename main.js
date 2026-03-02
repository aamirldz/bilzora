import { CATEGORIES, MENU_ITEMS, TABLES, CUSTOMERS, STAFF, INVENTORY, MODIFIERS, DISCOUNT_COUPONS, KITCHEN_STATIONS } from './data.js';
import { renderScreenContent } from './screens.js';

// One-time migration: clear old stale/demo data from previous deploys
if (!localStorage.getItem('kcb_v6_clean')) {
    ['kcb_kds', 'kcb_orders', 'kcb_running', 'kcb_kotHistory',
        'kcb_staffData', 'kcb_customerData', 'kcb_inventoryData', 'kcb_counterDate',
        'kcb_orderCounter', 'kcb_cart', 'kcb_tables', 'kcb_kotCounter', 'kcb_billCounter'
    ].forEach(k => localStorage.removeItem(k));
    localStorage.setItem('kcb_v6_clean', '1');
    // NOTE: Do NOT call /api/reset here — it wipes all D1 orders and destroys report history
}

/* ═══════════════════════════════════════════════
   KCB POS — App State & Core Engine
   World-class POS for King Chinese Bowl
   ═══════════════════════════════════════════════ */

const state = {
    // Navigation
    screen: localStorage.getItem('kcb_screen') || 'dashboard',
    // Billing
    cart: JSON.parse(localStorage.getItem('kcb_cart') || '[]'),
    orderType: localStorage.getItem('kcb_orderType') || 'dine-in',
    selectedTable: JSON.parse(localStorage.getItem('kcb_selectedTable') || 'null'),
    selectedCategory: 'all',
    vegFilter: 'all',
    searchQuery: '',
    discount: { type: null, value: 0, code: '', name: '', maxDiscount: 0 },
    orderNote: '',
    isComplimentary: false,
    attachedCustomer: null,
    // Orders
    orders: JSON.parse(localStorage.getItem('kcb_orders') || '[]'),
    orderCounter: parseInt(localStorage.getItem('kcb_orderCounter') || '1000'),
    runningOrders: JSON.parse(localStorage.getItem('kcb_running') || '[]'),
    // KDS
    kdsOrders: JSON.parse(localStorage.getItem('kcb_kds') || '[]'),
    kdsStation: 'all',
    // KOT History (all KOTs stored for reprint)
    kotHistory: JSON.parse(localStorage.getItem('kcb_kotHistory') || '[]'),
    // Report History (archived orders from past days — permanent)
    reportHistory: JSON.parse(localStorage.getItem('kcb_reportHistory') || '[]'),
    // Tables
    tableFloor: 'main',
    // Settings
    paymentMethod: 'cash',
    reportPeriod: 'today',
    settings: JSON.parse(localStorage.getItem('kcb_settings') || JSON.stringify({
        restaurantName: 'King Chinese Bowl',
        phone: '+91 98765 43210',
        address: 'Chandigarh, India',
        gstNo: '06AABCU9603R1ZM',
        gstRate: 5,
        serviceCharge: 0,
        invoicePrefix: 'KCB-',
        dailyGoal: 40000,
        kotPrinter: 'thermal-kitchen',
        billPrinter: 'thermal-cashier',
        autoPrintKOT: true,
        theme: 'light',
        soundEffects: true,
        compactMode: false
    }))
};

// Validate settings — fix corrupted values from old testing
if (typeof state.settings.gstRate !== 'number' || ![0, 5, 12, 18, 28].includes(state.settings.gstRate)) {
    state.settings.gstRate = 5;
}
if (typeof state.settings.serviceCharge !== 'number') {
    state.settings.serviceCharge = 0;
}

// Load persisted data from localStorage (staff, customers, inventory)
(function loadPersistedData() {
    // Staff — load from localStorage first
    const savedStaff = localStorage.getItem('kcb_staffData');
    if (savedStaff) {
        try {
            const parsed = JSON.parse(savedStaff);
            if (Array.isArray(parsed)) { STAFF.length = 0; parsed.forEach(s => STAFF.push(s)); }
        } catch (e) { }
    }
    // Also fetch staff from D1 cloud (for cross-device login)
    fetch('/api/settings').then(r => r.json()).then(settings => {
        const pushToCloud = {};

        // Staff sync
        if (settings.staffData) {
            try {
                const cloudStaff = JSON.parse(settings.staffData);
                if (Array.isArray(cloudStaff) && cloudStaff.length > 0) {
                    STAFF.length = 0;
                    cloudStaff.forEach(s => STAFF.push(s));
                    localStorage.setItem('kcb_staffData', JSON.stringify(STAFF));
                }
            } catch (e) { }
        } else if (STAFF.length > 0) {
            pushToCloud.staffData = JSON.stringify(STAFF);
        }

        // Customers sync
        if (settings.customerData) {
            try {
                const cloudCust = JSON.parse(settings.customerData);
                if (Array.isArray(cloudCust) && cloudCust.length > 0) {
                    CUSTOMERS.length = 0;
                    cloudCust.forEach(c => CUSTOMERS.push(c));
                    localStorage.setItem('kcb_customerData', JSON.stringify(CUSTOMERS));
                }
            } catch (e) { }
        } else if (CUSTOMERS.length > 0) {
            pushToCloud.customerData = JSON.stringify(CUSTOMERS);
        }

        // Inventory sync
        if (settings.inventoryData) {
            try {
                const cloudInv = JSON.parse(settings.inventoryData);
                if (Array.isArray(cloudInv) && cloudInv.length > 0) {
                    INVENTORY.length = 0;
                    cloudInv.forEach(i => INVENTORY.push(i));
                    localStorage.setItem('kcb_inventoryData', JSON.stringify(INVENTORY));
                }
            } catch (e) { }
        } else if (INVENTORY.length > 0) {
            pushToCloud.inventoryData = JSON.stringify(INVENTORY);
        }

        // Push any local-only data to cloud (initial migration)
        if (Object.keys(pushToCloud).length > 0) {
            fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pushToCloud)
            }).catch(() => { });
        }
    }).catch(() => { });
    // Customers
    const savedCust = localStorage.getItem('kcb_customerData');
    if (savedCust) {
        try {
            const parsed = JSON.parse(savedCust);
            if (Array.isArray(parsed)) { CUSTOMERS.length = 0; parsed.forEach(c => CUSTOMERS.push(c)); }
        } catch (e) { }
    }
    // Inventory
    const savedInv = localStorage.getItem('kcb_inventoryData');
    if (savedInv) {
        try {
            const parsed = JSON.parse(savedInv);
            if (Array.isArray(parsed)) { INVENTORY.length = 0; parsed.forEach(i => INVENTORY.push(i)); }
        } catch (e) { }
    }
})();

// Daily-resetting counters and dashboard data
function runDailyReset() {
    const today = new Date().toDateString();
    const savedDate = localStorage.getItem('kcb_counterDate') || '';
    if (savedDate !== today) {
        // Archive yesterday's orders into reportHistory before resetting
        if (state.orders.length > 0) {
            state.reportHistory = state.reportHistory || [];
            const existingIds = new Set(state.reportHistory.map(h => h.id));
            state.orders.forEach(o => {
                // Only add valid orders that aren't already archived
                if (o && o.id && o.time && !existingIds.has(o.id)) {
                    state.reportHistory.push(o);
                    existingIds.add(o.id);
                }
            });
            // Keep only last 90 days of history
            const ninetyDaysAgo = Date.now() - 90 * 86400000;
            state.reportHistory = state.reportHistory.filter(o => o.time >= ninetyDaysAgo);
            try { localStorage.setItem('kcb_reportHistory', JSON.stringify(state.reportHistory)); } catch (e) { /* quota exceeded */ }
        }

        // New day — reset daily counters
        state.kotCounter = 0;
        state.billCounter = 0;
        localStorage.setItem('kcb_counterDate', today);
        localStorage.setItem('kcb_kotCounter', '0');
        localStorage.setItem('kcb_billCounter', '0');

        // Reset daily dashboard data (orders, KDS, KOT history, running orders)
        state.orders = [];
        state.kdsOrders = [];
        state.kotHistory = [];
        state.runningOrders = [];
        state.orderCounter = 0;
        localStorage.setItem('kcb_orders', '[]');
        localStorage.setItem('kcb_kds', '[]');
        localStorage.setItem('kcb_kotHistory', '[]');
        localStorage.setItem('kcb_running', '[]');
        localStorage.setItem('kcb_orderCounter', '0');

        // Reset tables to available
        TABLES.forEach(t => { t.status = 'available'; t.guests = 0; t.amount = 0; t.occupiedSince = null; t.orderItems = []; });
        localStorage.setItem('kcb_tables', JSON.stringify(TABLES));

        // If this is a live midnight rollover (not first page load), refresh the screen
        if (savedDate !== '') {
            syncFromD1().catch(() => { });
            renderScreen();
        }
    } else {
        state.kotCounter = parseInt(localStorage.getItem('kcb_kotCounter') || '0');
        state.billCounter = parseInt(localStorage.getItem('kcb_billCounter') || '0');
    }
}
// Run on page load
runDailyReset();
// Auto-check every 60 seconds — triggers midnight rollover even if POS stays open overnight
setInterval(runDailyReset, 60000);

// Restore table state from localStorage onto TABLES export
(function restoreTablesFromStorage() {
    const saved = JSON.parse(localStorage.getItem('kcb_tables') || 'null');
    if (saved && Array.isArray(saved)) {
        saved.forEach(st => {
            const tbl = TABLES.find(t => t.id === st.id);
            if (tbl) { tbl.status = st.status; tbl.guests = st.guests; tbl.amount = st.amount; tbl.occupiedSince = st.occupiedSince || null; tbl.orderItems = st.orderItems || []; }
        });
    }
})();

/* ═══════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════ */
export const fmt = (n) => '₹' + Number(n).toLocaleString('en-IN');
export const spice = (l) => l === 0 ? '' : '🌶️'.repeat(Math.min(l, 3));
export function timeAgo(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
}
export function getStation(cat) {
    return KITCHEN_STATIONS.find(s => s.categories.includes(cat)) || KITCHEN_STATIONS[0];
}
function uid() { return Date.now().toString(36).toUpperCase().slice(-6); }

// ── Performance: Debounce (delays fn until idle) ──
function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function notify(msg, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2500);
}
let _audioCtx = null;
function playClick() {
    try {
        if (!_audioCtx) _audioCtx = new AudioContext();
        const o = _audioCtx.createOscillator(); const g = _audioCtx.createGain();
        o.connect(g); g.connect(_audioCtx.destination); o.frequency.value = 800; g.gain.value = 0.05;
        o.start(); o.stop(_audioCtx.currentTime + 0.03);
    } catch (e) { }
}

/* ═══════════════════════════════════════════════
   D1 DATABASE SYNC LAYER
   localStorage = fast local cache
   D1 API = persistent cloud storage (fire-and-forget)
   ═══════════════════════════════════════════════ */
const db = {
    _api(path, opts = {}) {
        return fetch(`/api/${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...opts
        }).then(r => r.json()).catch(() => null);
    },
    saveOrder(order) {
        return this._api('orders', { method: 'POST', body: JSON.stringify(order) });
    },
    saveCounter(counter) {
        return this._api('counter', { method: 'PUT', body: JSON.stringify({ counter }) });
    },
    saveSettings(settings) {
        return this._api('settings', { method: 'PUT', body: JSON.stringify(settings) });
    },
    saveRunning(orders) {
        // Full replace: delete all then re-insert via sync
        return this._api('sync', { method: 'POST', body: JSON.stringify({ runningOrders: orders }) });
    },
    async loadAll() {
        try {
            const [orders, settings, running, counter] = await Promise.all([
                this._api('orders?limit=1000'),
                this._api('settings'),
                this._api('running'),
                this._api('counter')
            ]);
            return { orders, settings, running, counter: counter?.counter };
        } catch { return null; }
    }
};

// Load from D1 on startup (async, non-blocking)
async function syncFromD1() {
    const data = await db.loadAll();
    if (!data) return; // API not available (local dev), use localStorage

    // Split D1 orders into today vs history
    if (data.orders?.length) {
        // Validate orders from D1
        const validOrders = data.orders.filter(o => o && o.id && o.time && typeof o.time === 'number');

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayMs = todayStart.getTime();

        const todayOrders = validOrders.filter(o => o.time >= todayMs);
        const pastOrders = validOrders.filter(o => o.time < todayMs);

        // Only load today's orders into state (don't override daily reset)
        if (todayOrders.length > state.orders.length) {
            state.orders = todayOrders;
            localStorage.setItem('kcb_orders', JSON.stringify(state.orders));
        }

        // Archive past orders into reportHistory (for week/month reports)
        if (pastOrders.length > 0) {
            state.reportHistory = state.reportHistory || [];
            const ninetyDaysAgo = Date.now() - 90 * 86400000;
            const existingIds = new Set(state.reportHistory.map(h => h.id));
            pastOrders.forEach(o => {
                if (o.time >= ninetyDaysAgo && !existingIds.has(o.id)) {
                    state.reportHistory.push(o);
                    existingIds.add(o.id);
                }
            });
            try { localStorage.setItem('kcb_reportHistory', JSON.stringify(state.reportHistory)); } catch (e) { /* quota exceeded */ }
        }
    }

    if (data.counter && data.counter > state.orderCounter) {
        state.orderCounter = data.counter;
        localStorage.setItem('kcb_orderCounter', String(data.counter));
    }
    if (data.running?.length) {
        state.runningOrders = data.running;
        localStorage.setItem('kcb_running', JSON.stringify(state.runningOrders));
    }
    if (data.settings?.restaurantName) {
        try {
            const merged = { ...state.settings };
            Object.entries(data.settings).forEach(([k, v]) => {
                try { merged[k] = JSON.parse(v); } catch { merged[k] = v; }
            });
            state.settings = merged;
            localStorage.setItem('kcb_settings', JSON.stringify(state.settings));
        } catch { }
    }
    // Data updated in state — caller decides whether to re-render
}

/* ═══════════════════════════════════════════════
   STATE PERSISTENCE (throttled for performance)
   Batches localStorage writes to avoid blocking UI
   ═══════════════════════════════════════════════ */
let _persistTimer = null;
function persistState() {
    if (_persistTimer) return; // already scheduled
    _persistTimer = setTimeout(_doPersist, 300);
}
function persistStateNow() { // force-flush (for critical writes)
    clearTimeout(_persistTimer); _persistTimer = null;
    _doPersist();
}
function _doPersist() {
    _persistTimer = null;
    // Tables
    localStorage.setItem('kcb_tables', JSON.stringify(TABLES.map(t => ({ id: t.id, status: t.status, guests: t.guests, amount: t.amount, occupiedSince: t.occupiedSince || null, orderItems: t.orderItems || [] }))));
    // KDS
    localStorage.setItem('kcb_kds', JSON.stringify(state.kdsOrders));
    // Cart & billing
    localStorage.setItem('kcb_cart', JSON.stringify(state.cart));
    localStorage.setItem('kcb_selectedTable', JSON.stringify(state.selectedTable));
    localStorage.setItem('kcb_orderType', state.orderType);
    // KOT History
    localStorage.setItem('kcb_kotHistory', JSON.stringify(state.kotHistory));
}

/* ═══════════════════════════════════════════════
   SLIP PRINTING ENGINE
   Formats and prints 80mm thermal receipts
   ═══════════════════════════════════════════════ */
function printSlip(html, title) {
    // Remove any existing print frame
    const oldFrame = document.getElementById('kcb-print-frame');
    if (oldFrame) oldFrame.remove();

    // Create hidden iframe for direct printing (no popup needed)
    const iframe = document.createElement('iframe');
    iframe.id = 'kcb-print-frame';
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:80mm;height:0;border:none;visibility:hidden;';
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html><head><title>${title}</title>
<style>
  @page { margin: 0; size: 80mm auto; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 12px;
    line-height: 1.4;
    width: 80mm;
    padding: 4mm;
    color: #000;
    background: #fff;
  }
  h1, h2, h3, strong, b, .slip-bold, .slip-lg, .slip-xl, .slip-kot-header {
    font-family: Arial, Helvetica, sans-serif;
    font-weight: bold;
  }
  .slip-center { text-align: center; }
  .slip-bold { font-weight: bold; }
  .slip-lg { font-size: 16px; font-weight: bold; }
  .slip-xl { font-size: 20px; font-weight: bold; }
  .slip-sm { font-size: 10px; }
  .slip-divider { border-top: 1px dashed #000; margin: 6px 0; }
  .slip-double-divider { border-top: 2px solid #000; margin: 6px 0; }
  .slip-row { display: flex; justify-content: space-between; }
  .slip-row-left { flex: 1; }
  .slip-row-right { text-align: right; white-space: nowrap; }
  .slip-item-mod { padding-left: 16px; font-size: 11px; color: #333; }
  .slip-item-note { padding-left: 16px; font-size: 11px; font-style: italic; }
  .slip-total-row { font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold; }
  .slip-footer { text-align: center; margin-top: 8px; font-size: 10px; }
  .slip-kot-header { text-align: center; font-size: 22px; font-weight: bold; letter-spacing: 4px; margin: 4px 0; }
  .slip-kot-item { font-size: 14px; font-weight: bold; margin: 2px 0; }
  .slip-kot-qty { font-size: 16px; font-weight: bold; }
  .slip-station { text-align: center; font-size: 14px; font-weight: bold; border: 1px solid #000; padding: 2px; margin-top: 4px; }
</style>
</head><body>${html}</body></html>`);
    doc.close();

    // Direct print — no popup, straight to printer
    setTimeout(() => {
        try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
        } catch (e) {
            // Fallback: open in new window if iframe print fails
            const w = window.open('', '_blank', 'width=350,height=600');
            if (w) {
                w.document.write(doc.documentElement.outerHTML);
                w.document.close();
                w.onload = () => { w.print(); w.close(); };
            }
        }
        // Clean up after print
        setTimeout(() => iframe.remove(), 2000);
    }, 200);
}

// ── KOT SLIP (Kitchen Order Ticket) — matches physical slip format ──
function printKOTSlip(kot) {
    const now = new Date(kot.time || Date.now());
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const dateTimeStr = `${dd}/${mm}/${yy} ${hh}:${mi}`;

    // Extract KOT number from id (e.g. 'KCB-5' -> '5')
    const kotNum = kot.id ? kot.id.replace(/[^0-9]/g, '') : '1';

    const tableLabel = kot.table ? `T${kot.table}` : '-';
    const orderType = (kot.type || 'dine-in') === 'dine-in' ? 'Dine In' : 'Take Away';

    // Build items list
    let itemsHtml = kot.items.map(item => {
        let line = `<div style="margin:2px 0;font-size:14px;"><strong>${item.qty}</strong>&nbsp;&nbsp;${item.name}</div>`;
        if (item.modifiers?.length) {
            line += item.modifiers.map(m => `<div style="padding-left:20px;font-size:12px;">» ${typeof m === 'string' ? m : m.name}</div>`).join('');
        }
        if (item.notes) {
            line += `<div style="padding-left:20px;font-size:12px;font-style:italic;">📝 ${item.notes}</div>`;
        }
        return line;
    }).join('');

    const html = `
        <div style="text-align:center;font-size:13px;">${dateTimeStr}</div>
        <div style="text-align:center;font-size:16px;font-weight:bold;">KOT - ${kotNum}</div>
        <div style="text-align:center;font-size:14px;font-weight:bold;">${orderType}</div>
        <div style="text-align:center;font-size:14px;font-weight:bold;">Table No: ${tableLabel}</div>
        <div style="border-top:1px dashed #000;margin:6px 0;"></div>
        <div style="font-size:13px;font-weight:bold;">Qty. Item</div>
        ${itemsHtml}
        <div style="border-top:1px dashed #000;margin:6px 0;"></div>
        <div style="text-align:center;font-size:12px;">Total Items: ${kot.items.reduce((s, i) => s + i.qty, 0)}</div>
    `;

    printSlip(html, `KOT ${kot.id}`);
}

// ── CUSTOMER BILL / INVOICE — matches physical slip format ──
function printCustomerBill(order) {
    const now = new Date(order.time || Date.now());
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const dateStr = `${dd}/${mm}/${yy}`;
    const timeStr = `${hh}:${mi}`;

    const billNum = order.id ? order.id.replace(/[^0-9]/g, '') : '1';
    const orderType = (order.type || 'dine-in') === 'dine-in' ? 'Dine In' : 'Take Away';
    const tableLabel = order.table ? `${orderType}: T${order.table}` : orderType;
    const cashierName = state.settings.cashierName || 'Admin';
    const footerText = state.settings.footerText || 'Thanks For Ordering !!';

    // Build items table rows
    let totalQty = 0;
    const itemsHtml = order.items.map((item, idx) => {
        const modCost = (item.modifiers || []).reduce((s, m) => s + (m.price || 0), 0);
        const unitPrice = item.price + modCost;
        const lineTotal = unitPrice * item.qty;
        totalQty += item.qty;
        return `
            <tr>
                <td style="vertical-align:top;">${idx + 1}</td>
                <td style="vertical-align:top;word-wrap:break-word;">${item.name}${(item.modifiers || []).length ? '<br>' + item.modifiers.map(m => '<small>+ ' + (m.name || m) + '</small>').join('<br>') : ''}${item.notes ? '<br><small><i>📝 ' + item.notes + '</i></small>' : ''}</td>
                <td style="text-align:center;vertical-align:top;">${item.qty}</td>
                <td style="text-align:right;vertical-align:top;">${unitPrice.toFixed(2)}</td>
                <td style="text-align:right;vertical-align:top;">${lineTotal.toFixed(2)}</td>
            </tr>`;
    }).join('');

    const html = `
        <div style="text-align:center;">
            <div style="font-size:18px;font-weight:bold;">${state.settings.restaurantName || 'King Chinese Bowl'}</div>
            <div style="font-size:11px;">${state.settings.address || ''}</div>
            ${state.settings.phone ? '<div style="font-size:11px;">Mob. ' + state.settings.phone + '</div>' : ''}
        </div>
        <div style="border-top:1px solid #000;margin:6px 0;"></div>
        <div style="font-size:12px;">Name: ${order.customer || ''}</div>
        <div style="border-top:1px solid #000;margin:6px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;">
            <span>Date: ${dateStr}<br>${timeStr}</span>
            <span style="font-weight:bold;">${tableLabel}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;">
            <span>Cashier: ${cashierName}</span>
            <span>Bill No.: ${billNum}</span>
        </div>
        <div style="border-top:1px solid #000;margin:6px 0;"></div>
        <table style="width:100%;font-size:12px;border-collapse:collapse;table-layout:fixed;">
            <tr style="font-weight:bold;">
                <td style="width:8%;">No.</td><td style="width:36%;">Item</td><td style="width:12%;text-align:center;">Qty.</td><td style="width:22%;text-align:right;">Price</td><td style="width:22%;text-align:right;">Amount</td>
            </tr>
            <tr><td colspan="5"><div style="border-top:1px solid #000;margin:3px 0;"></div></td></tr>
            ${itemsHtml}
        </table>
        <div style="border-top:1px solid #000;margin:6px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;">
            <span>Total Qty: ${totalQty}</span>
            <span>Sub Total&nbsp;&nbsp;${order.subtotal.toFixed(2)}</span>
        </div>
        ${order.discount > 0 ? '<div style="display:flex;justify-content:space-between;font-size:12px;"><span>' + (order.isComplimentary ? 'Complimentary' : 'Discount') + '</span><span>-' + order.discount.toFixed(2) + '</span></div>' : ''}
        ${order.gst > 0 ? '<div style="display:flex;justify-content:space-between;font-size:12px;"><span>GST @ ' + (state.settings.gstRate ?? 5) + '%</span><span>' + order.gst.toFixed(2) + '</span></div>' : ''}
        <div style="border-top:1px solid #000;margin:6px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-family:'Courier New',monospace;font-size:16px;font-weight:bold;">
            <span>Grand Total</span>
            <span>₹${order.total.toFixed(2)}</span>
        </div>
        <div style="border-top:1px solid #000;margin:6px 0;"></div>
        <div style="text-align:center;font-size:13px;margin-top:6px;">${footerText}</div>
    `;

    printSlip(html, `Bill ${order.id}`);
}

// Reprint a KOT from history
export function reprintKOT(kotId) {
    const kot = state.kotHistory.find(k => k.id === kotId);
    if (kot) printKOTSlip(kot);
    else notify('⚠️ KOT not found', 'warn');
}

// Reprint a customer bill from order history
export function reprintBill(orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if (order) printCustomerBill(order);
    else notify('⚠️ Order not found', 'warn');
}

/* ═══════════════════════════════════════════════
   CART ENGINE
   ═══════════════════════════════════════════════ */
export function getCartTotals() {
    const subtotal = state.cart.reduce((sum, item) => {
        const modTotal = (item.modifiers || []).reduce((m, mod) => m + mod.price, 0);
        return sum + (item.price + modTotal) * item.qty;
    }, 0);

    let discountAmt = 0;
    if (state.isComplimentary) {
        discountAmt = subtotal;
    } else if (state.discount.type === 'percent') {
        discountAmt = Math.min(Math.round(subtotal * state.discount.value / 100), state.discount.maxDiscount || 99999);
    } else if (state.discount.type === 'fixed') {
        discountAmt = Math.min(state.discount.value, subtotal);
    }

    const afterDiscount = subtotal - discountAmt;
    const gst = state.isComplimentary ? 0 : Math.round(afterDiscount * state.settings.gstRate / 100);
    const svcCharge = state.isComplimentary ? 0 : Math.round(afterDiscount * state.settings.serviceCharge / 100);
    const total = afterDiscount + gst + svcCharge;
    const itemCount = state.cart.reduce((s, i) => s + i.qty, 0);

    return { subtotal, discountAmt, afterDiscount, gst, svcCharge, total, itemCount };
}

function addToCart(itemId) {
    const item = MENU_ITEMS.find(i => i.id === itemId);
    if (!item || !item.avail) return;
    playClick();

    // Show customization modal
    const halfPrice = item.halfPrice || Math.round(item.price * 0.6);
    const { el, close } = modal(`
    <h3 class="modal-heading">🍽️ ${item.name}</h3>
    <div class="portion-toggle">
      <button class="portion-btn active" data-portion="full">
        <span class="portion-label">Full</span>
        <span class="portion-price">${fmt(item.price)}</span>
      </button>
      <button class="portion-btn" data-portion="half">
        <span class="portion-label">Half</span>
        <span class="portion-price">${fmt(halfPrice)}</span>
      </button>
    </div>
    <div class="qty-row" style="display:flex;align-items:center;gap:12px;margin:12px 0">
      <span class="form-label" style="margin:0">Qty</span>
      <button class="btn btn-ghost btn-sm" id="qtyMinus">−</button>
      <span id="qtyVal" style="font-weight:700;font-size:16px;min-width:24px;text-align:center">1</span>
      <button class="btn btn-ghost btn-sm" id="qtyPlus">+</button>
    </div>
    <div class="modifier-grid compact">
      ${MODIFIERS.map(m => `
        <div class="mod-option" data-mod="${m.id}">
          <input type="checkbox" value="${m.id}">
          <span class="mod-icon">${m.icon}</span>
          <span class="mod-label">${m.name}</span>
          ${m.price ? `<span class="mod-cost">+₹${m.price}</span>` : '<span class="mod-cost free">FREE</span>'}
        </div>
      `).join('')}
    </div>
    <div class="form-field" style="margin-top:10px">
      <input type="text" id="itemNoteInput" class="input-full" placeholder="Special instructions... (e.g. less oil, extra crispy)">
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="custCancel">Cancel</button>
      <button class="btn btn-primary" id="custAdd">✅ Add to Cart</button>
    </div>
  `);

    let portion = 'full', qty = 1;

    // Portion toggle
    el.querySelectorAll('.portion-btn').forEach(btn => btn.onclick = () => {
        portion = btn.dataset.portion;
        el.querySelectorAll('.portion-btn').forEach(b => b.classList.toggle('active', b === btn));
    });

    // Qty controls
    el.querySelector('#qtyMinus').onclick = () => { if (qty > 1) { qty--; el.querySelector('#qtyVal').textContent = qty; } };
    el.querySelector('#qtyPlus').onclick = () => { qty++; el.querySelector('#qtyVal').textContent = qty; };

    // Modifier toggle styling
    el.querySelectorAll('.mod-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const cb = opt.querySelector('input');
            cb.checked = !cb.checked;
            opt.classList.toggle('active', cb.checked);
        });
    });

    el.querySelector('#custCancel').onclick = close;
    el.querySelector('#custAdd').onclick = () => {
        const selectedMods = Array.from(el.querySelectorAll('input[type=checkbox]:checked')).map(cb => MODIFIERS.find(m => m.id === cb.value)).filter(Boolean);
        const notes = el.querySelector('#itemNoteInput').value.trim();
        const price = portion === 'half' ? halfPrice : item.price;
        const name = portion === 'half' ? `${item.name} (Half)` : item.name;

        // Check if same item + portion + no mods already in cart (and not already sent via KOT)
        const existing = state.cart.find(c => c.id === itemId && c.portionName === name && (!c.modifiers || c.modifiers.length === 0) && selectedMods.length === 0 && !c.kotSent);
        if (existing) {
            existing.qty += qty;
        } else {
            state.cart.push({ ...item, name, price, portionName: name, portion, qty, modifiers: selectedMods, notes });
        }

        close();
        notify(`✅ ${qty}× ${name} added`);
        updateCartUI();
        persistState();
    };
}

function updateCartUI() {
    const panel = document.getElementById('cartItems');
    const summary = document.getElementById('cartSummary');
    const payBtn = document.getElementById('payBtn');
    if (!panel) return;

    if (state.cart.length === 0) {
        panel.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty-icon">🛒</div>
        <div class="cart-empty-text">Tap items to add to order</div>
        <div class="cart-empty-sub">F1 = Search • F2 = Pay • F3 = KDS</div>
      </div>`;
        if (summary) summary.innerHTML = '';
        if (payBtn) payBtn.textContent = '💳 Pay';
        persistState();
        return;
    }

    panel.innerHTML = state.cart.map((item, idx) => {
        const modCost = (item.modifiers || []).reduce((s, m) => s + m.price, 0);
        const lineTotal = (item.price + modCost) * item.qty;
        const sentStyle = item.kotSent ? 'border-left:3px solid var(--ok);opacity:.75' : '';
        return `
      <div class="cart-item" style="${sentStyle}">
        <div class="cart-item-info">
          <div class="cart-item-name-row">
            <span class="cart-item-veg ${item.veg ? 'veg' : 'nonveg'}"></span>
            <span class="cart-item-name">${item.name}</span>
            ${item.kotSent ? '<span style="font-size:.55rem;color:#fff;background:var(--ok);padding:1px 6px;border-radius:8px;margin-left:4px;font-weight:700">✓ KOT</span>' : ''}
          </div>
          ${item.modifiers?.length ? `<div class="cart-item-mods">${item.modifiers.map(m => `<span class="cart-mod-tag">${m.icon} ${m.name}${m.price ? ' +₹' + m.price : ''}</span>`).join('')}</div>` : ''}
          ${item.notes ? `<div class="cart-item-note">📝 ${item.notes}</div>` : ''}
          <div class="cart-item-unit-price">${fmt(item.price)}${modCost ? ' + ₹' + modCost : ''} each</div>
        </div>
        <button class="cart-customize-btn" data-idx="${idx}" title="Customize">✏️</button>
        <div class="cart-item-qty-col">
          <button class="cart-qty-btn minus" data-action="dec" data-idx="${idx}">−</button>
          <span class="cart-qty-value">${item.qty}</span>
          <button class="cart-qty-btn plus" data-action="inc" data-idx="${idx}">+</button>
        </div>
        <div class="cart-item-total">${fmt(lineTotal)}</div>
      </div>`;
    }).join('');

    const t = getCartTotals();
    if (summary) {
        summary.innerHTML = `
      <div class="summary-line"><span>Subtotal (${t.itemCount} items)</span><span>${fmt(t.subtotal)}</span></div>
      ${state.isComplimentary ? `<div class="summary-line discount"><span>🎁 Complimentary</span><span>− 100%</span></div>` : ''}
      ${t.discountAmt > 0 && !state.isComplimentary ? `<div class="summary-line discount"><span>🏷️ ${state.discount.name || 'Discount'}</span><span>− ${fmt(t.discountAmt)}</span></div>` : ''}
      <div class="summary-line"><span>GST @ ${state.settings.gstRate}%</span><span>${fmt(t.gst)}</span></div>
      ${t.svcCharge > 0 ? `<div class="summary-line"><span>Service @ ${state.settings.serviceCharge}%</span><span>${fmt(t.svcCharge)}</span></div>` : ''}
      <div class="summary-line grand-total"><span>Grand Total</span><span>${fmt(t.total)}</span></div>`;
    }
    if (payBtn) payBtn.innerHTML = `💳 Pay ${fmt(t.total)}`;

    // Re-bind cart events
    bindCartItemEvents();
}

function bindCartItemEvents() {
    document.querySelectorAll('.cart-qty-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            if (btn.dataset.action === 'inc') {
                state.cart[idx].qty++;
            } else {
                state.cart[idx].qty--;
                if (state.cart[idx].qty <= 0) {
                    const name = state.cart[idx].name;
                    state.cart.splice(idx, 1);
                    notify(`🗑️ ${name} removed`, 'info');
                }
            }
            updateCartUI();
        };
    });
    document.querySelectorAll('.cart-customize-btn').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); openModifierModal(parseInt(btn.dataset.idx)); };
    });
}

/* ═══════════════════════════════════════════════
   MODALS
   ═══════════════════════════════════════════════ */
function modal(html) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal">${html}</div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const esc = (e) => { if (e.key === 'Escape') { close(); } };
    document.addEventListener('keydown', esc);
    const close = () => { overlay.classList.remove('visible'); document.removeEventListener('keydown', esc); setTimeout(() => overlay.remove(), 200); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    return { el: overlay, close };
}

// ── MODIFIER MODAL ──
function openModifierModal(cartIdx) {
    const item = state.cart[cartIdx];
    if (!item) return;

    const { el, close } = modal(`
    <h3 class="modal-heading">✏️ Customize — ${item.name}</h3>
    <div class="modifier-grid">
      ${MODIFIERS.map(m => `
        <div class="mod-option ${(item.modifiers || []).some(x => x.id === m.id) ? 'active' : ''}" data-mod="${m.id}">
          <input type="checkbox" value="${m.id}" ${(item.modifiers || []).some(x => x.id === m.id) ? 'checked' : ''}>
          <span class="mod-icon">${m.icon}</span>
          <span class="mod-label">${m.name}</span>
          ${m.price ? `<span class="mod-cost">+₹${m.price}</span>` : '<span class="mod-cost free">FREE</span>'}
        </div>
      `).join('')}
    </div>
    <div class="form-field" style="margin-top:14px">
      <label class="form-label">Item Note</label>
      <input type="text" id="modNoteInput" class="input-full" placeholder="e.g. Less oil, extra crispy..." value="${item.notes || ''}">
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="modCancel">Cancel</button>
      <button class="btn btn-primary" id="modSave">✅ Save</button>
    </div>
  `);

    // Toggle styling on click
    el.querySelectorAll('.mod-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const cb = opt.querySelector('input');
            cb.checked = !cb.checked;
            opt.classList.toggle('active', cb.checked);
        });
    });

    el.querySelector('#modCancel').onclick = close;
    el.querySelector('#modSave').onclick = () => {
        const checks = el.querySelectorAll('input[type=checkbox]:checked');
        item.modifiers = Array.from(checks).map(cb => MODIFIERS.find(m => m.id === cb.value)).filter(Boolean);
        item.notes = el.querySelector('#modNoteInput').value.trim();
        close();
        updateCartUI();
        notify('✅ Customization saved');
    };
}

// ── DISCOUNT MODAL ──
function openDiscountModal() {
    if (state.cart.length === 0) { notify('⚠️ Add items first', 'warn'); return; }

    let tab = 'coupon', manualType = 'percent';
    const subtotal = getCartTotals().subtotal;

    const { el, close } = modal(`
    <h3 class="modal-heading">🏷️ Apply Discount</h3>
    <div class="tab-row">
      <button class="tab-btn active" data-tab="coupon">🎟️ Coupon Code</button>
      <button class="tab-btn" data-tab="manual">✍️ Manual</button>
    </div>
    <div id="tabCoupon" class="tab-panel">
      <input type="text" id="couponCodeInput" class="input-full" placeholder="Enter coupon code..." style="text-transform:uppercase">
      <div class="coupon-grid" id="couponGrid">
        ${DISCOUNT_COUPONS.filter(c => c.active).map(c => `
          <div class="coupon-card" data-code="${c.id}">
            <div class="coupon-badge">${c.id}</div>
            <div class="coupon-desc">${c.name}</div>
            <div class="coupon-terms">${c.type === 'percent' ? c.value + '% off (max ₹' + c.maxDiscount + ')' : c.type === 'fixed' ? '₹' + c.value + ' off' : 'Buy 1 Get 1'}${c.minOrder ? ' • Min ₹' + c.minOrder : ''}</div>
          </div>
        `).join('')}
      </div>
    </div>
    <div id="tabManual" class="tab-panel" style="display:none">
      <div class="btn-group">
        <button class="btn btn-sm btn-secondary manual-type active" data-t="percent">% Percentage</button>
        <button class="btn btn-sm btn-secondary manual-type" data-t="fixed">₹ Fixed Amount</button>
      </div>
      <input type="number" id="manualDiscVal" class="input-full" placeholder="Enter value..." min="0" style="margin-top:10px">
      <input type="text" id="manualDiscReason" class="input-full" placeholder="Reason (optional)" style="margin-top:8px">
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="dCancel">Cancel</button>
      ${state.discount.type ? '<button class="btn btn-ghost" id="dRemove" style="color:var(--danger)">Remove</button>' : ''}
      <button class="btn btn-primary" id="dApply">✅ Apply</button>
    </div>
  `);

    // Tab switch
    el.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => {
        tab = b.dataset.tab;
        el.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x === b));
        el.querySelector('#tabCoupon').style.display = tab === 'coupon' ? '' : 'none';
        el.querySelector('#tabManual').style.display = tab === 'manual' ? '' : 'none';
    });

    // Coupon click
    el.querySelectorAll('.coupon-card').forEach(c => c.onclick = () => {
        el.querySelector('#couponCodeInput').value = c.dataset.code;
        el.querySelectorAll('.coupon-card').forEach(x => x.classList.toggle('selected', x === c));
    });

    // Manual type
    el.querySelectorAll('.manual-type').forEach(b => b.onclick = () => {
        manualType = b.dataset.t;
        el.querySelectorAll('.manual-type').forEach(x => x.classList.toggle('active', x === b));
    });

    el.querySelector('#dCancel').onclick = close;
    el.querySelector('#dRemove')?.addEventListener('click', () => {
        state.discount = { type: null, value: 0, code: '', name: '', maxDiscount: 0 };
        state.isComplimentary = false;
        close(); updateCartUI(); notify('🗑️ Discount removed', 'info');
    });

    el.querySelector('#dApply').onclick = () => {
        if (tab === 'coupon') {
            const code = el.querySelector('#couponCodeInput').value.trim().toUpperCase();
            const coupon = DISCOUNT_COUPONS.find(c => c.id === code && c.active);
            if (!coupon) { notify('❌ Invalid coupon code', 'error'); return; }
            if (subtotal < coupon.minOrder) { notify(`⚠️ Min order ₹${coupon.minOrder} required`, 'warn'); return; }
            state.discount = { type: coupon.type, value: coupon.value, code: coupon.id, name: coupon.name, maxDiscount: coupon.maxDiscount };
        } else {
            const val = parseFloat(el.querySelector('#manualDiscVal').value);
            if (!val || val <= 0) { notify('⚠️ Enter a valid value', 'warn'); return; }
            state.discount = { type: manualType, value: val, code: '', name: el.querySelector('#manualDiscReason').value || 'Manual discount', maxDiscount: manualType === 'percent' ? 99999 : val };
        }
        state.isComplimentary = false;
        close(); updateCartUI(); notify('🏷️ Discount applied!');
    };
}

// ── CUSTOMER ATTACH MODAL ──
function openCustomerModal() {
    const { el, close } = modal(`
    <h3 class="modal-heading">👤 Attach Customer</h3>
    <input type="text" id="custSearch" class="input-full" placeholder="🔍 Search by name or phone...">
    <div class="customer-list" id="custList">
      ${CUSTOMERS.map(c => `
        <div class="cust-row ${state.attachedCustomer?.id === c.id ? 'selected' : ''}" data-cid="${c.id}">
          <div class="cust-avatar">${c.name.split(' ').map(n => n[0]).join('')}</div>
          <div class="cust-info">
            <div class="cust-name">${c.name}</div>
            <div class="cust-meta">📞 ${c.phone} · ${c.orders} orders · ${fmt(c.spent)} spent</div>
          </div>
          <span class="loyalty-badge ${c.loyalty}">${c.loyalty}</span>
        </div>
      `).join('')}
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="ccCancel">Cancel</button>
      ${state.attachedCustomer ? '<button class="btn btn-ghost" id="ccDetach" style="color:var(--danger)">Detach</button>' : ''}
    </div>
  `);

    el.querySelector('#custSearch').addEventListener('input', function () {
        const q = this.value.toLowerCase();
        el.querySelectorAll('.cust-row').forEach(r => r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none');
    });

    el.querySelectorAll('.cust-row').forEach(r => r.onclick = () => {
        state.attachedCustomer = CUSTOMERS.find(c => c.id === parseInt(r.dataset.cid));
        close(); renderScreen(); notify(`👤 ${state.attachedCustomer.name} attached`);
    });

    el.querySelector('#ccCancel').onclick = close;
    el.querySelector('#ccDetach')?.addEventListener('click', () => {
        state.attachedCustomer = null; close(); renderScreen(); notify('👤 Customer detached', 'info');
    });
}

// ── RUNNING ORDERS MODAL ──
function openRunningOrdersModal() {
    const { el, close } = modal(`
    <h3 class="modal-heading">📋 Held Orders (${state.runningOrders.length})</h3>
    ${state.runningOrders.length === 0 ? '<div class="empty-state">No held orders</div>' : `
      <div class="held-list">
        ${state.runningOrders.map((o, i) => `
          <div class="held-item" data-idx="${i}">
            <div class="held-top">
              <span class="held-id">${o.id}</span>
              <span class="held-time">${timeAgo(Date.now() - o.time)} · ${o.type}</span>
            </div>
            <div class="held-items">${o.items.map(x => x.name + ' ×' + x.qty).join(', ')}</div>
            <div class="held-total">${fmt(o.total)}</div>
          </div>
        `).join('')}
      </div>
    `}
    <div class="modal-footer"><button class="btn btn-ghost" id="hClose">Close</button></div>
  `);

    el.querySelector('#hClose').onclick = close;
    el.querySelectorAll('.held-item').forEach(item => item.onclick = () => {
        const idx = parseInt(item.dataset.idx);
        const order = state.runningOrders[idx];
        state.cart = order.items.map(i => ({ ...i }));
        state.orderType = order.type;
        state.selectedTable = order.table;
        state.runningOrders.splice(idx, 1);
        localStorage.setItem('kcb_running', JSON.stringify(state.runningOrders));
        db.saveRunning(state.runningOrders);
        close(); persistState(); renderScreen(); notify('📋 Order restored');
    });
}

// ── PAYMENT MODAL (Petpooja-style) ──
function openPaymentModal() {
    if (state.cart.length === 0) { notify('⚠️ Cart is empty', 'warn'); return; }
    const t = getCartTotals();
    const total = t.total;

    // Quick cash denominations
    const quickAmounts = [total, Math.ceil(total / 100) * 100, Math.ceil(total / 500) * 500, 2000].filter((v, i, a) => a.indexOf(v) === i && v >= total).slice(0, 4);

    const { el, close } = modal(`
    <h3 class="modal-heading">💳 Settle Bill</h3>
    <div class="settle-info-row">
      ${state.selectedTable ? `<span class="settle-tag">🪑 Table ${state.selectedTable}</span>` : ''}
      ${state.attachedCustomer ? `<span class="settle-tag">👤 ${state.attachedCustomer.name}</span>` : ''}
      <span class="settle-tag">${state.orderType === 'dine-in' ? '🍽️ Dine-In' : state.orderType === 'takeaway' ? '🥡 Takeaway' : '🛵 Delivery'}</span>
    </div>
    <div class="settle-total">${fmt(total)}</div>
    ${t.discountAmt > 0 ? `<div class="pay-saved">🎉 You saved ${fmt(t.discountAmt)}!</div>` : ''}

    <div class="pay-methods">
      <div class="pay-method selected" data-m="cash"><span class="pay-icon">💵</span><span>Cash</span></div>
      <div class="pay-method" data-m="card"><span class="pay-icon">💳</span><span>Card</span></div>
      <div class="pay-method" data-m="upi"><span class="pay-icon">📱</span><span>UPI</span></div>
      <div class="pay-method" data-m="split"><span class="pay-icon">✂️</span><span>Split</span></div>
    </div>

    <!-- Cash Fields -->
    <div id="payFields_cash" class="pay-detail-fields">
      <div class="quick-cash-row">
        ${quickAmounts.map(a => `<button class="quick-cash-btn" data-amt="${a}">\u20b9${a.toLocaleString('en-IN')}</button>`).join('')}
      </div>
      <div class="form-field">
        <label class="form-label">Amount Received</label>
        <input type="number" id="cashReceived" class="input-full input-lg" placeholder="Enter amount..." value="${total}">
      </div>
      <div class="change-due-row" id="changeDueRow">
        <span class="change-label">Change Due</span>
        <span class="change-value positive" id="changeValue">\u20b90</span>
      </div>
    </div>

    <!-- Card Fields -->
    <div id="payFields_card" class="pay-detail-fields" style="display:none">
      <div class="form-row">
        <div class="form-field" style="flex:1">
          <label class="form-label">Card Type</label>
          <select id="cardType" class="input-full">
            <option value="visa">Visa</option>
            <option value="master">Mastercard</option>
            <option value="rupay">RuPay</option>
            <option value="amex">Amex</option>
          </select>
        </div>
        <div class="form-field" style="flex:1">
          <label class="form-label">Last 4 Digits <span style="color:var(--text-muted);font-size:11px">(optional)</span></label>
          <input type="text" id="cardLast4" class="input-full" placeholder="XXXX" maxlength="4">
        </div>
      </div>
      <div class="form-field">
        <label class="form-label">Approval / Ref No. <span style="color:var(--text-muted);font-size:11px">(optional)</span></label>
        <input type="text" id="cardRef" class="input-full" placeholder="e.g. 847291">
      </div>
    </div>

    <!-- UPI Fields -->
    <div id="payFields_upi" class="pay-detail-fields" style="display:none">
      <div class="form-field">
        <label class="form-label">UPI Transaction ID <span style="color:var(--text-muted);font-size:11px">(optional)</span></label>
        <input type="text" id="upiRef" class="input-full" placeholder="e.g. 412938475629">
      </div>
      <div class="upi-qr-hint">
        <span>\ud83d\udcf1</span> Scan QR / Check payment on UPI app before confirming
      </div>
    </div>

    <!-- Split Fields -->
    <div id="payFields_split" class="pay-detail-fields" style="display:none">
      <div class="split-total-bar">Total: ${fmt(total)}</div>
      <div class="form-row">
        <div class="form-field" style="flex:1">
          <label class="form-label">\ud83d\udcb5 Cash Amount</label>
          <input type="number" id="splitCash" class="input-full" placeholder="\u20b90" value="0">
        </div>
        <div class="form-field" style="flex:1">
          <label class="form-label">\ud83d\udcb3 Card / UPI Amount</label>
          <input type="number" id="splitOther" class="input-full" placeholder="\u20b90" value="${total}">
        </div>
      </div>
      <div class="split-balance-row" id="splitBalanceRow">
        <span class="split-balance-label">Balance</span>
        <span class="split-balance-value balanced" id="splitBalance">\u20b90 \u2705</span>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" id="payCancel">Cancel</button>
      ${state.selectedTable && state.orderType === 'dine-in' ? '<button class="btn btn-warning" id="payBillPending">\ud83d\udd34 Bill Pending</button>' : ''}
      <button class="btn btn-primary btn-lg" id="payConfirm">\u2705 Settle ${fmt(total)}</button>
    </div>
  `);

    // --- Method switching ---
    const showFields = (method) => {
        ['cash', 'card', 'upi', 'split'].forEach(m => {
            const f = el.querySelector('#payFields_' + m);
            if (f) f.style.display = m === method ? '' : 'none';
        });
    };

    el.querySelectorAll('.pay-method').forEach(m => m.onclick = () => {
        el.querySelectorAll('.pay-method').forEach(x => x.classList.toggle('selected', x === m));
        state.paymentMethod = m.dataset.m;
        showFields(m.dataset.m);
    });

    // --- Cash: change calculation ---
    const cashInput = el.querySelector('#cashReceived');
    const changeVal = el.querySelector('#changeValue');
    const updateChange = () => {
        const received = parseFloat(cashInput?.value) || 0;
        const change = received - total;
        if (changeVal) {
            changeVal.textContent = change >= 0 ? '\u20b9' + change.toLocaleString('en-IN') : '-\u20b9' + Math.abs(change).toLocaleString('en-IN');
            changeVal.className = 'change-value ' + (change >= 0 ? 'positive' : 'negative');
        }
    };
    if (cashInput) { cashInput.oninput = updateChange; updateChange(); }

    // Quick cash buttons
    el.querySelectorAll('.quick-cash-btn').forEach(btn => btn.onclick = () => {
        if (cashInput) { cashInput.value = btn.dataset.amt; updateChange(); }
        el.querySelectorAll('.quick-cash-btn').forEach(b => b.classList.toggle('active', b === btn));
    });

    // --- Split: balance tracking ---
    const splitCash = el.querySelector('#splitCash');
    const splitOther = el.querySelector('#splitOther');
    const splitBalance = el.querySelector('#splitBalance');
    const updateSplit = () => {
        const cash = parseFloat(splitCash?.value) || 0;
        const other = parseFloat(splitOther?.value) || 0;
        const balance = total - cash - other;
        if (splitBalance) {
            if (Math.abs(balance) < 1) {
                splitBalance.textContent = '\u20b90 \u2705';
                splitBalance.className = 'split-balance-value balanced';
            } else if (balance > 0) {
                splitBalance.textContent = '\u20b9' + balance.toLocaleString('en-IN') + ' remaining';
                splitBalance.className = 'split-balance-value negative';
            } else {
                splitBalance.textContent = '\u20b9' + Math.abs(balance).toLocaleString('en-IN') + ' over';
                splitBalance.className = 'split-balance-value negative';
            }
        }
    };
    if (splitCash) splitCash.oninput = updateSplit;
    if (splitOther) splitOther.oninput = updateSplit;

    // --- Cancel ---
    el.querySelector('#payCancel').onclick = () => {
        // If KOT was already sent (kotPayMode), food is in kitchen — set bill-pending
        if (state.kotPayMode && state.selectedTable && state.orderType === 'dine-in') {
            const tbl = TABLES.find(t => t.id === state.selectedTable);
            if (tbl && tbl.status === 'occupied') {
                tbl.status = 'bill-pending';
                persistState();
            }
        }
        state.kotPayMode = false;
        close();
    };

    // --- Bill Pending ---
    el.querySelector('#payBillPending')?.addEventListener('click', () => {
        const pendingTable = state.selectedTable;
        if (pendingTable) {
            const tbl = TABLES.find(t => t.id === pendingTable);
            if (tbl) {
                tbl.status = 'bill-pending';
                // NOTE: tbl.amount is already set by sendKOT — don't add again
            }
        }
        // Keep cart items on table, just close the modal
        state.cart = [];
        state.discount = { type: null, value: 0, code: '', name: '', maxDiscount: 0 };
        state.isComplimentary = false;
        state.orderNote = '';
        state.kotPayMode = false;
        persistState();
        close();
        notify('\ud83d\udd34 Bill pending for Table ' + (pendingTable || ''), 'info');
        renderScreen();
    });

    // --- Confirm Payment ---
    el.querySelector('#payConfirm').onclick = () => {
        if (state.paymentMethod === 'cash') {
            const received = parseFloat(cashInput?.value) || 0;
            if (received < total) { notify('\u26a0\ufe0f Amount received is less than total', 'warn'); return; }
            t.cashReceived = received;
            t.changeGiven = received - total;
        } else if (state.paymentMethod === 'card') {
            t.cardType = el.querySelector('#cardType')?.value || 'visa';
            t.cardLast4 = el.querySelector('#cardLast4')?.value || '';
            t.cardRef = el.querySelector('#cardRef')?.value || '';
        } else if (state.paymentMethod === 'upi') {
            t.upiRef = el.querySelector('#upiRef')?.value || '';
        } else if (state.paymentMethod === 'split') {
            const cash = parseFloat(splitCash?.value) || 0;
            const other = parseFloat(splitOther?.value) || 0;
            if (Math.abs((cash + other) - total) > 1) { notify('\u26a0\ufe0f Split amounts must equal the total', 'warn'); return; }
            t.splitCash = cash;
            t.splitOther = other;
        }
        completeOrder(t);
        close();
        if (state.paymentMethod === 'cash' && t.changeGiven > 0) {
            setTimeout(() => notify('\ud83d\udcb0 Change due: ' + fmt(t.changeGiven), 'info'), 300);
        }
    };
}

/* ═══════════════════════════════════════════════
   ORDER LIFECYCLE
   ═══════════════════════════════════════════════ */
function completeOrder(totals) {
    state.orderCounter++;
    const orderId = state.settings.invoicePrefix + state.orderCounter;

    // Create order record with payment details
    const order = {
        id: orderId,
        items: state.cart.map(i => ({ ...i })),
        subtotal: totals.subtotal,
        discount: totals.discountAmt,
        gst: totals.gst,
        total: totals.total,
        type: state.orderType,
        table: state.selectedTable,
        payment: state.paymentMethod,
        time: Date.now(),
        customer: state.attachedCustomer?.name || null,
        note: state.orderNote,
        isComplimentary: state.isComplimentary,
        status: 'completed',
        // Payment details
        cashReceived: totals.cashReceived || null,
        changeGiven: totals.changeGiven || null,
        cardType: totals.cardType || null,
        cardLast4: totals.cardLast4 || null,
        cardRef: totals.cardRef || null,
        upiRef: totals.upiRef || null,
        splitCash: totals.splitCash || null,
        splitOther: totals.splitOther || null
    };

    // Save to orders
    state.orders.unshift(order);
    if (state.orders.length > 200) state.orders = state.orders.slice(0, 200);
    localStorage.setItem('kcb_orders', JSON.stringify(state.orders));
    localStorage.setItem('kcb_orderCounter', state.orderCounter.toString());
    // D1 sync (fire-and-forget)
    db.saveOrder(order);
    db.saveCounter(state.orderCounter);

    // Send to KDS only if not already sent via sendKOT
    // (If paying from cart directly without KOT, we need a KDS entry)
    const existingKOT = state.kdsOrders.find(k => k.table === state.selectedTable && k.status !== 'done');
    if (!existingKOT) {
        const kdsItems = state.cart.map(i => ({
            name: i.name, qty: i.qty, category: i.category,
            station: getStation(i.category).id,
            modifiers: (i.modifiers || []).map(m => m.name),
            notes: i.notes || '', ready: false
        }));
        state.kdsOrders.unshift({ id: orderId, items: kdsItems, type: state.orderType, table: state.selectedTable, startTime: Date.now(), status: 'new' });
    }

    // Update table status on TABLES
    if (state.selectedTable && state.orderType === 'dine-in') {
        const tbl = TABLES.find(t => t.id === state.selectedTable);
        if (tbl) {
            if (tbl.status === 'bill-pending' || tbl.status === 'printed' || tbl.status === 'paid' || tbl.status === 'occupied') {
                if (!state.kotPayMode) {
                    // Fully settling the table
                    tbl.status = 'available';
                    tbl.guests = 0;
                    tbl.amount = 0;
                    tbl.orderItems = [];
                    tbl.occupiedSince = null;

                    // Remove settled table's items from KDS
                    state.kdsOrders = state.kdsOrders.filter(k => k.table !== state.selectedTable);
                } else if (tbl.status === 'occupied') {
                    // KOT & Pay flow — payment confirmed, table turns blue but food still cooking
                    tbl.status = 'paid';
                }
            } else if (tbl.status === 'available') {
                // Direct pay without KOT (rare) — stay available
                tbl.status = 'available';
            }
        }
    }

    // Reset KOT&Pay mode flag
    state.kotPayMode = false;

    // Reset cart
    resetCart();
    persistState();

    notify(`✅ Order ${orderId} placed — ${fmt(totals.total)}`);
    renderScreen();

    // 🖨️ Print customer bill only if "Save & Print" was clicked
    if (state._printAfterSave) {
        printCustomerBill(order);
    }
    state._printAfterSave = false;
}

// ── Petpooja Handle Save Logic ──
function handleSave(printCustomerBillFlag) {
    if (state.cart.length === 0) { notify('⚠️ Cart is empty', 'warn'); return; }

    // 1. Send KOT if unsent items exist
    const hasUnsent = state.cart.some(i => !i.kotSent);
    if (hasUnsent) {
        state._printKOT = true; // Auto-print KOT if Save is clicked with unsent items
        if (!sendKOT()) return;
    }

    const tbl = TABLES.find(t => t.id === state.selectedTable);

    // 2. Quick Service -> complete the order directly
    if (state.orderType !== 'dine-in') {
        state._printAfterSave = printCustomerBillFlag;
        state.paymentMethod = state.billingPayMethod || 'cash';

        const totals = getCartTotals();
        totals.cashReceived = totals.total; // Assumed exact change for quick save
        totals.changeGiven = 0;

        completeOrder(totals);
        if (state.screen !== 'dashboard') {
            navigate('tables');
        }
        return; // completeOrder handles the rest
    }

    // Force sync table to catch any modified (decreased/removed) items
    if (tbl) {
        tbl.amount = getCartTotals().total;
        tbl.orderItems = state.cart.map(i => JSON.parse(JSON.stringify(i)));
    }

    // 3. Dine-In
    // If Its Paid -> Status becomes 'paid' (BLUE)
    // Else If Save or Save & Print -> Status becomes 'printed' (GREEN)
    if (state.selectedTable) {
        if (tbl) {
            tbl.status = state.itsPaid ? 'paid' : 'printed';
            persistState();
        }

        if (printCustomerBillFlag) {
            state.billCounter++;
            localStorage.setItem('kcb_billCounter', state.billCounter.toString());
            const totals = getCartTotals();
            const billOrder = {
                id: 'BILL-' + state.billCounter,
                items: state.cart,
                subtotal: totals.subtotal, gst: totals.gst, total: totals.total,
                discount: totals.discountAmt, type: state.orderType,
                table: state.selectedTable, payment: 'pending', time: Date.now(),
                customer: state.attachedCustomer?.name, isComplimentary: state.isComplimentary
            };
            printCustomerBill(billOrder);
            notify(`🖨️ Customer Bill printed for Table T${state.selectedTable}`);
        } else {
            notify('✅ Order saved');
        }
    }

    resetCart();
    persistState();
    renderScreen();
    navigate('tables');
}
function sendKOT() {
    if (state.cart.length === 0) { notify('⚠️ Cart is empty', 'warn'); return; }

    // Always force sync table with current cart first! 
    // This ensures if user only MINUSES items, the table is updated correctly.
    if (state.selectedTable && state.orderType === 'dine-in') {
        const tbl = TABLES.find(t => t.id === state.selectedTable);
        if (tbl) {
            if (tbl.status === 'available') {
                tbl.status = state.itsPaid ? 'paid' : 'occupied';
                tbl.guests = tbl.guests || (Math.floor(Math.random() * 4) + 1);
                tbl.occupiedSince = Date.now();
            } else if (state.itsPaid) {
                tbl.status = 'paid';
            }
            // Sync exactly
            tbl.amount = getCartTotals().total;
            tbl.orderItems = state.cart.map(i => JSON.parse(JSON.stringify(i)));
            persistState();
        }
    }

    // Find items that have a higher quantity than what was already sent
    const newItems = state.cart.filter(i => (i.qty > (i.kotSentQty || 0)));
    if (newItems.length === 0) {
        notify('⚠️ Modifcations saved. No new items for kitchen.', 'info');
        return true; // Return true so handleSave/button logic knows it succeeded in saving the table state
    }

    state.kotCounter++;
    localStorage.setItem('kcb_kotCounter', state.kotCounter.toString());
    state.orderCounter++;
    const kotId = 'KOT-' + state.kotCounter;

    // Map kdsItems with only the newly added quantity
    const kdsItems = newItems.map(i => ({
        name: i.name,
        qty: i.qty - (i.kotSentQty || 0), // DELTA QUANTITY
        category: i.category,
        station: getStation(i.category).id,
        modifiers: (i.modifiers || []).map(m => m.name),
        notes: i.notes || '', ready: false
    }));

    const kdsOrder = { id: kotId, items: kdsItems, type: state.orderType, table: state.selectedTable, startTime: Date.now(), status: 'new' };
    state.kdsOrders.unshift(kdsOrder);
    localStorage.setItem('kcb_orderCounter', state.orderCounter.toString());
    db.saveCounter(state.orderCounter);

    // 💾 Store KOT in history (contains only the delta)
    const kotRecord = {
        id: kotId,
        items: [...kdsItems],
        type: state.orderType,
        table: state.selectedTable,
        time: Date.now(),
        status: 'sent'
    };
    state.kotHistory.unshift(kotRecord);
    if (state.kotHistory.length > 500) state.kotHistory = state.kotHistory.slice(0, 500);

    // ✅ Mark ALL cart items as having their current qty fully sent
    state.cart.forEach(i => { i.kotSentQty = i.qty; i.kotSent = true; });

    persistState();
    notify(`🍳 KOT ${kotId} sent to kitchen!`);
    renderScreen();

    // 🖨️ Print KOT slip only if "KOT & Print" was clicked
    if (state._printKOT) {
        printKOTSlip(kotRecord);
    }
    state._printKOT = false;
    return true;
}

// 🍳💳 KOT & Pay — Customer pays upfront, food sent to kitchen, table goes BLUE
function sendKOTAndPay() {
    if (state.cart.length === 0) { notify('⚠️ Cart is empty', 'warn'); return; }
    if (!state.selectedTable || state.orderType !== 'dine-in') {
        notify('⚠️ Select a dine-in table first', 'warn');
        return;
    }

    // Set flag so completeOrder knows to make table blue (paid) after payment
    state.kotPayMode = true;

    // Send KOT to kitchen (table goes occupied/yellow)
    sendKOT();

    // Open payment modal — table will turn blue ONLY if payment is confirmed
    openPaymentModal();
}

function holdOrder() {
    if (state.cart.length === 0) { notify('⚠️ Cart is empty', 'warn'); return; }
    const t = getCartTotals();

    state.runningOrders.push({
        id: 'HOLD-' + uid(),
        items: state.cart.map(i => ({ ...i })),
        total: t.total, type: state.orderType,
        table: state.selectedTable, time: Date.now()
    });
    localStorage.setItem('kcb_running', JSON.stringify(state.runningOrders));
    db.saveRunning(state.runningOrders);

    resetCart();
    persistState();
    notify('⏸️ Order on hold');
    renderScreen();
}

function resetCart() {
    state.cart = [];
    state.selectedTable = null;
    state.discount = { type: null, value: 0, code: '', name: '', maxDiscount: 0 };
    state.isComplimentary = false;
    state.orderNote = '';
    state.attachedCustomer = null;
    state.kotPayMode = false;
    state.itsPaid = false;
}

/* ═══════════════════════════════════════════════
   NAVIGATION & RENDERING
   ═══════════════════════════════════════════════ */
function navigate(screen) {
    // Re-lock settings when navigating away (but NOT when going back to settings from management sub-pages)
    if (state.screen === 'settings' && screen !== 'settings') {
        state._settingsUnlocked = false;
    }
    // Keep settings unlocked when returning from management sub-pages
    const mgmtPages = ['dashboard', 'menu', 'inventory', 'reports', 'crm', 'staff'];
    if (mgmtPages.includes(state.screen) && screen === 'settings') {
        state._settingsUnlocked = true;
    }
    state.screen = screen;
    localStorage.setItem('kcb_screen', screen);
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.screen === screen));

    const titles = {
        dashboard: 'Dashboard', billing: 'Billing & Orders', kds: 'Kitchen Display',
        tables: 'Table Management', menu: 'Menu Management', inventory: 'Inventory',
        reports: 'Reports & Analytics', crm: 'Customers (CRM)',
        staff: 'Staff Management', settings: 'Settings'
    };
    const el = document.getElementById('pageTitle');
    if (el) el.textContent = titles[screen] || 'Dashboard';

    renderScreen();
}
export { navigate };

function renderScreen() {
    const container = document.getElementById('screenContainer');
    if (!container) return;
    container.innerHTML = renderScreenContent(state.screen, state);
    container.style.opacity = '1';
    bindScreenEvents();
}
export { renderScreen };

/* ═══════════════════════════════════════════════
   EVENT BINDINGS PER SCREEN
   ═══════════════════════════════════════════════ */
function bindScreenEvents() {
    const s = state.screen;

    // Universal: animate bars after render
    requestAnimationFrame(() => {
        document.querySelectorAll('.chart-bar').forEach(b => { b.style.height = b.dataset.height + 'px'; });
        document.querySelectorAll('.spark-bar').forEach(b => { b.style.height = b.dataset.h + 'px'; });
        document.querySelectorAll('.top-item-bar').forEach(b => { b.style.width = b.dataset.width + '%'; });
        document.querySelectorAll('.progress-fill').forEach(b => { b.style.width = b.dataset.width + '%'; });
    });

    // Universal: back-to-settings buttons on management sub-pages
    document.querySelectorAll('.back-to-settings-btn').forEach(btn => {
        btn.onclick = () => navigate(btn.dataset.goto);
    });

    if (s === 'dashboard') bindDashboard();
    else if (s === 'billing') bindBilling();
    else if (s === 'kds') bindKDS();
    else if (s === 'tables') bindTables();
    else if (s === 'menu') bindMenu();
    else if (s === 'crm') bindCRM();
    else if (s === 'staff') bindStaff();
    else if (s === 'inventory') bindInventory();
    else if (s === 'reports') bindReports();
    else if (s === 'settings') bindSettings();
}

function bindReports() {

    // Period tabs
    document.querySelectorAll('.report-tab').forEach(t => t.onclick = () => {
        state.reportPeriod = t.dataset.period;
        state._reportWeekDay = 'all'; // reset day filter when switching tabs
        renderScreen();
    });

    // Week day selector
    document.getElementById('reportWeekDaySelect')?.addEventListener('change', (e) => {
        state._reportWeekDay = e.target.value;
        renderScreen();
        // Re-select the value after re-render
        const sel = document.getElementById('reportWeekDaySelect');
        if (sel) sel.value = state._reportWeekDay;
    });

    // Download PDF
    document.getElementById('downloadReportBtn')?.addEventListener('click', () => {
        generateReportPDF();
    });
}

function generateReportPDF() {
    const period = state.reportPeriod || 'today';
    const now = Date.now();
    const DAY = 86400000;
    let periodStart, periodEnd, reportTitle, fileName;

    // Midnight-based boundaries
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
    const yesterdayMidnight = new Date(todayMidnight.getTime() - DAY);
    const dayOfWeek = todayMidnight.getDay();
    const sundayMidnight = new Date(todayMidnight.getTime() - dayOfWeek * DAY);
    const saturdayEnd = new Date(sundayMidnight.getTime() + 7 * DAY - 1);

    if (period === 'month') {
        // Check month selector
        const selectEl = document.getElementById('reportMonthSelect');
        if (selectEl && selectEl.value) {
            const [year, monthIdx] = selectEl.value.split('-').map(Number);
            periodStart = new Date(year, monthIdx, 1).getTime();
            periodEnd = new Date(year, monthIdx + 1, 0, 23, 59, 59, 999).getTime();
            reportTitle = new Date(year, monthIdx).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        } else {
            periodStart = now - 30 * DAY;
            periodEnd = now;
            reportTitle = 'This Month';
        }
        fileName = `KCB-Monthly-Report-${reportTitle.replace(/\s/g, '-')}`;
    } else if (period === 'week') {
        // Check if a specific day is selected
        const weekDaySelect = document.getElementById('reportWeekDaySelect');
        const selectedDay = weekDaySelect?.value || state._reportWeekDay || 'all';
        if (selectedDay !== 'all') {
            const dayIdx = parseInt(selectedDay);
            periodStart = sundayMidnight.getTime() + dayIdx * DAY;
            periodEnd = periodStart + DAY - 1;
            const dayDate = new Date(periodStart);
            const dayName = dayDate.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            reportTitle = `Daily Report — ${dayName}`;
            fileName = `KCB-Day-Report-${dayDate.toISOString().split('T')[0]}`;
        } else {
            periodStart = sundayMidnight.getTime();
            periodEnd = Math.min(saturdayEnd.getTime(), now);
            reportTitle = `Weekly Report — ${sundayMidnight.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} to ${new Date(saturdayEnd).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`;
            fileName = `KCB-Weekly-Report-${new Date().toISOString().split('T')[0]}`;
        }
    } else if (period === 'yesterday') {
        periodStart = yesterdayMidnight.getTime();
        periodEnd = todayMidnight.getTime() - 1;
        reportTitle = `Yesterday’s Report — ${new Date(yesterdayMidnight).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
        fileName = `KCB-Yesterday-Report-${new Date(yesterdayMidnight).toISOString().split('T')[0]}`;
    } else {
        periodStart = todayMidnight.getTime();
        periodEnd = now;
        reportTitle = `Daily Report — ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
        fileName = `KCB-Daily-Report-${new Date().toISOString().split('T')[0]}`;
    }

    // Use real orders + archived report history (same as reports screen)
    let orders = [...(state.orders || [])];
    if (state.reportHistory && Array.isArray(state.reportHistory)) {
        orders = [...orders, ...state.reportHistory];
    }
    // Deduplicate by order ID and validate
    const seen = new Set();
    orders = orders.filter(o => {
        if (!o || !o.id || !o.time || typeof o.time !== 'number') return false;
        if (seen.has(o.id)) return false;
        seen.add(o.id);
        return true;
    });
    orders.sort((a, b) => b.time - a.time);

    const filtered = orders.filter(o => o.time >= periodStart && o.time <= periodEnd);
    const totalRevenue = filtered.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const totalOrders = filtered.length;
    const avgValue = totalOrders ? Math.round(totalRevenue / totalOrders) : 0;
    const totalDiscount = filtered.reduce((s, o) => s + (Number(o.discount) || 0), 0);
    const totalGST = filtered.reduce((s, o) => s + (o.gst || 0), 0);
    const totalSubtotal = filtered.reduce((s, o) => s + (o.subtotal || 0), 0);

    const payMap = {};
    filtered.forEach(o => { const m = o.payment || 'cash'; payMap[m] = (payMap[m] || 0) + (o.total || 0); });
    const itemMap = {};
    filtered.forEach(o => (o.items || []).forEach(i => { itemMap[i.name] = (itemMap[i.name] || 0) + (i.qty || 1); }));
    const topItems = Object.entries(itemMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const maxItemQty = topItems.length ? topItems[0][1] : 1;
    const typeMap = {};
    filtered.forEach(o => { typeMap[o.type || 'dine-in'] = (typeMap[o.type || 'dine-in'] || 0) + 1; });
    const catMap = {};
    filtered.forEach(o => (o.items || []).forEach(i => { catMap[i.category || 'other'] = (catMap[i.category || 'other'] || 0) + (i.price || 0) * (i.qty || 1); }));
    const catEntries = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    const hourCounts = new Array(16).fill(0);
    filtered.forEach(o => { const h = new Date(o.time).getHours(); if (h >= 8 && h <= 23) hourCounts[h - 8]++; });
    const maxHour = Math.max(...hourCounts, 1);

    // ═══ CANVAS ═══
    const canvas = document.createElement('canvas');
    const W = 595, H = 960;
    canvas.width = W * 2; canvas.height = H * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    const M = 36, cW = W - M * 2, F = '-apple-system, sans-serif';

    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

    // ── Header ──
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#e63946'); grad.addColorStop(1, '#d62839');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, 76);
    ctx.fillStyle = '#f5a623'; ctx.fillRect(0, 76, W, 3);

    ctx.fillStyle = '#fff';
    ctx.font = `bold 20px ${F}`; ctx.fillText('KING CHINESE BOWL', M, 26);
    ctx.font = `12px ${F}`; ctx.fillText(reportTitle, M, 44);
    ctx.font = `9px ${F}`; ctx.fillText(`Generated: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`, M, 60);
    ctx.textAlign = 'right';
    ctx.font = `bold 11px ${F}`; ctx.fillText(`${totalOrders} Orders · ${period.toUpperCase()} REPORT`, W - M, 26);
    ctx.font = `bold 18px ${F}`; ctx.fillText(`₹${totalRevenue.toLocaleString()}`, W - M, 50);
    ctx.font = `9px ${F}`; ctx.fillText('Net Revenue', W - M, 64);
    ctx.textAlign = 'left';

    let y = 96;

    const section = (title) => {
        ctx.fillStyle = '#e63946'; ctx.fillRect(M, y, 3, 12);
        ctx.fillStyle = '#333'; ctx.font = `bold 10px ${F}`; ctx.fillText(title, M + 10, y + 10);
        ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(M + ctx.measureText(title).width + 18, y + 6); ctx.lineTo(W - M, y + 6); ctx.stroke();
        y += 20;
    };

    // ── Summary Boxes ──
    section('OVERVIEW');
    const boxW = cW / 5 - 5;
    [
        { l: 'NET REVENUE', v: `₹${totalRevenue.toLocaleString()}`, c: '#e63946' },
        { l: 'ORDERS', v: `${totalOrders}`, c: '#3498db' },
        { l: 'AVG ORDER', v: `₹${avgValue.toLocaleString()}`, c: '#f5a623' },
        { l: 'GST', v: `₹${totalGST.toLocaleString()}`, c: '#2ecc71' },
        { l: 'DISCOUNTS', v: `₹${totalDiscount.toLocaleString()}`, c: '#9b59b6' },
    ].forEach((d, i) => {
        const x = M + i * (boxW + 6);
        ctx.fillStyle = '#f8f9fa'; ctx.beginPath(); ctx.roundRect(x, y, boxW, 44, 5); ctx.fill();
        ctx.fillStyle = d.c; ctx.fillRect(x, y, 3, 44);
        ctx.font = `bold 13px ${F}`; ctx.fillText(d.v, x + 10, y + 18);
        ctx.fillStyle = '#999'; ctx.font = `7px ${F}`; ctx.fillText(d.l, x + 10, y + 32);
    });
    y += 58;

    // ── Financial ──
    section('FINANCIAL BREAKDOWN');
    [
        ['Gross Revenue (Subtotal)', `₹${totalSubtotal.toLocaleString()}`, '#333', false],
        ['Discounts', `- ₹${totalDiscount.toLocaleString()}`, '#dc2626', false],
        ['Net Revenue', `₹${totalRevenue.toLocaleString()}`, '#333', true],
        [`GST @ ${state.settings?.gstRate ?? 5}%`, `₹${totalGST.toLocaleString()}`, '#888', false],
        ['Revenue After GST', `₹${(totalRevenue - totalGST).toLocaleString()}`, '#e63946', true],
    ].forEach(([lbl, val, col, bold], i) => {
        const last = i === 4;
        ctx.fillStyle = last ? '#fef2f2' : i % 2 === 0 ? '#f9fafb' : '#fff';
        ctx.fillRect(M, y, cW, 18);
        if (last) { ctx.strokeStyle = '#e63946'; ctx.lineWidth = 0.8; ctx.strokeRect(M, y, cW, 18); }
        ctx.fillStyle = col; ctx.font = `${bold ? 'bold ' : ''}9px ${F}`; ctx.fillText(lbl, M + 8, y + 12);
        ctx.textAlign = 'right'; ctx.fillText(val, W - M - 8, y + 12); ctx.textAlign = 'left';
        y += 18;
    });
    y += 12;

    // ── Top Items ──
    section('TOP SELLING ITEMS');
    topItems.slice(0, 8).forEach(([name, count], i) => {
        const barW = Math.round(count / maxItemQty * 100);
        ctx.fillStyle = i % 2 === 0 ? '#f9fafb' : '#fff'; ctx.fillRect(M, y, cW, 16);
        ctx.fillStyle = '#555'; ctx.font = `9px ${F}`; ctx.fillText(`${i + 1}.  ${name}`, M + 8, y + 11);
        ctx.fillStyle = '#e6394622'; ctx.beginPath(); ctx.roundRect(W - M - 170, y + 3, 100, 9, 3); ctx.fill();
        ctx.fillStyle = '#e63946'; ctx.beginPath(); ctx.roundRect(W - M - 170, y + 3, barW, 9, 3); ctx.fill();
        ctx.font = `bold 8px ${F}`; ctx.textAlign = 'right'; ctx.fillText(`${count}`, W - M - 8, y + 11); ctx.textAlign = 'left';
        y += 16;
    });
    y += 12;

    // ── Payment + Orders side by side ──
    section('PAYMENT & ORDER ANALYSIS');
    const colW = (cW - 14) / 2;
    const sY = y;
    ctx.fillStyle = '#666'; ctx.font = `bold 7px ${F}`; ctx.fillText('PAYMENT METHODS', M, y + 7); y += 14;
    Object.entries(payMap).sort((a, b) => b[1] - a[1]).forEach(([m, amt]) => {
        const pct = totalRevenue ? Math.round(amt / totalRevenue * 100) : 0;
        ctx.fillStyle = '#f9fafb'; ctx.fillRect(M, y, colW, 15);
        ctx.fillStyle = '#555'; ctx.font = `9px ${F}`; ctx.fillText(m.charAt(0).toUpperCase() + m.slice(1), M + 8, y + 10);
        ctx.textAlign = 'right'; ctx.fillStyle = '#333'; ctx.font = `bold 8px ${F}`; ctx.fillText(`${pct}% · ₹${amt.toLocaleString()}`, M + colW - 6, y + 10); ctx.textAlign = 'left';
        y += 15;
    });
    let rY = sY;
    ctx.fillStyle = '#666'; ctx.font = `bold 7px ${F}`; ctx.fillText('ORDER TYPES', M + colW + 14, rY + 7); rY += 14;
    Object.entries(typeMap).forEach(([type, cnt]) => {
        const pct = totalOrders ? Math.round(cnt / totalOrders * 100) : 0;
        ctx.fillStyle = '#f9fafb'; ctx.fillRect(M + colW + 14, rY, colW, 15);
        ctx.fillStyle = '#555'; ctx.font = `9px ${F}`; ctx.fillText(type === 'dine-in' ? 'Dine-In' : type.charAt(0).toUpperCase() + type.slice(1), M + colW + 22, rY + 10);
        ctx.textAlign = 'right'; ctx.fillStyle = '#333'; ctx.font = `bold 8px ${F}`; ctx.fillText(`${cnt} (${pct}%)`, W - M - 6, rY + 10); ctx.textAlign = 'left';
        rY += 15;
    });
    y = Math.max(y, rY) + 12;

    // ── Category Revenue ──
    if (y < H - 120 && catEntries.length > 0) {
        section('CATEGORY REVENUE');
        const catColors = ['#e63946', '#f5a623', '#3498db', '#2ecc71', '#9b59b6', '#e67e22'];
        const maxCat = catEntries[0][1];
        catEntries.slice(0, 6).forEach(([cat, rev], i) => {
            const catName = CATEGORIES.find(c => c.id === cat)?.name || cat;
            const barW = Math.round(rev / maxCat * 100);
            ctx.fillStyle = i % 2 === 0 ? '#f9fafb' : '#fff'; ctx.fillRect(M, y, cW, 15);
            ctx.fillStyle = '#555'; ctx.font = `9px ${F}`; ctx.fillText(catName, M + 8, y + 10);
            ctx.fillStyle = catColors[i % catColors.length] + '22'; ctx.beginPath(); ctx.roundRect(W - M - 170, y + 3, 100, 8, 3); ctx.fill();
            ctx.fillStyle = catColors[i % catColors.length]; ctx.beginPath(); ctx.roundRect(W - M - 170, y + 3, barW, 8, 3); ctx.fill();
            ctx.textAlign = 'right'; ctx.font = `bold 8px ${F}`; ctx.fillText(`₹${rev.toLocaleString()}`, W - M - 8, y + 10); ctx.textAlign = 'left';
            y += 15;
        });
        y += 12;
    }

    // ── Peak Hours ──
    if (y < H - 80) {
        section('PEAK HOURS (8AM – 11PM)');
        const cellW = cW / 16;
        hourCounts.forEach((c, i) => {
            const x = M + i * cellW;
            const intensity = c / maxHour;
            ctx.fillStyle = intensity > 0.7 ? '#e63946' : intensity > 0.4 ? '#f5a623' : intensity > 0 ? '#e0e0e0' : '#f5f5f5';
            ctx.beginPath(); ctx.roundRect(x + 1, y, cellW - 2, 22, 3); ctx.fill();
            ctx.fillStyle = intensity > 0.4 ? '#fff' : '#888';
            ctx.font = `bold 7px ${F}`; ctx.textAlign = 'center';
            ctx.fillText(`${(i + 8) > 12 ? (i + 8) - 12 : (i + 8)}${(i + 8) >= 12 ? 'p' : 'a'}`, x + cellW / 2, y + 9);
            ctx.fillText(c, x + cellW / 2, y + 18);
            ctx.textAlign = 'left';
        });
    }

    // ── Footer ──
    ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, H - 28, W, 28);
    ctx.fillStyle = '#999'; ctx.font = `7px ${F}`; ctx.textAlign = 'center';
    ctx.fillText(`King Chinese Bowl POS · ${reportTitle} · Confidential · ${totalOrders} orders · Generated ${new Date().toLocaleTimeString('en-IN')}`, W / 2, H - 10);
    ctx.textAlign = 'left';

    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${fileName}.png`; a.click();
        URL.revokeObjectURL(url);
        notify(`📄 ${period === 'today' ? 'Daily' : period === 'yesterday' ? 'Yesterday\'s' : period === 'week' ? 'Weekly' : 'Monthly'} report downloaded`);
    }, 'image/png');
}

function bindDashboard() {
    document.querySelectorAll('.quick-action-btn').forEach(b => b.onclick = () => navigate(b.dataset.goto));

    // ── All Orders Modal ──
    const viewMoreBtn = document.getElementById('dashboardViewMoreBtn');
    const modal = document.getElementById('allOrdersModal');
    const closeBtn = document.getElementById('closeAllOrdersModal');
    if (viewMoreBtn && modal) viewMoreBtn.onclick = () => { modal.style.display = 'block'; };
    if (closeBtn && modal) closeBtn.onclick = () => { modal.style.display = 'none'; };

    // Search + Filter
    let activeFilter = 'all';
    const searchInput = document.getElementById('allOrdersSearch');
    const rows = document.querySelectorAll('.ao-row');

    function applyFilters() {
        const q = (searchInput?.value || '').toLowerCase().trim();
        rows.forEach(r => {
            const matchType = activeFilter === 'all' || r.dataset.type === activeFilter;
            const matchSearch = !q || (r.dataset.search || '').includes(q);
            r.style.display = (matchType && matchSearch) ? 'flex' : 'none';
        });
    }

    if (searchInput) {
        searchInput.oninput = applyFilters;
    }

    document.querySelectorAll('.ao-filter').forEach(btn => {
        btn.onclick = () => {
            activeFilter = btn.dataset.filter;
            document.querySelectorAll('.ao-filter').forEach(b => {
                const isActive = b.dataset.filter === activeFilter;
                b.style.background = isActive ? 'var(--brand-gold)' : 'var(--bg-tertiary)';
                b.style.color = isActive ? '#000' : 'var(--text-primary)';
            });
            applyFilters();
        };
    });

    // ── Real-time auto-refresh every 15s (skip if modal is open) ──
    if (state._dashboardTimer) clearInterval(state._dashboardTimer);
    let lastOrderCount = (state.orders || []).length;
    let lastTotal = (state.orders || []).reduce((s, o) => s + (Number(o.total) || 0), 0);
    state._dashboardTimer = setInterval(() => {
        if (state.screen !== 'dashboard') { clearInterval(state._dashboardTimer); state._dashboardTimer = null; return; }
        // Don't refresh while modal is open
        if (modal && modal.style.display !== 'none') return;
        const curCount = (state.orders || []).length;
        const curTotal = (state.orders || []).reduce((s, o) => s + (Number(o.total) || 0), 0);
        if (curCount !== lastOrderCount || curTotal !== lastTotal) {
            lastOrderCount = curCount; lastTotal = curTotal;
            const container = document.getElementById('screenContainer');
            if (container) {
                container.innerHTML = renderScreenContent(state.screen, state);
                bindDashboard();
                requestAnimationFrame(() => {
                    document.querySelectorAll('.chart-bar').forEach(b => { b.style.height = b.dataset.height + 'px'; });
                    document.querySelectorAll('.spark-bar').forEach(b => { b.style.height = b.dataset.h + 'px'; });
                    document.querySelectorAll('.top-item-bar').forEach(b => { b.style.width = b.dataset.width + '%'; });
                });
            }
        }
    }, 15000);
}

function bindBilling() {
    // Categories
    document.querySelectorAll('.cat-tab').forEach(t => t.onclick = () => {
        state.selectedCategory = t.dataset.cat; renderMenuOnly();
        document.querySelectorAll('.cat-tab').forEach(x => x.classList.toggle('active', x.dataset.cat === state.selectedCategory));
    });

    // Veg filter
    document.querySelectorAll('.filter-btn').forEach(b => b.onclick = () => {
        state.vegFilter = b.dataset.filter; renderMenuOnly();
        document.querySelectorAll('.filter-btn').forEach(x => x.classList.toggle('active', x.dataset.filter === state.vegFilter));
    });

    // Search (debounced — waits 150ms after typing stops)
    const search = document.getElementById('menuSearch');
    if (search) {
        search.value = state.searchQuery;
        const _debouncedSearch = debounce(() => { state.searchQuery = search.value; renderMenuOnly(); }, 150);
        search.oninput = _debouncedSearch;
        if (!state.cart.length) search.focus();
    }

    // Menu items — event delegation (one listener instead of 164)
    const menuGrid = document.getElementById('menuGrid');
    if (menuGrid) menuGrid.onclick = (e) => {
        const card = e.target.closest('.menu-card:not(.out)');
        if (card) addToCart(card.dataset.id);
    };

    // Order type
    document.querySelectorAll('.type-btn').forEach(b => b.onclick = () => {
        state.orderType = b.dataset.type;
        document.querySelectorAll('.type-btn').forEach(x => x.classList.toggle('active', x.dataset.type === state.orderType));
        persistState();
    });

    // Cart items
    bindCartItemEvents();

    // Action bar buttons
    document.getElementById('discountBtn')?.addEventListener('click', openDiscountModal);
    document.getElementById('compBtn')?.addEventListener('click', () => {
        state.isComplimentary = !state.isComplimentary;
        if (state.isComplimentary) { state.discount = { type: null, value: 0, code: '', name: '', maxDiscount: 0 }; notify('🎁 Complimentary ON', 'info'); }
        else notify('🎁 Complimentary OFF', 'info');
        updateCartUI();
    });
    document.getElementById('noteBtn')?.addEventListener('click', () => {
        const note = prompt('Order Note / Special Instructions:', state.orderNote);
        if (note !== null) { state.orderNote = note; notify('📝 Note saved'); }
    });
    document.getElementById('custBtn')?.addEventListener('click', openCustomerModal);
    document.getElementById('heldBtn')?.addEventListener('click', openRunningOrdersModal);

    // Trash icon — clear current cart
    document.getElementById('clearCart')?.addEventListener('click', () => {
        if (!state.cart.length) return;
        if (confirm('Clear all items from cart?')) { resetCart(); persistState(); renderScreen(); notify('🗑️ Cart cleared', 'info'); }
    });

    // Split button
    document.getElementById('splitBtn')?.addEventListener('click', () => {
        notify('🪓 Split bill feature coming soon...', 'info');
    });

    // Payment method chips
    document.querySelectorAll('.pay-method-chip').forEach(chip => {
        chip.onclick = () => {
            state.billingPayMethod = chip.querySelector('input').value;
            document.querySelectorAll('.pay-method-chip').forEach(c => c.classList.toggle('active', c.querySelector('input').value === state.billingPayMethod));
        };
    });

    // It's Paid checkbox
    document.getElementById('itsPaidCheck')?.addEventListener('change', (e) => {
        state.itsPaid = e.target.checked;
    });

    // Bottom actions — 5 buttons
    document.getElementById('holdBtn')?.addEventListener('click', holdOrder);

    // Save = auto-print KOT if unsent, save order, DO NOT open payment modal (unless rapid Quick Service)
    document.getElementById('saveBtn')?.addEventListener('click', () => {
        handleSave(false);
    });
    // Save & Print = auto-print KOT if unsent, save order, PRINT customer bill, table becomes GREEN
    document.getElementById('savePrintBtn')?.addEventListener('click', () => {
        handleSave(true);
    });
    // KOT = send to kitchen (no print)
    document.getElementById('kotBtn')?.addEventListener('click', () => {
        state._printKOT = false;
        if (sendKOT()) {
            resetCart();
            persistState();
            renderScreen();
            navigate('tables');
        }
    });
    // KOT & Print = send to kitchen + print KOT slip
    document.getElementById('kotPrintBtn')?.addEventListener('click', () => {
        state._printKOT = true;
        if (sendKOT()) {
            resetCart();
            persistState();
            renderScreen();
            navigate('tables');
        }
    });

    // Print Last Bill
    document.getElementById('printLastBillBtn')?.addEventListener('click', () => {
        if (state.orders.length === 0) { notify('⚠️ No bills to print', 'warn'); return; }
        reprintBill(state.orders[0].id);
        notify('🖨️ Printing last bill...');
    });
}

// ── Pre-built search index for fast filtering ──
const _menuSearchIndex = MENU_ITEMS.map(i => ({ ...i, _lc: i.name.toLowerCase() }));

function renderMenuOnly() {
    const grid = document.getElementById('menuGrid');
    if (!grid) return;

    const cat = state.selectedCategory;
    const vf = state.vegFilter;
    const q = state.searchQuery ? state.searchQuery.toLowerCase() : '';

    const items = _menuSearchIndex.filter(i => {
        if (cat !== 'all' && i.category !== cat) return false;
        if (vf === 'veg' && !i.veg) return false;
        if (vf === 'nonveg' && i.veg) return false;
        if (q && !i._lc.includes(q)) return false;
        return true;
    });

    // Build HTML in one string (faster than DOM manipulation for this size)
    const parts = [];
    for (let j = 0; j < items.length; j++) {
        const item = items[j];
        parts.push(`<div class="menu-card${item.avail ? '' : ' out'}" data-id="${item.id}"><span class="mc-veg ${item.veg ? 'veg' : 'nonveg'}"></span><div class="mc-name">${item.name}</div><div class="mc-price">${fmt(item.price)}</div>${item.spice ? `<div class="mc-spice">${spice(item.spice)}</div>` : ''}<div class="mc-tags">${item.tags.map(t => `<span class="mc-tag ${t}">${t.replace('-', ' ')}</span>`).join('')}</div>${item.avail ? '' : '<div class="mc-out">OUT OF STOCK</div>'}</div>`);
    }
    grid.innerHTML = parts.join('');
    // No per-item onclick needed — event delegation handles clicks
}

function bindKDS() {
    document.querySelectorAll('.kds-station-btn').forEach(b => b.onclick = () => { state.kdsStation = b.dataset.station; renderScreen(); });

    // Item-level ready
    document.querySelectorAll('.kds-item-check').forEach(btn => btn.onclick = (e) => {
        e.stopPropagation();
        const oi = parseInt(btn.dataset.oi), ii = parseInt(btn.dataset.ii);
        const order = state.kdsOrders[oi];
        if (!order?.items[ii]) return;
        order.items[ii].ready = !order.items[ii].ready;
        if (order.items.every(i => i.ready)) order.status = 'ready';
        persistState();
        renderScreen();
    });

    // Mark ready
    document.querySelectorAll('.kds-ready').forEach(b => b.onclick = () => {
        const idx = parseInt(b.dataset.idx);
        if (state.kdsOrders[idx]) { state.kdsOrders[idx].status = 'ready'; state.kdsOrders[idx].items.forEach(i => i.ready = true); persistState(); renderScreen(); notify('✅ Order ready!'); }
    });

    // Bump
    document.querySelectorAll('.kds-bump').forEach(b => b.onclick = () => {
        const idx = parseInt(b.dataset.idx);
        if (state.kdsOrders[idx]) {
            // Only transition occupied tables to bill-pending
            // Skip 'paid' tables — they're already paid, just mark order done
            const order = state.kdsOrders[idx];
            if (order.table) {
                const tbl = TABLES.find(t => t.id === order.table);
                if (tbl && tbl.status === 'occupied') {
                    // Check if there are other active KDS orders for this table
                    const otherActiveOrders = state.kdsOrders.filter((o, i) => i !== idx && o.table === order.table && o.status !== 'done');
                    if (otherActiveOrders.length === 0) {
                        tbl.status = 'bill-pending';
                    }
                }
                // 'paid' tables stay as 'paid' — manually made available later
            }
            state.kdsOrders[idx].status = 'done';
            persistState(); renderScreen(); notify('✅ Order served!');
        }
    });

    // Recall
    document.querySelectorAll('.kds-recall').forEach(b => b.onclick = () => {
        const idx = parseInt(b.dataset.idx);
        if (state.kdsOrders[idx]) { state.kdsOrders[idx].status = 'new'; state.kdsOrders[idx].items.forEach(i => i.ready = false); persistState(); renderScreen(); notify('↩ Order recalled', 'info'); }
    });
}

function bindTables() {
    // Click table to select and go to billing
    document.querySelectorAll('.table-cell').forEach(c => c.onclick = (e) => {
        // Don't navigate if clicking the action icons
        if (e.target.closest('.table-icon-btn')) return;
        const tableId = parseInt(c.dataset.table);
        const tbl = TABLES.find(t => t.id === tableId);
        state.selectedTable = tableId;
        state.orderType = 'dine-in';

        // If table has stored items (occupied, bill-pending, or paid), load them into cart
        if (tbl && tbl.orderItems && tbl.orderItems.length > 0 && (tbl.status === 'bill-pending' || tbl.status === 'occupied' || tbl.status === 'paid')) {
            // Deep copy items and ensure KOT tracking is preserved
            state.cart = JSON.parse(JSON.stringify(tbl.orderItems));
            state.cart.forEach(i => {
                i.kotSent = true;
                if (typeof i.kotSentQty === 'undefined') i.kotSentQty = i.qty;
            });
            notify(`🪑 Table ${tableId} — ₹${(tbl.amount || 0).toLocaleString('en-IN')} loaded`);
            persistState();
            navigate('billing');
        } else {
            // New/empty table — clear any leftover cart from previous table
            state.cart = [];
            state.discount = { type: null, value: 0, code: '', name: '', maxDiscount: 0 };
            state.isComplimentary = false;
            state.orderNote = '';
            notify(`🪑 Table ${state.selectedTable} selected`);
            persistState();
            navigate('billing');
        }
    });

    // ✏️ Edit Tables modal
    document.getElementById('editTablesBtn')?.addEventListener('click', () => {
        const buildTableList = () => TABLES.map(t => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:${t.status !== 'available' ? 'rgba(245,158,11,.08)' : 'var(--bg-secondary)'};border-radius:8px;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="font-weight:800;font-size:1rem;">T${t.id}</span>
                    <span style="font-size:.75rem;font-weight:600;color:${t.status === 'available' ? 'var(--ok)' : '#92400e'};text-transform:uppercase;">${t.status}</span>
                </div>
                ${t.status === 'available' ? `<button class="btn btn-sm" style="background:#dc2626;color:#fff;border:none;font-size:.7rem;padding:4px 12px;border-radius:6px;cursor:pointer;" data-modal-delete-table="${t.id}">🗑️ Delete</button>` : `<span style="font-size:.7rem;color:var(--text-m);">In use</span>`}
            </div>
        `).join('');

        const m = modal(`
            <div class="modal-header"><h3>✏️ Edit Tables</h3><button class="modal-close" id="closeEditTablesModal">✕</button></div>
            <div class="modal-body">
                <div style="max-height:400px;overflow-y:auto;margin-bottom:14px;" id="editTablesList">
                    ${buildTableList()}
                </div>
                <button class="btn btn-primary" id="modalAddTableBtn" style="width:100%;">+ Add New Table</button>
            </div>
        `);

        document.getElementById('closeEditTablesModal')?.addEventListener('click', () => { m.close(); renderScreen(); });

        // Bind add button
        document.getElementById('modalAddTableBtn')?.addEventListener('click', () => {
            const maxId = TABLES.length > 0 ? Math.max(...TABLES.map(t => t.id)) : 0;
            TABLES.push({ id: maxId + 1, status: 'available', guests: 0, amount: 0, occupiedSince: null, orderItems: [] });
            localStorage.setItem('kcb_tables', JSON.stringify(TABLES));
            document.getElementById('editTablesList').innerHTML = buildTableList();
            bindModalDeleteBtns();
            notify(`🪑 Table T${maxId + 1} added`);
        });

        function bindModalDeleteBtns() {
            document.querySelectorAll('[data-modal-delete-table]').forEach(b => {
                b.onclick = () => {
                    const tableId = parseInt(b.dataset.modalDeleteTable);
                    const tbl = TABLES.find(t => t.id === tableId);
                    if (!tbl || tbl.status !== 'available') { notify('❌ Cannot delete an occupied table', 'error'); return; }
                    const idx = TABLES.indexOf(tbl);
                    if (idx > -1) TABLES.splice(idx, 1);
                    localStorage.setItem('kcb_tables', JSON.stringify(TABLES));
                    document.getElementById('editTablesList').innerHTML = buildTableList();
                    bindModalDeleteBtns();
                    notify(`🗑️ Table T${tableId} deleted`);
                };
            });
        }
        bindModalDeleteBtns();
    });

    // 👁️ View Order (eye icon) — go to billing with this table's items
    document.querySelectorAll('.table-view-btn').forEach(b => b.onclick = (e) => {
        e.stopPropagation();
        const tableId = parseInt(b.dataset.tableId);
        const tbl = TABLES.find(t => t.id === tableId);
        state.selectedTable = tableId;
        state.orderType = 'dine-in';
        if (tbl && tbl.orderItems && tbl.orderItems.length > 0) {
            state.cart = JSON.parse(JSON.stringify(tbl.orderItems));
            state.cart.forEach(i => {
                i.kotSent = true;
                if (typeof i.kotSentQty === 'undefined') i.kotSentQty = i.qty;
            });
            notify(`🪑 Table ${tableId} — ₹${(tbl.amount || 0).toLocaleString('en-IN')} loaded`);
        } else {
            state.cart = [];
            state.discount = { type: null, value: 0, code: '', name: '', maxDiscount: 0 };
            state.isComplimentary = false;
            state.orderNote = '';
        }
        persistState();
        navigate('billing');
    });

    // 🖨️ Print Bill → table becomes "printed" (green)
    document.querySelectorAll('.table-print-btn').forEach(b => b.onclick = (e) => {
        e.stopPropagation();
        const tableId = parseInt(b.dataset.tableId);
        const tbl = TABLES.find(t => t.id === tableId);
        if (!tbl || !tbl.orderItems || tbl.orderItems.length === 0) {
            notify('⚠️ No items on this table to print', 'warn');
            return;
        }
        // Build order and print
        const subtotal = tbl.orderItems.reduce((sum, item) => {
            const modCost = (item.modifiers || []).reduce((s, m) => s + m.price, 0);
            return sum + (item.price + modCost) * item.qty;
        }, 0);
        const gstRate = state.settings.gstRate ?? 5;
        const gst = Math.round(subtotal * gstRate / 100);
        const total = subtotal + gst;
        const order = {
            id: 'T' + tableId + '-' + uid(),
            items: tbl.orderItems,
            subtotal, gst, total,
            discount: 0, type: 'dine-in', table: tableId,
            payment: 'pending', time: Date.now(),
            customer: null, isComplimentary: false
        };
        printCustomerBill(order);
        // Change table to "printed" (green)
        tbl.status = 'printed';
        persistState();
        renderScreen();
        notify(`🖨️ Bill printed — Table T${tableId} is now green`);
    });

    // 💰 Settle button on green (printed) tables → Petpooja-style settle modal
    document.querySelectorAll('.table-settle-btn').forEach(b => b.onclick = (e) => {
        e.stopPropagation();
        const tableId = parseInt(b.dataset.tableId);
        openSettleModal(tableId);
    });

    // Click on printed table itself → also opens settle modal
    document.querySelectorAll('.table-cell.printed').forEach(c => {
        const origClick = c.onclick;
        c.onclick = (e) => {
            if (e.target.closest('.table-icon-btn')) return;
            openSettleModal(parseInt(c.dataset.table));
        };
    });
}

// ═══════════════════════════════════════════════
// SETTLE & SAVE MODAL (Petpooja-style)
// ═══════════════════════════════════════════════
function openSettleModal(tableId) {
    const tbl = TABLES.find(t => t.id === tableId);
    if (!tbl) return;

    const subtotal = (tbl.orderItems || []).reduce((sum, item) => {
        const modCost = (item.modifiers || []).reduce((s, m) => s + m.price, 0);
        return sum + (item.price + modCost) * item.qty;
    }, 0);
    const gstRate = state.settings.gstRate ?? 5;
    const gst = Math.round(subtotal * gstRate / 100);
    const total = subtotal + gst;

    const { el, close } = modal(`
    <h3 class="modal-heading">Settle & Save For - T${tableId} [₹${total.toLocaleString('en-IN')}]</h3>
    <div class="settle-section">
      <label class="settle-label">Payment Type</label>
      <div class="settle-radio-row">
        <label class="settle-radio"><input type="radio" name="settlePayment" value="not-paid"> Not Paid</label>
        <label class="settle-radio"><input type="radio" name="settlePayment" value="cash" checked> Cash</label>
        <label class="settle-radio"><input type="radio" name="settlePayment" value="card"> Card</label>
        <label class="settle-radio"><input type="radio" name="settlePayment" value="due"> Due</label>
        <label class="settle-radio"><input type="radio" name="settlePayment" value="upi"> UPI</label>
        <label class="settle-radio"><input type="radio" name="settlePayment" value="part"> Part</label>
      </div>
    </div>
    <div class="settle-fields">
      <div class="settle-field-row">
        <label>Customer Paid</label>
        <input type="number" id="settlePaid" class="input-full" value="${total}" min="0">
      </div>
      <div class="settle-field-row">
        <label>Return to Customer</label>
        <input type="number" id="settleReturn" class="input-full" value="0" readonly>
      </div>
      <div class="settle-field-row">
        <label>Tip</label>
        <input type="number" id="settleTip" class="input-full" value="0" min="0">
      </div>
      <div class="settle-field-row settle-total-row">
        <label>Settlement Amount</label>
        <strong id="settleAmount">₹${total.toLocaleString('en-IN')}</strong>
      </div>
    </div>
    <div class="modal-footer" style="margin-top:16px">
      <button class="btn btn-ghost" id="settleCancelBtn">Cancel</button>
      <button class="btn" id="settleConfirmBtn" style="background:linear-gradient(135deg,#e63946,#dc2626);color:#fff;font-weight:700;padding:10px 28px">Settle & Save</button>
    </div>
    `);

    // Calculate return dynamically
    const paidInput = el.querySelector('#settlePaid');
    const tipInput = el.querySelector('#settleTip');
    const returnInput = el.querySelector('#settleReturn');
    const amountDisplay = el.querySelector('#settleAmount');

    function updateSettle() {
        const paid = parseFloat(paidInput.value) || 0;
        const tip = parseFloat(tipInput.value) || 0;
        const returnAmt = Math.max(0, paid - total);
        returnInput.value = returnAmt;
        amountDisplay.textContent = '₹' + (total + tip).toLocaleString('en-IN');
    }
    paidInput.oninput = updateSettle;
    tipInput.oninput = updateSettle;

    el.querySelector('#settleCancelBtn').onclick = close;
    el.querySelector('#settleConfirmBtn').onclick = () => {
        const paymentType = el.querySelector('input[name="settlePayment"]:checked')?.value || 'cash';
        const paid = parseFloat(paidInput.value) || 0;
        const tip = parseFloat(tipInput.value) || 0;

        // Save order to history
        state.orderCounter++;
        const orderId = state.settings.invoicePrefix + state.orderCounter;
        const order = {
            id: orderId,
            items: (tbl.orderItems || []).map(i => ({ ...i })),
            subtotal, gst, total: total + tip,
            discount: 0,
            type: 'dine-in',
            table: tableId,
            payment: paymentType,
            time: Date.now(),
            customer: null,
            isComplimentary: paymentType === 'not-paid',
            status: 'completed',
            cashReceived: paid,
            changeGiven: Math.max(0, paid - total),
            tip: tip
        };
        state.orders.unshift(order);
        if (state.orders.length > 200) state.orders = state.orders.slice(0, 200);
        localStorage.setItem('kcb_orders', JSON.stringify(state.orders));
        localStorage.setItem('kcb_orderCounter', state.orderCounter.toString());
        db.saveOrder(order);
        db.saveCounter(state.orderCounter);

        // Reset table to available
        tbl.status = 'available';
        tbl.guests = 0;
        tbl.amount = 0;
        tbl.orderItems = [];
        tbl.occupiedSince = null;

        // Remove settled table's items from KDS (use == for type coercion safety)
        state.kdsOrders = state.kdsOrders.filter(k => !(k.table == tableId));
        localStorage.setItem('kcb_kds', JSON.stringify(state.kdsOrders));

        persistStateNow();
        close();
        renderScreen();
        notify(`✅ Table T${tableId} settled — ${fmt(total + tip)} (${paymentType})`);
    };
}

function openTableManageModal(tableId) {
    const table = TABLES.find(t => t.id === tableId);
    if (!table) return;

    const { el, close } = modal(`
    <h3 class="modal-heading">✏️ Manage — Table T${table.id}</h3>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Status</label>
        <select id="tblStatus" class="input-full">
          <option value="available" ${table.status === 'available' ? 'selected' : ''}>Available</option>
          <option value="occupied" ${table.status === 'occupied' ? 'selected' : ''}>Occupied</option>
          <option value="bill-pending" ${table.status === 'bill-pending' ? 'selected' : ''}>Bill Pending</option>
          <option value="paid" ${table.status === 'paid' ? 'selected' : ''}>Paid (Cooking)</option>
        </select>
      </div>
      <div class="form-field"><label class="form-label">Guests</label><input type="number" id="tblGuests" class="input-full" value="${table.guests || 0}" min="0" max="20"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-danger" id="tblDelete">🗑️ Delete</button>
      <div style="flex:1"></div>
      <button class="btn btn-ghost" id="tblCancel">Cancel</button>
      <button class="btn btn-primary" id="tblSave">✅ Save</button>
    </div>
  `);

    el.querySelector('#tblCancel').onclick = close;
    el.querySelector('#tblDelete').onclick = () => {
        if (table.status === 'occupied') {
            notify('⚠️ Cannot delete an occupied table', 'warn');
            return;
        }
        if (confirm(`⚠️ Are you sure you want to delete Table T${table.id}? This cannot be undone.`)) {
            const idx = TABLES.findIndex(t => t.id === tableId);
            if (idx !== -1) TABLES.splice(idx, 1);
            close();
            persistState();
            renderScreen();
            notify(`🗑️ Table T${tableId} deleted`, 'info');
        }
    };
    el.querySelector('#tblSave').onclick = () => {
        table.status = el.querySelector('#tblStatus').value;
        table.guests = parseInt(el.querySelector('#tblGuests').value) || 0;
        if (table.status === 'available') { table.guests = 0; table.amount = 0; }
        close();
        persistState();
        renderScreen();
        notify(`✅ Table T${table.id} updated`);
    };
}

function bindMenu() {
    document.querySelectorAll('.avail-toggle').forEach(t => t.onclick = () => {
        const item = MENU_ITEMS.find(i => i.id === t.dataset.id);
        if (item) {
            item.avail = !item.avail;
            t.classList.toggle('on', item.avail);
            t.classList.toggle('off', !item.avail);
            notify(item.avail ? `✅ ${item.name} available` : `❌ ${item.name} unavailable`, item.avail ? 'success' : 'info');
        }
    });

    const s = document.getElementById('menuMgmtSearch');
    if (s) s.oninput = () => {
        const q = s.value.toLowerCase();
        document.querySelectorAll('.data-table tbody tr').forEach(r => r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none');
    };

    // Manage (Add)
    document.getElementById('addMenuItemBtn')?.addEventListener('click', () => openMenuItemModal(-1));

    // Edit menu items
    document.querySelectorAll('.edit-menu-btn').forEach(b => b.onclick = (e) => {
        e.stopPropagation();
        openMenuItemModal(parseInt(b.dataset.idx));
    });
}

function openMenuItemModal(idx) {
    const isNew = idx === -1;
    const item = isNew ? { name: '', price: 0, category: CATEGORIES[0]?.id || '', veg: true, spice: 1, tags: [], avail: true } : { ...MENU_ITEMS[idx] };

    const { el, close } = modal(`
    <h3 class="modal-heading">${isNew ? '➕ Add Menu Item' : '✏️ Edit — ' + item.name}</h3>
    <div class="form-field"><label class="form-label">Name</label><input type="text" id="miName" class="input-full" value="${item.name}"></div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Price (₹)</label><input type="number" id="miPrice" class="input-full" value="${item.price}"></div>
      <div class="form-field"><label class="form-label">Category</label>
        <select id="miCategory" class="input-full">${CATEGORIES.map(c => `<option value="${c.id}" ${c.id === item.category ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Type</label>
        <select id="miVeg" class="input-full"><option value="true" ${item.veg ? 'selected' : ''}>Veg</option><option value="false" ${!item.veg ? 'selected' : ''}>Non-Veg</option></select>
      </div>
      <div class="form-field"><label class="form-label">Spice Level (0-3)</label><input type="number" id="miSpice" class="input-full" value="${item.spice || 0}" min="0" max="3"></div>
    </div>
    <div class="form-field"><label class="form-label">Tags (comma-separated: popular, new, chef-special)</label><input type="text" id="miTags" class="input-full" value="${(item.tags || []).join(', ')}"></div>
    <div class="modal-footer">
      ${!isNew ? '<button class="btn btn-danger" id="miDelete">🗑️ Delete</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn btn-ghost" id="miCancel">Cancel</button>
      <button class="btn btn-primary" id="miSave">${isNew ? '➕ Add Item' : '✅ Save'}</button>
    </div>
  `);

    el.querySelector('#miCancel').onclick = close;
    if (!isNew) {
        el.querySelector('#miDelete').onclick = () => {
            if (confirm(`⚠️ Are you sure you want to delete "${item.name}"? This cannot be undone.`)) {
                MENU_ITEMS.splice(idx, 1);
                close();
                renderScreen();
                notify(`🗑️ ${item.name} deleted`, 'info');
            }
        };
    }
    el.querySelector('#miSave').onclick = () => {
        const name = el.querySelector('#miName').value.trim();
        const price = parseInt(el.querySelector('#miPrice').value) || 0;
        if (!name) { notify('⚠️ Name is required', 'warn'); return; }
        if (price <= 0) { notify('⚠️ Price must be > 0', 'warn'); return; }

        const data = {
            id: isNew ? 'item-' + Date.now() : item.id,
            name,
            price,
            category: el.querySelector('#miCategory').value,
            veg: el.querySelector('#miVeg').value === 'true',
            spice: parseInt(el.querySelector('#miSpice').value) || 0,
            tags: el.querySelector('#miTags').value.split(',').map(t => t.trim()).filter(Boolean),
            avail: item.avail !== undefined ? item.avail : true
        };

        if (isNew) {
            MENU_ITEMS.push(data);
            notify(`✅ ${name} added to menu`);
        } else {
            Object.assign(MENU_ITEMS[idx], data);
            notify(`✅ ${name} updated`);
        }
        close();
        renderScreen();
    };
}

function bindCRM() {
    const s = document.getElementById('crmSearch');
    if (s) s.oninput = () => {
        const q = s.value.toLowerCase();
        document.querySelectorAll('.data-table tbody tr').forEach(r => r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none');
    };

    // Manage (Add)
    document.getElementById('addCustomerBtn')?.addEventListener('click', () => openCustomerEditModal(-1));

    // Edit customers
    document.querySelectorAll('.edit-cust-btn').forEach(b => b.onclick = (e) => {
        e.stopPropagation();
        openCustomerEditModal(parseInt(b.dataset.idx));
    });
}

function openCustomerEditModal(idx) {
    const isNew = idx === -1;
    const c = isNew ? { name: '', phone: '', orders: 0, spent: 0, lastVisit: new Date().toISOString().split('T')[0], loyalty: 'bronze' } : { ...CUSTOMERS[idx] };

    const { el, close } = modal(`
    <h3 class="modal-heading">${isNew ? '➕ Add Customer' : '✏️ Edit — ' + c.name}</h3>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Name</label><input type="text" id="ceditName" class="input-full" value="${c.name}"></div>
      <div class="form-field"><label class="form-label">Phone</label><input type="text" id="ceditPhone" class="input-full" value="${c.phone}"></div>
    </div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Orders</label><input type="number" id="ceditOrders" class="input-full" value="${c.orders}"></div>
      <div class="form-field"><label class="form-label">Total Spent (₹)</label><input type="number" id="ceditSpent" class="input-full" value="${c.spent}"></div>
    </div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Last Visit</label><input type="date" id="ceditVisit" class="input-full" value="${c.lastVisit}"></div>
      <div class="form-field"><label class="form-label">Loyalty Tier</label>
        <select id="ceditLoyalty" class="input-full"><option value="bronze" ${c.loyalty === 'bronze' ? 'selected' : ''}>Bronze</option><option value="silver" ${c.loyalty === 'silver' ? 'selected' : ''}>Silver</option><option value="gold" ${c.loyalty === 'gold' ? 'selected' : ''}>Gold</option></select>
      </div>
    </div>
    <div class="modal-footer">
      ${!isNew ? '<button class="btn btn-danger" id="ceditDelete">🗑️ Delete</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn btn-ghost" id="ceditCancel">Cancel</button>
      <button class="btn btn-primary" id="ceditSave">${isNew ? '➕ Add' : '✅ Save'}</button>
    </div>
  `);

    el.querySelector('#ceditCancel').onclick = close;
    if (!isNew) {
        el.querySelector('#ceditDelete').onclick = () => {
            if (confirm(`⚠️ Are you sure you want to delete customer "${c.name}"? This cannot be undone.`)) {
                CUSTOMERS.splice(idx, 1);
                saveCustomers();
                close();
                renderScreen();
                notify(`🗑️ ${c.name} deleted`, 'info');
            }
        };
    }
    el.querySelector('#ceditSave').onclick = () => {
        const name = el.querySelector('#ceditName').value.trim();
        const phone = el.querySelector('#ceditPhone').value.trim();
        if (!name) { notify('⚠️ Name is required', 'warn'); return; }

        const data = {
            id: isNew ? CUSTOMERS.length + 100 : c.id,
            name,
            phone,
            orders: parseInt(el.querySelector('#ceditOrders').value) || 0,
            spent: parseInt(el.querySelector('#ceditSpent').value) || 0,
            lastVisit: el.querySelector('#ceditVisit').value,
            loyalty: el.querySelector('#ceditLoyalty').value
        };

        if (isNew) {
            CUSTOMERS.push(data);
            notify(`✅ ${name} added`);
        } else {
            Object.assign(CUSTOMERS[idx], data);
            notify(`✅ ${name} updated`);
        }
        saveCustomers();
        close();
        renderScreen();
    };
}

function bindStaff() {
    // Manage (Add)
    document.getElementById('addStaffBtn')?.addEventListener('click', () => openStaffEditModal(-1));

    // Edit staff
    document.querySelectorAll('.edit-staff-btn').forEach(b => b.onclick = (e) => {
        e.stopPropagation();
        openStaffEditModal(parseInt(b.dataset.idx));
    });
}

function openStaffEditModal(idx) {
    const isNew = idx === -1;
    const s = isNew ? { name: '', role: 'Waiter', shift: 'Morning', status: 'active', perf: 80, username: '', password: '', phone: '' } : { ...STAFF[idx] };

    const { el, close } = modal(`
    <h3 class="modal-heading">${isNew ? '➕ Add Staff' : '✏️ Edit — ' + s.name}</h3>
    <div class="form-field"><label class="form-label">Name</label><input type="text" id="seditName" class="input-full" value="${s.name}"></div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Role</label>
        <select id="seditRole" class="input-full">
          <option ${s.role === 'Chef' ? 'selected' : ''}>Chef</option>
          <option ${s.role === 'Head Chef' ? 'selected' : ''}>Head Chef</option>
          <option ${s.role === 'Waiter' ? 'selected' : ''}>Waiter</option>
          <option ${s.role === 'Manager' ? 'selected' : ''}>Manager</option>
          <option ${s.role === 'Cashier' ? 'selected' : ''}>Cashier</option>
          <option ${s.role === 'Helper' ? 'selected' : ''}>Helper</option>
        </select>
      </div>
      <div class="form-field"><label class="form-label">Shift</label>
        <select id="seditShift" class="input-full">
          <option ${s.shift === 'Morning' ? 'selected' : ''}>Morning</option>
          <option ${s.shift === 'Afternoon' ? 'selected' : ''}>Afternoon</option>
          <option ${s.shift === 'Evening' ? 'selected' : ''}>Evening</option>
          <option ${s.shift === 'Full Day' ? 'selected' : ''}>Full Day</option>
          <option ${s.shift === 'Night' ? 'selected' : ''}>Night</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Phone</label><input type="text" id="seditPhone" class="input-full" value="${s.phone || ''}"></div>
      <div class="form-field"><label class="form-label">Performance (%)</label><input type="number" id="seditPerf" class="input-full" value="${s.perf || 80}" min="0" max="100"></div>
    </div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Status</label>
        <select id="seditStatus" class="input-full">
          <option value="active" ${s.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="off" ${s.status === 'off' ? 'selected' : ''}>Off Duty</option>
        </select>
      </div>
    </div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;">🔑 Login Credentials (for Staff Login)</div>
      <div class="form-row">
        <div class="form-field"><label class="form-label">Username</label><input type="text" id="seditUsername" class="input-full" value="${s.username || ''}" placeholder="e.g. raj123"></div>
        <div class="form-field"><label class="form-label">Password</label><input type="text" id="seditPassword" class="input-full" value="${s.password || ''}" placeholder="e.g. pass123"></div>
      </div>
    </div>
    <div class="modal-footer">
      ${!isNew ? '<button class="btn btn-danger" id="seditDelete">🗑️ Delete</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn btn-ghost" id="seditCancel">Cancel</button>
      <button class="btn btn-primary" id="seditSave">${isNew ? '➕ Add Staff' : '✅ Save'}</button>
    </div>
  `);

    el.querySelector('#seditCancel').onclick = close;
    if (!isNew) {
        el.querySelector('#seditDelete').onclick = () => {
            if (confirm(`⚠️ Are you sure you want to remove "${s.name}"? This cannot be undone.`)) {
                STAFF.splice(idx, 1);
                saveStaff();
                close();
                renderScreen();
                notify(`🗑️ ${s.name} removed`, 'info');
            }
        };
    }
    el.querySelector('#seditSave').onclick = () => {
        const name = el.querySelector('#seditName').value.trim();
        if (!name) { notify('⚠️ Name is required', 'warn'); return; }

        const data = {
            id: isNew ? 'staff-' + Date.now() : s.id,
            name,
            role: el.querySelector('#seditRole').value,
            shift: el.querySelector('#seditShift').value,
            status: el.querySelector('#seditStatus').value,
            perf: parseInt(el.querySelector('#seditPerf').value) || 80,
            phone: el.querySelector('#seditPhone').value.trim(),
            username: el.querySelector('#seditUsername').value.trim(),
            password: el.querySelector('#seditPassword').value.trim()
        };

        // Validate: both username and password must be set together
        if ((data.username && !data.password) || (!data.username && data.password)) {
            notify('⚠️ Both username AND password are required for login', 'warn');
            return;
        }

        if (isNew) {
            STAFF.push(data);
            notify(`✅ ${name} added to staff`);
        } else {
            Object.assign(STAFF[idx], data);
            notify(`✅ ${name} updated`);
        }
        saveStaff();
        close();
        renderScreen();
    };
}

function bindInventory() {
    // Manage (Add)
    document.getElementById('addInventoryBtn')?.addEventListener('click', () => openInventoryEditModal(-1));

    // Edit
    document.querySelectorAll('.edit-inv-btn').forEach(b => b.onclick = (e) => {
        e.stopPropagation();
        openInventoryEditModal(parseInt(b.dataset.idx));
    });
}

function openInventoryEditModal(idx) {
    const isNew = idx === -1;
    const item = isNew ? { name: '', category: 'Vegetables', stock: 0, unit: 'kg', reorder: 10 } : { ...INVENTORY[idx] };

    const { el, close } = modal(`
    <h3 class="modal-heading">${isNew ? '➕ Add Inventory Item' : '✏️ Edit — ' + item.name}</h3>
    <div class="form-field"><label class="form-label">Item Name</label><input type="text" id="ieditName" class="input-full" value="${item.name}"></div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Category</label>
        <select id="ieditCat" class="input-full">
          <option ${item.category === 'Vegetables' ? 'selected' : ''}>Vegetables</option>
          <option ${item.category === 'Meat' ? 'selected' : ''}>Meat</option>
          <option ${item.category === 'Dairy' ? 'selected' : ''}>Dairy</option>
          <option ${item.category === 'Grains' ? 'selected' : ''}>Grains</option>
          <option ${item.category === 'Oils' ? 'selected' : ''}>Oils</option>
          <option ${item.category === 'Spices' ? 'selected' : ''}>Spices</option>
          <option ${item.category === 'Sauces' ? 'selected' : ''}>Sauces</option>
          <option ${item.category === 'Packaging' ? 'selected' : ''}>Packaging</option>
          <option ${item.category === 'Beverages' ? 'selected' : ''}>Beverages</option>
        </select>
      </div>
      <div class="form-field"><label class="form-label">Unit</label>
        <select id="ieditUnit" class="input-full">
          <option ${item.unit === 'kg' ? 'selected' : ''}>kg</option>
          <option ${item.unit === 'g' ? 'selected' : ''}>g</option>
          <option ${item.unit === 'L' ? 'selected' : ''}>L</option>
          <option ${item.unit === 'ml' ? 'selected' : ''}>ml</option>
          <option ${item.unit === 'pcs' ? 'selected' : ''}>pcs</option>
          <option ${item.unit === 'packs' ? 'selected' : ''}>packs</option>
          <option ${item.unit === 'bottles' ? 'selected' : ''}>bottles</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-field"><label class="form-label">Current Stock</label><input type="number" id="ieditStock" class="input-full" value="${item.stock}" min="0"></div>
      <div class="form-field"><label class="form-label">Reorder Level</label><input type="number" id="ieditReorder" class="input-full" value="${item.reorder}" min="0"></div>
    </div>
    <div class="modal-footer">
      ${!isNew ? '<button class="btn btn-danger" id="ieditDelete">🗑️ Delete</button>' : ''}
      ${!isNew ? '<button class="btn btn-secondary" id="ieditRestock">📥 Restock</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn btn-ghost" id="ieditCancel">Cancel</button>
      <button class="btn btn-primary" id="ieditSave">${isNew ? '➕ Add' : '✅ Save'}</button>
    </div>
  `);

    el.querySelector('#ieditCancel').onclick = close;
    if (!isNew) {
        el.querySelector('#ieditDelete').onclick = () => {
            if (confirm(`⚠️ Are you sure you want to delete "${item.name}"? This cannot be undone.`)) {
                INVENTORY.splice(idx, 1);
                saveInventory();
                close();
                renderScreen();
                notify(`🗑️ ${item.name} deleted`, 'info');
            }
        };
        el.querySelector('#ieditRestock').onclick = () => {
            const qty = prompt(`Restock "${item.name}"\nCurrent: ${item.stock} ${item.unit}\n\nEnter quantity to add:`);
            if (qty && parseInt(qty) > 0) {
                INVENTORY[idx].stock += parseInt(qty);
                el.querySelector('#ieditStock').value = INVENTORY[idx].stock;
                saveInventory();
                notify(`📥 ${item.name} restocked +${qty} ${item.unit}`);
            }
        };
    }
    el.querySelector('#ieditSave').onclick = () => {
        const name = el.querySelector('#ieditName').value.trim();
        if (!name) { notify('⚠️ Name is required', 'warn'); return; }

        const data = {
            id: isNew ? 'inv-' + Date.now() : item.id,
            name,
            category: el.querySelector('#ieditCat').value,
            unit: el.querySelector('#ieditUnit').value,
            stock: parseInt(el.querySelector('#ieditStock').value) || 0,
            reorder: parseInt(el.querySelector('#ieditReorder').value) || 10
        };

        if (isNew) {
            INVENTORY.push(data);
            notify(`✅ ${name} added to inventory`);
        } else {
            Object.assign(INVENTORY[idx], data);
            notify(`✅ ${name} updated`);
        }
        saveInventory();
        close();
        renderScreen();
    };
}

function saveSettings() {
    localStorage.setItem('kcb_settings', JSON.stringify(state.settings));
    db.saveSettings(state.settings);
}

function saveStaff() {
    localStorage.setItem('kcb_staffData', JSON.stringify(STAFF));
    // Sync staff to D1 cloud so all devices can access
    fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffData: JSON.stringify(STAFF) })
    }).catch(() => { });
}

function saveCustomers() {
    localStorage.setItem('kcb_customerData', JSON.stringify(CUSTOMERS));
    // Sync to D1 cloud
    fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerData: JSON.stringify(CUSTOMERS) })
    }).catch(() => { });
}

function saveInventory() {
    localStorage.setItem('kcb_inventoryData', JSON.stringify(INVENTORY));
    // Sync to D1 cloud
    fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryData: JSON.stringify(INVENTORY) })
    }).catch(() => { });
}

function bindSettings() {
    // ── PIN Lock Screen ──
    const pinKeys = document.querySelectorAll('.pin-key');
    if (pinKeys.length > 0) {
        // We're on the PIN screen, not the actual settings
        let pinEntry = '';
        const pinDisplay = document.getElementById('pinDisplay');
        const pinError = document.getElementById('pinError');
        const correctPin = state.settings.settingsPin || '000000';

        pinKeys.forEach(btn => {
            btn.onclick = () => {
                const key = btn.dataset.key;
                if (key === '⌫') {
                    pinEntry = pinEntry.slice(0, -1);
                } else if (pinEntry.length < 6) {
                    pinEntry += key;
                }
                // Update display
                pinDisplay.textContent = '●'.repeat(pinEntry.length) + '_'.repeat(6 - pinEntry.length);
                pinError.textContent = '';

                // Check on 6 digits
                if (pinEntry.length === 6) {
                    if (pinEntry === correctPin) {
                        state._settingsUnlocked = true;
                        renderScreen();
                    } else {
                        pinError.textContent = '❌ Wrong PIN. Try again.';
                        pinEntry = '';
                        setTimeout(() => {
                            pinDisplay.textContent = '______';
                        }, 300);
                    }
                }
            };
        });
        return; // Don't bind settings controls — they don't exist yet
    }

    // ── Actual Settings Controls ──
    // Text inputs
    const inputMap = {
        settingName: 'restaurantName',
        settingPhone: 'phone',
        settingAddress: 'address',
        settingGstNo: 'gstNo',
        settingPrefix: 'invoicePrefix',
        settingGoal: 'dailyGoal',
        settingCashier: 'cashierName',
        settingFooter: 'footerText',
        settingPin: 'settingsPin',
        settingAdminUser: 'adminUser',
        settingAdminPass: 'adminPass'
    };
    Object.entries(inputMap).forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) {
            el.oninput = () => {
                state.settings[key] = key === 'dailyGoal' ? parseInt(el.value) || 0 : el.value;
                saveSettings();
            };
        }
    });

    // Select dropdowns
    const selectMap = {
        settingGstRate: 'gstRate',
        settingSvcCharge: 'serviceCharge',
        settingKotPrinter: 'kotPrinter',
        settingBillPrinter: 'billPrinter',
        settingTheme: 'theme'
    };
    Object.entries(selectMap).forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) {
            el.onchange = () => {
                const val = el.value;
                if (key === 'gstRate' || key === 'serviceCharge') {
                    state.settings[key] = parseInt(val);
                } else {
                    state.settings[key] = val;
                }
                saveSettings();
                notify('✅ Setting updated');
                // If theme changed, apply immediately
                if (key === 'theme') {
                    document.body.dataset.theme = val;
                }
            };
        }
    });

    // Toggles
    const toggleMap = {
        toggleAutoPrintKOT: 'autoPrintKOT',
        toggleSoundEffects: 'soundEffects',
        toggleCompactMode: 'compactMode'
    };
    Object.entries(toggleMap).forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) {
            el.onclick = () => {
                state.settings[key] = !state.settings[key];
                el.classList.toggle('on', state.settings[key]);
                el.classList.toggle('off', !state.settings[key]);
                saveSettings();
                notify(`${state.settings[key] ? '✅' : '❌'} ${key.replace(/([A-Z])/g, ' $1').trim()} ${state.settings[key] ? 'enabled' : 'disabled'}`);
                // Apply compact mode immediately
                if (key === 'compactMode') {
                    document.body.classList.toggle('compact', state.settings[key]);
                }
            };
        }
    });

    // Management navigation cards
    document.querySelectorAll('.settings-mgmt-btn').forEach(btn => {
        btn.onclick = () => navigate(btn.dataset.goto);
    });
}

/* ═══════════════════════════════════════════════
   MOBILE SIDEBAR TOGGLE
   ═══════════════════════════════════════════════ */
(function initMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('menuToggle');
    if (!sidebar || !toggle) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.getElementById('app')?.appendChild(overlay);

    function openSidebar() {
        sidebar.classList.add('open');
        overlay.classList.add('visible');
    }

    function closeSidebar() {
        sidebar.classList.remove('open');
        overlay.classList.remove('visible');
    }

    toggle.addEventListener('click', () => {
        sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });

    // Close on overlay click
    overlay.addEventListener('click', closeSidebar);

    // Close sidebar on navigation (mobile)
    const origNavigate = window._kcbNavigate || navigate;
    window._kcbNavigate = origNavigate;
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(n => {
        n.addEventListener('click', () => {
            if (window.innerWidth <= 1024) closeSidebar();
        });
    });
})();

/* ═══════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'F1') { e.preventDefault(); navigate('billing'); setTimeout(() => document.getElementById('menuSearch')?.focus(), 50); }
    else if (e.key === 'F2') { e.preventDefault(); openPaymentModal(); }
    else if (e.key === 'F3') { e.preventDefault(); navigate('kds'); }
    else if (e.key === 'F4') { e.preventDefault(); navigate('tables'); }
    else if (e.key === 'F5') { e.preventDefault(); navigate('dashboard'); }
    else if (e.key === 'Escape') { document.querySelectorAll('.modal-overlay').forEach(m => { m.classList.remove('visible'); setTimeout(() => m.remove(), 200); }); }
});

/* ═══════════════════════════════════════════════
   CLOCK
   ═══════════════════════════════════════════════ */
function updateClock() {
    const el = document.getElementById('topbarClock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toUpperCase();
}

/* ═══════════════════════════════════════════════
   AUTO-SYNC: Pull latest data from D1 every 2 min
   ═══════════════════════════════════════════════ */
function startAutoSync() {
    const rIC = window.requestIdleCallback || (cb => setTimeout(cb, 100));
    setInterval(() => {
        // Only sync when tab is visible
        if (document.hidden) return;
        rIC(async () => {
            try {
                const res = await fetch('/api/settings');
                const settings = await res.json();

                // Sync staff
                if (settings.staffData) {
                    try {
                        const cloud = JSON.parse(settings.staffData);
                        if (Array.isArray(cloud) && cloud.length !== STAFF.length) {
                            STAFF.length = 0;
                            cloud.forEach(s => STAFF.push(s));
                            localStorage.setItem('kcb_staffData', settings.staffData);
                        }
                    } catch (e) { }
                }

                // Sync customers
                if (settings.customerData) {
                    try {
                        const cloud = JSON.parse(settings.customerData);
                        if (Array.isArray(cloud) && cloud.length !== CUSTOMERS.length) {
                            CUSTOMERS.length = 0;
                            cloud.forEach(c => CUSTOMERS.push(c));
                            localStorage.setItem('kcb_customerData', settings.customerData);
                        }
                    } catch (e) { }
                }

                // Sync inventory
                if (settings.inventoryData) {
                    try {
                        const cloud = JSON.parse(settings.inventoryData);
                        if (Array.isArray(cloud) && cloud.length !== INVENTORY.length) {
                            INVENTORY.length = 0;
                            cloud.forEach(i => INVENTORY.push(i));
                            localStorage.setItem('kcb_inventoryData', settings.inventoryData);
                        }
                    } catch (e) { }
                }

                // Sync admin credentials
                if (settings.adminUser && settings.adminUser !== state.settings.adminUser) {
                    state.settings.adminUser = settings.adminUser;
                    state.settings.adminPass = settings.adminPass || state.settings.adminPass;
                    localStorage.setItem('kcb_settings', JSON.stringify(state.settings));
                }
            } catch (e) { }
        });
    }, 120000); // Every 2 minutes
}

/* ═══════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════ */
function init() {


    // ── LOGIN SYSTEM ──
    const loginScreen = document.getElementById('loginScreen');
    const appEl = document.getElementById('app');
    const activeSession = sessionStorage.getItem('kcb_loggedIn');

    // Set default credentials if not yet configured
    if (!state.settings.adminUser) state.settings.adminUser = 'admin';
    if (!state.settings.adminPass) state.settings.adminPass = 'admin123';
    if (!state.settings.staffUser) state.settings.staffUser = 'staff';
    if (!state.settings.staffPass) state.settings.staffPass = 'staff123';

    function updateUserDisplay(role, staffName) {
        const nameEl = document.querySelector('.user-name');
        const roleEl = document.querySelector('.user-role');
        const avatarEl = document.querySelector('.user-avatar');
        if (role === 'admin') {
            if (nameEl) nameEl.textContent = 'Admin';
            if (roleEl) roleEl.textContent = 'Owner';
            if (avatarEl) avatarEl.textContent = 'AD';
        } else {
            const displayName = staffName || 'Staff';
            if (nameEl) nameEl.textContent = displayName;
            if (roleEl) roleEl.textContent = 'Staff';
            if (avatarEl) avatarEl.textContent = displayName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        }
    }

    function onLoginSuccess(role, staffName) {
        loginScreen.style.display = 'none';
        appEl.style.display = '';
        state._userRole = role;
        updateUserDisplay(role, staffName);
        if (role === 'staff') {
            document.querySelectorAll('.nav-item').forEach(n => {
                if (n.dataset.screen === 'settings') n.style.display = 'none';
            });
        }
        // Wait for DOM to fully render before binding events
        requestAnimationFrame(() => requestAnimationFrame(() => startApp()));
    }

    if (!activeSession) {
        // Show login, hide app
        loginScreen.style.display = 'flex';
        appEl.style.display = 'none';

        // Admin login (tries local, then D1 cloud)
        document.getElementById('adminLoginBtn').onclick = async () => {
            const u = document.getElementById('adminUser').value.trim();
            const p = document.getElementById('adminPass').value;
            if (u === state.settings.adminUser && p === state.settings.adminPass) {
                sessionStorage.setItem('kcb_loggedIn', 'admin');
                onLoginSuccess('admin');
            } else {
                // Try fetching latest settings from D1 (admin may have changed password on another device)
                try {
                    const res = await fetch('/api/settings');
                    const cloudSettings = await res.json();
                    const cloudUser = cloudSettings.adminUser || 'admin';
                    const cloudPass = cloudSettings.adminPass || 'admin123';
                    if (u === cloudUser && p === cloudPass) {
                        state.settings.adminUser = cloudUser;
                        state.settings.adminPass = cloudPass;
                        localStorage.setItem('kcb_settings', JSON.stringify(state.settings));
                        sessionStorage.setItem('kcb_loggedIn', 'admin');
                        onLoginSuccess('admin');
                        return;
                    }
                } catch (e) { }
                document.getElementById('adminError').textContent = '❌ Wrong username or password';
            }
        };
        document.getElementById('adminPass').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('adminLoginBtn').click(); };

        // Staff login — authenticates against staff records (tries local, then D1 cloud)
        document.getElementById('staffLoginBtn').onclick = async () => {
            const u = document.getElementById('staffUser').value.trim();
            const p = document.getElementById('staffPass').value;
            let staffMember = STAFF.find(s => s.username && s.username === u && s.password === p && s.status === 'active');

            // If not found locally, try fetching from D1 cloud (async fetch may not have completed)
            if (!staffMember) {
                try {
                    const res = await fetch('/api/settings');
                    const settings = await res.json();
                    if (settings.staffData) {
                        const cloudStaff = JSON.parse(settings.staffData);
                        if (Array.isArray(cloudStaff)) {
                            STAFF.length = 0;
                            cloudStaff.forEach(s => STAFF.push(s));
                            localStorage.setItem('kcb_staffData', JSON.stringify(STAFF));
                            staffMember = STAFF.find(s => s.username && s.username === u && s.password === p && s.status === 'active');
                        }
                    }
                } catch (e) { }
            }

            if (staffMember) {
                sessionStorage.setItem('kcb_loggedIn', 'staff');
                sessionStorage.setItem('kcb_staffName', staffMember.name);
                onLoginSuccess('staff', staffMember.name);
            } else {
                document.getElementById('staffError').textContent = '❌ Wrong credentials or account inactive';
            }
        };
        document.getElementById('staffPass').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('staffLoginBtn').click(); };

        return; // Wait for login — startApp() will be called on success
    }

    // Already logged in — restore session
    onLoginSuccess(activeSession, sessionStorage.getItem('kcb_staffName') || '');

    function startApp() {
        // Logout button
        const logoutBtn = document.createElement('button');
        logoutBtn.textContent = '🚪 Logout';
        logoutBtn.style.cssText = 'width:100%;padding:8px;margin-top:8px;background:transparent;border:1px solid rgba(255,255,255,0.15);color:var(--text-muted);border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;';
        logoutBtn.onclick = () => {
            sessionStorage.removeItem('kcb_loggedIn');
            location.reload();
        };
        document.querySelector('.sidebar-footer')?.appendChild(logoutBtn);

        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.onclick = (e) => { e.preventDefault(); navigate(item.dataset.screen); };
        });


        // Sidebar toggle handled by IIFE in MOBILE SIDEBAR TOGGLE section

        // Fullscreen
        document.getElementById('fullscreenBtn')?.addEventListener('click', () => {
            if (!document.fullscreenElement) document.documentElement.requestFullscreen();
            else document.exitFullscreen();
        });

        // Clock
        updateClock();
        let clockTimer = setInterval(updateClock, 1000);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { clearInterval(clockTimer); clockTimer = null; }
            else if (!clockTimer) { updateClock(); clockTimer = setInterval(updateClock, 1000); }
        });

        // Start
        navigate(state.screen || 'billing');

        // Async: load from D1 cloud database (single re-render after sync)
        syncFromD1().then(() => renderScreen()).catch(() => { });

        // Start auto-sync polling (every 2 minutes)
        startAutoSync();
    }
}

document.addEventListener('DOMContentLoaded', init);

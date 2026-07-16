/**
 * Admin UI — Abandoned Checkouts
 * GET /admin
 *
 * Serves the embedded admin page (simple HTML + JS, no build step).
 * The page asks for the admin token once and keeps it in sessionStorage,
 * then calls /api/abandoned-list and /api/abandoned-export.
 */

module.exports = async function handler(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Allow embedding inside the Shopify admin iframe
    res.setHeader('Content-Security-Policy', "frame-ancestors https://admin.shopify.com https://*.myshopify.com");
    res.removeHeader('X-Frame-Options');

    return res.status(200).send(PAGE);
};

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Abandoned Checkouts — OJAR</title>
<style>
  :root {
    --bg: #f1f1f1;
    --surface: #ffffff;
    --border: #e1e3e5;
    --text: #202223;
    --muted: #6d7175;
    --accent: #008060;
    --accent-hover: #006e52;
    --pending: #ffd79d;
    --pending-text: #7a5c00;
    --completed: #aee9d1;
    --completed-text: #0c5132;
    --recovered: #a4e8f2;
    --recovered-text: #00527c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; font-size: 13px; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 1px 0 rgba(0,0,0,.05);
    margin-bottom: 16px;
  }
  .card__section { padding: 16px; }
  .card__section + .card__section { border-top: 1px solid var(--border); }

  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 12px; color: var(--muted); }
  input, select {
    padding: 8px 10px; border: 1px solid #8c9196; border-radius: 6px;
    font-size: 14px; background: #fff; min-width: 150px;
  }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

  button {
    padding: 8px 14px; border-radius: 6px; border: 1px solid transparent;
    font-size: 14px; font-weight: 500; cursor: pointer;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: #fff; color: var(--text); border-color: #8c9196; }
  .btn-secondary:hover { background: #f6f6f7; }
  button:disabled { opacity: .5; cursor: not-allowed; }

  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 12px; color: var(--muted); font-weight: 500; background: #fafbfb; }
  tbody tr:hover { background: #fafbfb; }
  td.num { white-space: nowrap; }

  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 12px; font-weight: 500;
  }
  .badge--pending { background: var(--pending); color: var(--pending-text); }
  .badge--completed { background: var(--completed); color: var(--completed-text); }
  .badge--recovered { background: var(--recovered); color: var(--recovered-text); }

  .items { color: var(--muted); font-size: 13px; line-height: 1.5; max-width: 320px; }
  .empty, .loading { padding: 40px; text-align: center; color: var(--muted); }
  .pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
  .stats { display: flex; gap: 24px; }
  .stat__label { font-size: 12px; color: var(--muted); }
  .stat__value { font-size: 20px; font-weight: 600; }
  .error { background: #fff4f4; border: 1px solid #fd5749; color: #8e0b0b; padding: 12px; border-radius: 6px; margin-bottom: 16px; }
  .token-box { max-width: 420px; margin: 60px auto; }
</style>
</head>
<body>
<div class="wrap">

  <!-- Token gate -->
  <div id="tokenGate" class="card token-box" style="display:none;">
    <div class="card__section">
      <h1>Access token</h1>
      <p class="sub">Enter the admin token to view abandoned checkouts.</p>
      <div class="field" style="margin-bottom:12px;">
        <input type="password" id="tokenInput" placeholder="Admin token" style="width:100%;">
      </div>
      <button class="btn-primary" id="tokenSave">Continue</button>
      <div id="tokenError" class="error" style="display:none;margin-top:12px;">Invalid token. Please try again.</div>
    </div>
  </div>

  <!-- Main app -->
  <div id="app" style="display:none;">
    <h1>Abandoned Checkouts</h1>
    <p class="sub">Customers who entered their email and started checkout but did not complete payment.</p>

    <div class="card">
      <div class="card__section stats">
        <div><div class="stat__label">Total</div><div class="stat__value" id="statTotal">—</div></div>
        <div><div class="stat__label">Showing</div><div class="stat__value" id="statShowing">—</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card__section">
        <div class="filters">
          <div class="field">
            <label for="fSearch">Search email</label>
            <input type="text" id="fSearch" placeholder="name@example.com">
          </div>
          <div class="field">
            <label for="fStatus">Status</label>
            <select id="fStatus">
              <option value="">All</option>
              <option value="pending" selected>Pending</option>
              <option value="completed">Completed</option>
              <option value="recovered">Recovered</option>
            </select>
          </div>
          <div class="field">
            <label for="fFrom">From</label>
            <input type="date" id="fFrom">
          </div>
          <div class="field">
            <label for="fTo">To</label>
            <input type="date" id="fTo">
          </div>
          <button class="btn-primary" id="btnApply">Apply</button>
          <button class="btn-secondary" id="btnReset">Reset</button>
          <button class="btn-secondary" id="btnExport">Export CSV</button>
        </div>
      </div>
    </div>

    <div id="errorBox" class="error" style="display:none;"></div>

    <div class="card">
      <div id="tableWrap">
        <div class="loading">Loading…</div>
      </div>
      <div class="card__section pager">
        <button class="btn-secondary" id="btnPrev">Previous</button>
        <span id="pageInfo" class="sub" style="margin:0;"></span>
        <button class="btn-secondary" id="btnNext">Next</button>
      </div>
    </div>
  </div>

</div>

<script>
(function () {
  var API_BASE = '';           // same origin
  var LIMIT = 50;
  var offset = 0;
  var total = 0;
  var token = '';

  var $ = function (id) { return document.getElementById(id); };

  function saveToken(t) {
    token = t;
    try { sessionStorage.setItem('ojar_admin_token', t); } catch (e) {}
  }
  function loadToken() {
    try { return sessionStorage.getItem('ojar_admin_token') || ''; } catch (e) { return ''; }
  }

  function showError(msg) {
    var box = $('errorBox');
    box.textContent = msg;
    box.style.display = 'block';
  }
  function hideError() { $('errorBox').style.display = 'none'; }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = (s === null || s === undefined) ? '' : String(s);
    return d.innerHTML;
  }

  function formatMoney(amount, currency) {
    if (amount === null || amount === undefined) return '—';
    var n = Number(amount);
    if (isNaN(n)) return '—';
    var decimals = ['OMR','KWD','BHD'].indexOf(currency) !== -1 ? 3 : 2;
    return (currency || '') + ' ' + n.toFixed(decimals);
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return iso; }
  }

  function formatItems(items) {
    if (!Array.isArray(items) || items.length === 0) return '—';
    return items.map(function (i) {
      return escapeHtml(i.title || i.handle || 'item') + ' &times;' + (i.quantity || 1);
    }).join('<br>');
  }

  function badge(status) {
    var s = status || 'pending';
    return '<span class="badge badge--' + escapeHtml(s) + '">' + escapeHtml(s) + '</span>';
  }

  function buildQuery(extra) {
    var p = [];
    var search = $('fSearch').value.trim();
    var status = $('fStatus').value;
    var from = $('fFrom').value;
    var to = $('fTo').value;

    if (search) p.push('search=' + encodeURIComponent(search));
    if (status) p.push('status=' + encodeURIComponent(status));
    if (from) p.push('from=' + encodeURIComponent(from + 'T00:00:00Z'));
    if (to) p.push('to=' + encodeURIComponent(to + 'T23:59:59Z'));
    if (extra && extra.paging) {
      p.push('limit=' + LIMIT);
      p.push('offset=' + offset);
    }
    p.push('token=' + encodeURIComponent(token));
    return p.join('&');
  }

  function render(rows) {
    if (!rows || rows.length === 0) {
      $('tableWrap').innerHTML = '<div class="empty">No abandoned checkouts found for these filters.</div>';
      return;
    }
    var html = '<table><thead><tr>' +
      '<th>Email</th><th>Items</th><th>Total</th><th>Status</th><th>Date</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr>' +
        '<td>' + escapeHtml(r.email) + '</td>' +
        '<td class="items">' + formatItems(r.cart_items) + '</td>' +
        '<td class="num">' + escapeHtml(formatMoney(r.cart_total, r.currency)) + '</td>' +
        '<td>' + badge(r.status) + '</td>' +
        '<td class="num">' + escapeHtml(formatDate(r.created_at)) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    $('tableWrap').innerHTML = html;
  }

  function updatePager(rowCount) {
    var start = total === 0 ? 0 : offset + 1;
    var end = offset + rowCount;
    $('pageInfo').textContent = start + '–' + end + ' of ' + total;
    $('btnPrev').disabled = offset <= 0;
    $('btnNext').disabled = end >= total;
    $('statTotal').textContent = total;
    $('statShowing').textContent = rowCount;
  }

  function load() {
    hideError();
    $('tableWrap').innerHTML = '<div class="loading">Loading…</div>';

    fetch(API_BASE + '/api/abandoned-list?' + buildQuery({ paging: true }))
      .then(function (res) {
        if (res.status === 401) {
          throw new Error('UNAUTHORIZED');
        }
        if (!res.ok) throw new Error('Request failed (' + res.status + ')');
        return res.json();
      })
      .then(function (data) {
        total = data.total || 0;
        render(data.rows);
        updatePager((data.rows || []).length);
      })
      .catch(function (err) {
        if (err.message === 'UNAUTHORIZED') {
          try { sessionStorage.removeItem('ojar_admin_token'); } catch (e) {}
          showGate(true);
          return;
        }
        $('tableWrap').innerHTML = '<div class="empty">Could not load data.</div>';
        showError('Error: ' + err.message);
      });
  }

  function exportCsv() {
    var url = API_BASE + '/api/abandoned-export?' + buildQuery({ paging: false });
    // Open in a new tab so the iframe is not navigated away
    window.open(url, '_blank');
  }

  function showGate(withError) {
    $('tokenGate').style.display = 'block';
    $('app').style.display = 'none';
    $('tokenError').style.display = withError ? 'block' : 'none';
  }

  function showApp() {
    $('tokenGate').style.display = 'none';
    $('app').style.display = 'block';
    load();
  }

  // Wire up
  $('tokenSave').addEventListener('click', function () {
    var val = $('tokenInput').value.trim();
    if (!val) return;
    saveToken(val);
    showApp();
  });
  $('tokenInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('tokenSave').click();
  });

  $('btnApply').addEventListener('click', function () { offset = 0; load(); });
  $('btnReset').addEventListener('click', function () {
    $('fSearch').value = '';
    $('fStatus').value = 'pending';
    $('fFrom').value = '';
    $('fTo').value = '';
    offset = 0;
    load();
  });
  $('btnExport').addEventListener('click', exportCsv);
  $('btnPrev').addEventListener('click', function () {
    offset = Math.max(0, offset - LIMIT); load();
  });
  $('btnNext').addEventListener('click', function () {
    if (offset + LIMIT < total) { offset += LIMIT; load(); }
  });
  $('fSearch').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { offset = 0; load(); }
  });

  // Boot
  token = loadToken();
  if (token) { showApp(); } else { showGate(false); }
})();
</script>
</body>
</html>`;

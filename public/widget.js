/**
 * AgentKarma Embeddable Widget
 *
 * Usage:
 *   <div data-karma-wallet="WALLET_ADDRESS" data-karma-theme="dark"></div>
 *   <script src="https://agentkarma.io/widget.js" async></script>
 *
 * Or with script tag attributes:
 *   <script src="https://agentkarma.io/widget.js" data-wallet="WALLET_ADDRESS" async></script>
 *
 * Options (via data attributes on container div or script tag):
 *   data-wallet / data-karma-wallet  — Solana wallet address (required)
 *   data-theme / data-karma-theme    — "dark" (default) or "light"
 *   data-size / data-karma-size      — "default" or "compact"
 */
(function () {
  'use strict';

  var API_BASE = '';
  var SCRIPT = document.currentScript;

  // Detect API base from script src
  if (SCRIPT && SCRIPT.src) {
    try {
      var url = new URL(SCRIPT.src);
      API_BASE = url.origin;
    } catch (e) {
      // Fallback: same origin
    }
  }

  function init() {
    // Method 1: Find all container divs with data-karma-wallet
    var containers = document.querySelectorAll('[data-karma-wallet]');
    containers.forEach(function (el) {
      renderWidget(el, {
        wallet: el.getAttribute('data-karma-wallet'),
        theme: el.getAttribute('data-karma-theme') || 'dark',
        size: el.getAttribute('data-karma-size') || 'default',
      });
    });

    // Method 2: Script tag with data-wallet (creates widget after script)
    if (SCRIPT && SCRIPT.getAttribute('data-wallet')) {
      var wrapper = document.createElement('div');
      wrapper.style.display = 'inline-block';
      SCRIPT.parentNode.insertBefore(wrapper, SCRIPT.nextSibling);
      renderWidget(wrapper, {
        wallet: SCRIPT.getAttribute('data-wallet'),
        theme: SCRIPT.getAttribute('data-theme') || 'dark',
        size: SCRIPT.getAttribute('data-size') || 'default',
      });
    }
  }

  function renderWidget(container, opts) {
    if (!opts.wallet) return;

    // Show loading state
    container.innerHTML = '<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:#111113;border:1px solid rgba(255,255,255,0.08);font-family:Inter,-apple-system,sans-serif;font-size:12px;color:#62666d;">Loading karma...</div>';

    // Fetch badge data
    var url = API_BASE + '/api/badge/' + encodeURIComponent(opts.wallet) + '?format=json';
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then(function (data) {
        container.innerHTML = buildHTML(data, opts);
        // Make it clickable
        container.querySelector('.karma-badge').addEventListener('click', function () {
          window.open(API_BASE + '/agent/' + data.address, '_blank');
        });
      })
      .catch(function () {
        container.innerHTML = buildErrorHTML(opts);
      });
  }

  var TIER_COLORS = {
    Unrated: '#62666d',
    Poor: '#e5484d',
    Fair: '#f5a623',
    Good: '#5e6ad2',
    'Very Good': '#10b981',
    Excellent: '#7170ff',
  };

  var LIVENESS_COLORS = {
    Active: '#30a46c',
    Recent: '#f5a623',
    Dormant: '#62666d',
    Inactive: '#e5484d',
  };

  var CONFIDENCE = {
    'receipt-backed':    { color: '#10b981', label: 'Receipt-backed' },
    'behavior-inferred': { color: '#f5a623', label: 'Behavior-inferred' },
    'declared':          { color: '#8a8f98', label: 'Declared' },
  };

  // Autonomy Confidence labels (RFC v0.3 §5.5). Orthogonal to karma — rendered
  // as a separate chip, never blended with the karma score.
  var AUTONOMY = {
    'agent-like': { color: '#7170ff', label: 'agent-like' },
    'mixed':      { color: '#f5a623', label: 'mixed' },
    'human-like': { color: '#8a8f98', label: 'human-like' },
  };

  function buildHTML(data, opts) {
    var tc = TIER_COLORS[data.trustTier] || '#62666d';
    var lc = LIVENESS_COLORS[data.liveness] || '#62666d';
    var cf = CONFIDENCE[data.confidenceBadge] || CONFIDENCE.declared;
    var label = data.displayName || (data.address.slice(0, 4) + '...' + data.address.slice(-4));
    var score = (typeof data.score === 'number') ? data.score.toFixed(1) : '0.0';
    var compact = opts.size === 'compact';
    var hasAutonomy = typeof data.autonomyScore === 'number' && data.autonomyLabel;
    var ac = hasAutonomy ? (AUTONOMY[data.autonomyLabel] || AUTONOMY['human-like']) : null;
    var autonomyChip = hasAutonomy
      ? '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:500;padding:1px 6px;border-radius:4px;background:' + ac.color + '1f;color:' + ac.color + ';border:0.5px solid ' + ac.color + '40;" title="Autonomy Confidence"><span style="width:5px;height:5px;border-radius:50%;background:' + ac.color + ';"></span>Autonomy ' + Math.round(data.autonomyScore) + ' · ' + esc(ac.label) + '</span>'
      : '';

    if (compact) {
      return '<div class="karma-badge" style="display:inline-flex;align-items:center;gap:8px;padding:4px 10px;border-radius:6px;background:#111113;border:1px solid ' + tc + '33;cursor:pointer;font-family:Inter,-apple-system,sans-serif;transition:border-color 0.15s;" onmouseenter="this.style.borderColor=\'' + tc + '66\'" onmouseleave="this.style.borderColor=\'' + tc + '33\'" title="' + esc(cf.label) + '">'
        + '<span style="font-size:13px;font-weight:600;color:' + tc + ';">' + score + '</span>'
        + '<span style="font-size:11px;color:#8a8f98;">' + esc(label) + '</span>'
        + '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + cf.color + ';" title="' + esc(cf.label) + '"></span>'
        + '</div>';
    }

    return '<div class="karma-badge" style="display:inline-flex;align-items:center;gap:12px;padding:8px 14px;border-radius:10px;background:#111113;border:1px solid ' + tc + '33;cursor:pointer;font-family:Inter,-apple-system,sans-serif;transition:border-color 0.15s;" onmouseenter="this.style.borderColor=\'' + tc + '66\'" onmouseleave="this.style.borderColor=\'' + tc + '33\'">'
      // Score circle
      + '<div style="position:relative;width:40px;height:40px;">'
      + '<svg width="40" height="40" viewBox="0 0 40 40">'
      + '<circle cx="20" cy="20" r="17" fill="none" stroke="#ffffff11" stroke-width="3"/>'
      + '<circle cx="20" cy="20" r="17" fill="none" stroke="' + tc + '" stroke-width="3" stroke-dasharray="' + (2 * Math.PI * 17).toFixed(1) + '" stroke-dashoffset="' + ((2 * Math.PI * 17) - (data.score / 100) * (2 * Math.PI * 17)).toFixed(1) + '" stroke-linecap="round" transform="rotate(-90 20 20)"/>'
      + '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" fill="#f7f8f8" font-size="11" font-weight="600" font-family="Inter,-apple-system,sans-serif">' + score + '</text>'
      + '</svg></div>'
      // Info
      + '<div style="display:flex;flex-direction:column;gap:2px;">'
      + '<div style="display:flex;align-items:center;gap:6px;">'
      + '<span style="width:6px;height:6px;border-radius:50%;background:' + lc + ';display:inline-block;"></span>'
      + '<span style="font-size:12px;font-weight:500;color:#f7f8f8;">' + esc(label) + '</span>'
      + '</div>'
      + '<div style="display:inline-flex;align-items:center;gap:6px;">'
      + '<span style="font-size:10px;font-weight:500;padding:1px 6px;border-radius:4px;background:' + tc + '1f;color:' + tc + ';border:0.5px solid ' + tc + '40;">' + data.trustTier + '</span>'
      + '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:500;padding:1px 6px;border-radius:4px;background:' + cf.color + '1f;color:' + cf.color + ';border:0.5px solid ' + cf.color + '40;" title="Confidence: ' + esc(cf.label) + '"><span style="width:5px;height:5px;border-radius:50%;background:' + cf.color + ';"></span>' + esc(cf.label) + '</span>'
      + autonomyChip
      + '<span style="font-size:10px;color:#62666d;">' + data.txCount + ' txs</span>'
      + '</div>'
      + '</div>'
      + '</div>';
  }

  function buildErrorHTML() {
    return '<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:#111113;border:1px solid rgba(255,255,255,0.08);font-family:Inter,-apple-system,sans-serif;font-size:11px;color:#62666d;">Agent not found</div>';
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Auto-init on DOMContentLoaded or immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

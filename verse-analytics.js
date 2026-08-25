/* Verse App Analytics (privacy-safe Plausible deployment used by the Verse Impact Hub).
   No wallet address, payment address, API key, transaction hash, or personal data is sent. */
(function () {
  var DOMAIN = 'liquidflow-io.vercel.app';
  var SCRIPT_ID = 'verse-app-analytics';
  var SCRIPT_SRC = 'https://analytics.vgdh.io/js/script.file-downloads.hash.outbound-links.pageview-props.revenue.tagged-events.js';

  window.plausible = window.plausible || function () {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };

  function safeProps(props) {
    var out = {};
    Object.keys(props || {}).slice(0, 12).forEach(function (key) {
      var value = props[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[String(key).slice(0, 40)] = String(value).slice(0, 120);
      }
    });
    return out;
  }

  window.LiquidFlowAnalytics = {
    track: function (name, props) {
      if (!name) return;
      window.plausible(String(name).slice(0, 80), { props: safeProps(props) });
    }
  };

  if (!document.getElementById(SCRIPT_ID)) {
    var script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.defer = true;
    script.dataset.domain = DOMAIN;
    script.src = SCRIPT_SRC;
    document.head.appendChild(script);
  }

  window.LiquidFlowAnalytics.track('LiquidFlow App Loaded', { page: location.pathname });
})();

(function () {
  'use strict';

  var CONSENT_KEY = 'zv_cookie_consent';

  function applyConsent(granted) {
    if (typeof gtag === 'function') {
      gtag('consent', 'update', {
        analytics_storage: granted ? 'granted' : 'denied',
        ad_storage: granted ? 'granted' : 'denied',
        ad_user_data: granted ? 'granted' : 'denied',
        ad_personalization: granted ? 'granted' : 'denied'
      });
    }
  }

  function hideBanner() {
    var el = document.getElementById('zv-cookie-banner');
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(function () { el.remove(); }, 400);
  }

  function showBanner() {
    var style = document.createElement('style');
    style.textContent = [
      '#zv-cookie-banner{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(0);z-index:99999;',
      'width:calc(100% - 48px);max-width:700px;background:#fff;border:1px solid #e5e5e5;border-radius:16px;',
      'box-shadow:0 8px 40px rgba(0,0,0,.13);padding:20px 24px;opacity:0;',
      'transition:opacity .4s ease,transform .4s ease;',
      'font-family:"Montserrat","Helvetica Neue",Arial,sans-serif;}',
      '#zv-cookie-banner.zv-show{opacity:1;}',
      '#zv-cookie-inner{display:flex;align-items:center;gap:20px;flex-wrap:wrap;}',
      '#zv-cookie-text{flex:1;min-width:180px;}',
      '#zv-cookie-text p{margin:0;font-size:13px;line-height:1.65;color:#555;}',
      '#zv-cookie-text strong{color:#111;font-weight:600;}',
      '#zv-cookie-btns{display:flex;gap:10px;flex-shrink:0;}',
      '#zv-btn-reject{padding:9px 20px;border:1.5px solid #ccc;border-radius:50px;background:transparent;',
      'color:#555;font-size:13px;font-family:inherit;font-weight:500;cursor:pointer;',
      'transition:border-color .2s,color .2s;}',
      '#zv-btn-reject:hover{border-color:#888;color:#111;}',
      '#zv-btn-accept{padding:9px 22px;border:none;border-radius:50px;background:#111;color:#fff;',
      'font-size:13px;font-family:inherit;font-weight:500;cursor:pointer;transition:background .2s;}',
      '#zv-btn-accept:hover{background:#333;}',
      '@media(max-width:520px){#zv-cookie-inner{flex-direction:column;}',
      '#zv-cookie-btns{width:100%;}',
      '#zv-btn-reject,#zv-btn-accept{flex:1;text-align:center;}}'
    ].join('');
    document.head.appendChild(style);

    var banner = document.createElement('div');
    banner.id = 'zv-cookie-banner';
    banner.innerHTML =
      '<div id="zv-cookie-inner">' +
        '<div id="zv-cookie-text"><p><strong>Usamos cookies analíticas</strong> para entender cómo se usa el sitio y mejorar tu experiencia. Podés aceptar o rechazar su uso.</p></div>' +
        '<div id="zv-cookie-btns">' +
          '<button id="zv-btn-reject">Rechazar</button>' +
          '<button id="zv-btn-accept">Aceptar</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { banner.classList.add('zv-show'); });
    });

    document.getElementById('zv-btn-accept').addEventListener('click', function () {
      try { localStorage.setItem(CONSENT_KEY, 'granted'); } catch (e) {}
      applyConsent(true);
      hideBanner();
    });

    document.getElementById('zv-btn-reject').addEventListener('click', function () {
      try { localStorage.setItem(CONSENT_KEY, 'denied'); } catch (e) {}
      hideBanner();
    });
  }

  function init() {
    var saved = null;
    try { saved = localStorage.getItem(CONSENT_KEY); } catch (e) {}
    if (saved === 'granted') {
      applyConsent(true);
    } else if (saved !== 'denied') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showBanner);
      } else {
        showBanner();
      }
    }
  }

  init();
})();

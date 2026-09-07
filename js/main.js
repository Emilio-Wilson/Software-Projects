// Compact clock in the top nav bar
function tick() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const el = document.getElementById('navClock');
  if (el) el.textContent = `Charleston, SC · ${timeStr}`;
}
tick();
setInterval(tick, 30000);

// Live weather for Charleston International Airport (32.7765, -79.9311).
//
// Note: this only works when the page is actually served over http(s) —
// opening index.html as a local file (a file:// URL) has no origin for the
// browser to authorize, so the request is blocked there by design. Once
// this is hosted (GitHub Pages, etc.) it should resolve normally. Rather
// than hiding the widget entirely if the fetch fails, it falls back to a
// neutral icon and the city name so something always shows in the header.
const WMO_ICONS = {
  0: { day: '☀️', night: '🌙', label: 'Clear sky' },
  1: { day: '🌤️', night: '🌙', label: 'Mainly clear' },
  2: { day: '⛅', night: '☁️', label: 'Partly cloudy' },
  3: { day: '☁️', night: '☁️', label: 'Overcast' },
  45: { day: '🌫️', night: '🌫️', label: 'Fog' },
  48: { day: '🌫️', night: '🌫️', label: 'Icy fog' },
  51: { day: '🌦️', night: '🌦️', label: 'Light drizzle' },
  53: { day: '🌦️', night: '🌦️', label: 'Drizzle' },
  55: { day: '🌧️', night: '🌧️', label: 'Heavy drizzle' },
  56: { day: '🌧️', night: '🌧️', label: 'Freezing drizzle' },
  57: { day: '🌧️', night: '🌧️', label: 'Freezing drizzle' },
  61: { day: '🌧️', night: '🌧️', label: 'Light rain' },
  63: { day: '🌧️', night: '🌧️', label: 'Rain' },
  65: { day: '🌧️', night: '🌧️', label: 'Heavy rain' },
  66: { day: '🌧️', night: '🌧️', label: 'Freezing rain' },
  67: { day: '🌧️', night: '🌧️', label: 'Freezing rain' },
  71: { day: '🌨️', night: '🌨️', label: 'Light snow' },
  73: { day: '🌨️', night: '🌨️', label: 'Snow' },
  75: { day: '🌨️', night: '🌨️', label: 'Heavy snow' },
  77: { day: '🌨️', night: '🌨️', label: 'Snow grains' },
  80: { day: '🌦️', night: '🌧️', label: 'Rain showers' },
  81: { day: '🌦️', night: '🌧️', label: 'Rain showers' },
  82: { day: '⛈️', night: '⛈️', label: 'Violent showers' },
  85: { day: '🌨️', night: '🌨️', label: 'Snow showers' },
  86: { day: '🌨️', night: '🌨️', label: 'Snow showers' },
  95: { day: '⛈️', night: '⛈️', label: 'Thunderstorm' },
  96: { day: '⛈️', night: '⛈️', label: 'Thunderstorm with hail' },
  99: { day: '⛈️', night: '⛈️', label: 'Thunderstorm with hail' },
};

async function loadWeather() {
  const iconEl = document.getElementById('weatherIcon');
  const tempEl = document.getElementById('weatherTemp');
  if (!iconEl && !tempEl) return;

  // Show a clear loading state on first run only, so repeat refreshes
  // never flash back to a placeholder while the last good reading is showing.
  if (tempEl && !tempEl.dataset.loaded) tempEl.textContent = 'Loading weather…';
  if (iconEl && !iconEl.textContent) iconEl.textContent = '🌤️';

  try {
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      '?latitude=32.7765&longitude=-79.9311' +
      '&current=temperature_2m,weather_code,is_day' +
      '&temperature_unit=fahrenheit&timezone=America%2FNew_York';

    // cache: 'no-store' guarantees a fresh reading every call instead of a
    // browser-cached response, which is what caused the widget to lag.
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`weather request failed: ${res.status}`);
    const data = await res.json();
    const current = data.current;

    const meta = WMO_ICONS[current.weather_code] || { day: '🌡️', night: '🌡️', label: 'Current conditions' };
    const symbol = current.is_day ? meta.day : meta.night;

    if (iconEl) {
      iconEl.textContent = symbol;
      iconEl.title = meta.label;
    }
    if (tempEl) {
      tempEl.textContent = `${Math.round(current.temperature_2m)}°F · ${meta.label}`;
      tempEl.dataset.loaded = 'true';
    }
    lastWeatherFetch = Date.now();
  } catch (err) {
    console.warn('Weather widget: showing placeholder, live conditions unavailable.', err);
    // Leave the last good reading in place rather than wiping it on a
    // single failed refresh; only fall back to a placeholder on the very
    // first load, when there is nothing else to show yet.
    if (tempEl && !tempEl.dataset.loaded) tempEl.textContent = 'Charleston, SC';
  }
}

const WEATHER_REFRESH_MS = 5 * 60 * 1000; // refresh every 5 minutes
let lastWeatherFetch = 0;

loadWeather();
setInterval(loadWeather, WEATHER_REFRESH_MS);

// If the tab was in the background for a while, refresh the instant it's
// visible again instead of waiting out the rest of the timer, so the
// reading is never stale when someone actually looks at it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastWeatherFetch > WEATHER_REFRESH_MS) {
    loadWeather();
  }
});

// Bio card: hover works on desktop via CSS alone. This adds tap-to-toggle
// support for touch devices, where :hover doesn't behave the same way,
// plus tap-outside and Escape to close.
document.querySelectorAll('.avatar-wrap').forEach((wrap) => {
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = wrap.classList.contains('is-open');
    document.querySelectorAll('.avatar-wrap.is-open').forEach((w) => w.classList.remove('is-open'));
    if (!isOpen) wrap.classList.add('is-open');
  });
});
document.addEventListener('click', () => {
  document.querySelectorAll('.avatar-wrap.is-open').forEach((w) => w.classList.remove('is-open'));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.avatar-wrap.is-open').forEach((w) => w.classList.remove('is-open'));
  }
});

// "Get in touch" popup: built once here and shared by every page's footer
// button, so the contact card only needs to be maintained in one place.
function buildContactModal() {
  const triggers = document.querySelectorAll('.js-contact-btn');
  if (!triggers.length || document.querySelector('.contact-modal-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'contact-modal-overlay';
  overlay.innerHTML = `
    <div class="contact-modal" role="dialog" aria-modal="true" aria-labelledby="contactModalName">
      <button type="button" class="contact-modal-close" aria-label="Close">&times;</button>
      <img src="images/emiliowilson.png" alt="Emilio Wilson" class="contact-modal-photo">
      <div class="contact-modal-name" id="contactModalName">Emilio Wilson</div>
      <div class="contact-modal-role">Engineer</div>
      <div class="contact-modal-location">North Charleston, SC</div>
      <a class="contact-modal-email" href="mailto:EmilioWilson23@outlook.com">EmilioWilson23@outlook.com</a>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.classList.remove('is-open');
  const openModal = (e) => {
    e.preventDefault();
    overlay.classList.add('is-open');
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('.contact-modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  triggers.forEach((btn) => btn.addEventListener('click', openModal));
}
buildContactModal();

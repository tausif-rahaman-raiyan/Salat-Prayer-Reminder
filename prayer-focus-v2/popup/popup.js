import { fetchPrayerTimings, calculateNextPrayer, getPrayerWindows, formatDisplayTime, applyTimeOffset, PRAYER_NAMES } from '../modules/prayer-api.js';
import { getSettings, saveSettings } from '../modules/storage.js';
import { toBengaliNumerals } from '../modules/timezone.js';

let countdownTimer = null;
let currentLang = 'en';

const POPUP_I18N = {
  en: {
    nextPrayer: "Next Prayer",
    timeLeft: "Time Left:",
    openDashboard: "Open Dashboard",
    settings: "Settings",
    active: "Active",
    disabled: "Disabled",
    limitPrefix: "Until"
  },
  bn: {
    nextPrayer: "পরবর্তী ওয়াক্ত",
    timeLeft: "সময় বাকি:",
    openDashboard: "ড্যাশবোর্ড খুলুন",
    settings: "সেটিংস",
    active: "রিমাইন্ডার সক্রিয়",
    disabled: "বন্ধ রয়েছে",
    limitPrefix: "পর্যন্ত"
  }
};

async function initPopup() {
  const settings = await getSettings();
  currentLang = settings.language || 'en';

  setupPopupLanguageToggle();
  await refreshPopupUI();

  // Hook button handlers
  document.getElementById('btn-open-dashboard')?.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    } else {
      window.open('../dashboard/dashboard.html', '_blank');
    }
  });

  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#settings') });
    } else {
      window.open('../dashboard/dashboard.html#settings', '_blank');
    }
  });
}

function setupPopupLanguageToggle() {
  const btnEn = document.getElementById('btn-popup-en');
  const btnBn = document.getElementById('btn-popup-bn');

  const updateToggleStyle = () => {
    if (btnEn && btnBn) {
      if (currentLang === 'en') {
        btnEn.setAttribute('aria-pressed', 'true');
        btnBn.setAttribute('aria-pressed', 'false');
      } else {
        btnBn.setAttribute('aria-pressed', 'true');
        btnEn.setAttribute('aria-pressed', 'false');
      }
    }
  };

  updateToggleStyle();

  btnEn?.addEventListener('click', async () => {
    if (currentLang === 'en') return;
    currentLang = 'en';
    await saveSettings({ language: 'en' });
    updateToggleStyle();
    await refreshPopupUI();
  });

  btnBn?.addEventListener('click', async () => {
    if (currentLang === 'bn') return;
    currentLang = 'bn';
    await saveSettings({ language: 'bn' });
    updateToggleStyle();
    await refreshPopupUI();
  });
}

async function refreshPopupUI() {
  const settings = await getSettings();
  const dict = POPUP_I18N[currentLang];
  document.documentElement.lang = currentLang === 'bn' ? 'bn' : 'en';

  // Set location label
  const locEl = document.getElementById('location-label');
  if (locEl) locEl.textContent = `${settings.cityName} (${settings.timezone})`;

  // Notifications status
  const statusEl = document.getElementById('status-label');
  if (statusEl) {
    statusEl.textContent = settings.notificationsEnabled ? dict.active : dict.disabled;
    const badge = document.getElementById('reminder-status-badge');
    if (badge) badge.dataset.active = String(Boolean(settings.notificationsEnabled));
  }

  // Label updates
  const labelNext = document.getElementById('label-next-prayer');
  if (labelNext) labelNext.textContent = dict.nextPrayer;

  const labelTimeLeft = document.getElementById('label-time-left');
  if (labelTimeLeft) labelTimeLeft.textContent = dict.timeLeft;

  const labelOpenDash = document.getElementById('label-open-dashboard');
  if (labelOpenDash) labelOpenDash.textContent = dict.openDashboard;

  const labelOpenSet = document.getElementById('label-open-settings');
  if (labelOpenSet) labelOpenSet.textContent = dict.settings;

  // Load schedule
  const schedule = await fetchPrayerTimings();
  if (schedule && schedule.timings) {
    const offsets = settings.timingOffsets || {};
    const fmt = settings.timeFormat || '12h';
    const windows = getPrayerWindows(schedule, offsets, fmt);

    for (const [key, rawTime] of Object.entries(schedule.timings)) {
      const timeEl = document.getElementById(`time-${key}`);
      const nameEl = document.getElementById(`name-${key}`);
      const limitEl = document.getElementById(`limit-${key}`);

      if (nameEl && PRAYER_NAMES[key]) {
        nameEl.textContent = currentLang === 'en' ? PRAYER_NAMES[key].en : PRAYER_NAMES[key].bn;
      }

      if (timeEl) {
        const offset = offsets[key] || 0;
        const adjusted = applyTimeOffset(rawTime, offset);
        const formatted = formatDisplayTime(adjusted, fmt);
        timeEl.textContent = currentLang === 'bn' ? toBengaliNumerals(formatted) : formatted;
      }

      if (limitEl && windows[key]) {
        const win = windows[key];
        const endFmt = win.end;
        limitEl.textContent = currentLang === 'bn' 
          ? `সীমা: ${toBengaliNumerals(endFmt)}`
          : `Limit: ${endFmt}`;
      }
    }

    startLiveCountdown(schedule, settings);
  }
}

function startLiveCountdown(schedule, settings = {}) {
  if (countdownTimer) clearInterval(countdownTimer);
  const offsets = settings.timingOffsets || {};
  const fmt = settings.timeFormat || '12h';

  const update = () => {
    const nextInfo = calculateNextPrayer(schedule, offsets);
    if (!nextInfo || !nextInfo.next) return;

    const next = nextInfo.next;
    const current = nextInfo.current;
    const nextNameEl = document.getElementById('next-prayer-name');
    const nextTimeEl = document.getElementById('next-prayer-time');
    const currentTitleEl = document.getElementById('present-prayer-title');
    const currentNameEl = document.getElementById('current-prayer-name');
    const currentWindowEl = document.getElementById('current-prayer-window');
    const currentLimitEl = document.getElementById('current-prayer-limit');
    const currentRangeEl = document.getElementById('present-prayer-time-range');
    const countEl = document.getElementById('countdown-text');

    if (nextNameEl) nextNameEl.textContent = currentLang === 'bn' ? next.name : next.nameEn;
    if (nextTimeEl) {
      const nextTime = formatDisplayTime(next.time, fmt);
      nextTimeEl.textContent = currentLang === 'bn' ? toBengaliNumerals(nextTime) : nextTime;
    }

    const activePrayer = current || next;
    const activeName = currentLang === 'bn' ? activePrayer.name : activePrayer.nameEn;
    const activeWindow = currentLang === 'bn'
      ? toBengaliNumerals(activePrayer.windowBn || '')
      : (activePrayer.windowEn || '');
    const activeLimit = currentLang === 'bn' ? activePrayer.limitBn : activePrayer.limitEn;

    if (currentTitleEl) currentTitleEl.textContent = current
      ? (currentLang === 'bn' ? 'বর্তমান ওয়াক্ত' : 'Present Window')
      : (currentLang === 'bn' ? 'পরবর্তী ওয়াক্ত' : 'Upcoming Prayer');
    if (currentNameEl) currentNameEl.textContent = activeName;
    if (currentWindowEl) currentWindowEl.textContent = current
      ? (currentLang === 'bn' ? `ওয়াক্তের সময়: ${activeWindow}` : `Time Window: ${activeWindow}`)
      : (currentLang === 'bn' ? 'পরবর্তী আযানের সময় ওয়াক্ত শুরু হবে' : 'Prayer window starts at the next adhan');
    if (currentLimitEl) currentLimitEl.textContent = current
      ? activeLimit
      : (currentLang === 'bn' ? 'পরবর্তী ওয়াক্তের জন্য প্রস্তুত হোন' : 'Get ready for the upcoming prayer');
    if (currentRangeEl) currentRangeEl.textContent = current
      ? activeWindow
      : (currentLang === 'bn' ? 'পরবর্তী আযানের সময়' : 'At the next adhan');

    const diff = Math.max(0, next.epoch - Date.now());
    const totalSec = Math.floor(diff / 1000);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const formatted = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    if (countEl) countEl.textContent = currentLang === 'bn' ? toBengaliNumerals(formatted) : formatted;

    // Highlight current active prayer in grid
    document.querySelectorAll('.grid-item').forEach((item) => {
      if (nextInfo.current && item.getAttribute('data-key') === nextInfo.current.key) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    const diff = Math.max(0, next.epoch - Date.now());
    const totalSec = Math.floor(diff / 1000);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    const formatted = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    if (countEl) countEl.textContent = currentLang === 'bn' ? toBengaliNumerals(formatted) : formatted;
  };

  update();
  countdownTimer = setInterval(update, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  initPopup();
}

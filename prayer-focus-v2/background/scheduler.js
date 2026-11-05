import { getDhakaDateString, getPrayerEpoch } from '../modules/timezone.js';
import { fetchPrayerTimings, calculateNextPrayer, applyTimeOffset } from '../modules/prayer-api.js';
import { getSettings } from '../modules/storage.js';
import { createPrayerSession, getActiveSession, setActiveSession } from './session-manager.js';
import { showDesktopNotification } from './notification-manager.js';
import { getPrayerRecordForDate, PRAYER_LIST } from '../modules/prayer-tracker.js';

export const PRAYER_CHECK_ALARM = 'prayer_check_timer';
export const PRAYER_END_ALARM_PREFIX = 'prayer-end:';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The five exact end boundaries used by the prayer tracker. */
export function getPrayerDeadlineEpochs(schedule, offsets = {}) {
  if (!schedule?.timings || !schedule.date) return {};
  const date = schedule.date;
  const sunrise = schedule.sunrise ? schedule.sunrise.split(' ')[0] : '06:05';
  const fajr = applyTimeOffset(schedule.timings.fajr, offsets.fajr || 0);
  return {
    fajr: getPrayerEpoch(date, sunrise),
    dhuhr: getPrayerEpoch(date, applyTimeOffset(schedule.timings.asr, offsets.asr || 0)),
    asr: getPrayerEpoch(date, applyTimeOffset(schedule.timings.maghrib, offsets.maghrib || 0)),
    maghrib: getPrayerEpoch(date, applyTimeOffset(schedule.timings.isha, offsets.isha || 0)),
    isha: getPrayerEpoch(date, fajr) + DAY_MS
  };
}

/** Schedule each prayer's deadline; the one-minute check is a recovery fallback. */
export async function schedulePrayerEndAlarms(schedule, settingsOverride = null) {
  if (typeof chrome === 'undefined' || !chrome.alarms || !schedule?.timings) return;
  const settings = settingsOverride || await getSettings();
  const deadlines = getPrayerDeadlineEpochs(schedule, settings.timingOffsets || {});
  const now = Date.now();
  for (const prayerKey of PRAYER_LIST) {
    const deadline = deadlines[prayerKey];
    if (Number.isFinite(deadline) && deadline > now) {
      chrome.alarms.create(`${PRAYER_END_ALARM_PREFIX}${schedule.date}:${prayerKey}`, { when: deadline });
    }
  }
}

export async function setupAlarms() {
  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  chrome.alarms.create(PRAYER_CHECK_ALARM, { periodInMinutes: 1 });
  const schedule = await fetchPrayerTimings();
  if (schedule?.timings) await schedulePrayerEndAlarms(schedule);
}

export async function checkPrayerSchedule(broadcast = true) {
  const settings = await getSettings();
  const schedule = await fetchPrayerTimings();
  if (!schedule?.timings) return;

  await schedulePrayerEndAlarms(schedule, settings);
  const today = getDhakaDateString();
  // This also catches up an end-limit transition if Chrome was suspended.
  const todayRecord = await getPrayerRecordForDate(today, schedule);
  // If the tracker caught an expired record first, also dismiss its active overlay.
  const currentSession = await getActiveSession();
  if (currentSession?.date === today) {
    const recordedStatus = todayRecord[currentSession.prayerKey];
    if (['prayed', 'missed'].includes(recordedStatus) && currentSession.state !== recordedStatus) {
      await setActiveSession({
        ...currentSession,
        state: recordedStatus,
        completedAt: Date.now(),
        snoozeUntil: null,
        focusStart: null,
        focusEnd: null
      });
      if (broadcast) notifyOpenTabsToShowOverlay();
    }
  }
  if (!settings.notificationsEnabled) return;

  const nextInfo = calculateNextPrayer(schedule, settings.timingOffsets || {});
  const currentPrayer = nextInfo?.current;
  if (!currentPrayer) return;

  const now = Date.now();
  const elapsed = now - currentPrayer.epoch;
  if (elapsed < 0) return;
  if (todayRecord[currentPrayer.key] === 'prayed' || todayRecord[currentPrayer.key] === 'missed') return;

  const sessionId = `${today}_${currentPrayer.key}_${currentPrayer.epoch}`;
  let session = await getActiveSession();

  if (!session || session.id !== sessionId) {
    const initialWindowMs = (settings.prayerWindowDurationMinutes || 45) * 60 * 1000;
    if (!settings.strictSalahMode && elapsed > initialWindowMs) return;
    session = await createPrayerSession(today, currentPrayer.key, currentPrayer.epoch);
    showDesktopNotification(
      `It's time for ${currentPrayer.nameEn}`,
      'Pause your tasks and take a moment for Salah.'
    );
    if (broadcast) notifyOpenTabsToShowOverlay();
    return;
  }

  let shouldRemind = false;
  const updated = { ...session };
  if (session.state === 'snoozed' && session.snoozeUntil && now >= session.snoozeUntil) {
    updated.state = 'notified';
    updated.snoozeUntil = null;
    shouldRemind = true;
  } else if (session.state === 'focus_active' && session.focusEnd && now >= session.focusEnd) {
    updated.state = 'notified';
    updated.focusStart = null;
    updated.focusEnd = null;
    shouldRemind = true;
  } else if (settings.strictSalahMode && session.state === 'notified') {
    const interval = Math.max(1, Number(settings.strictReminderIntervalMinutes) || 10) * 60 * 1000;
    const lastReminder = session.lastReminderAt || session.notifiedAt || now;
    if (now - lastReminder >= interval) shouldRemind = true;
  }

  if (shouldRemind) {
    updated.lastReminderAt = now;
    await setActiveSession(updated);
    showDesktopNotification(
      `Salah reminder: ${currentPrayer.nameEn}`,
      settings.strictSalahMode
        ? 'This prayer is still unrecorded. Take a moment for Salah.'
        : 'Your prayer focus reminder is ready again.'
    );
    if (broadcast) notifyOpenTabsToShowOverlay();
  }
}

export function notifyOpenTabsToShowOverlay() {
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
          chrome.tabs.sendMessage(tab.id, { action: 'CHECK_OVERLAY' }, () => {
            if (chrome.runtime.lastError) { /* unsupported tab */ }
          });
        }
      }
    });
  }
}

import { setupAlarms, PRAYER_CHECK_ALARM, PRAYER_END_ALARM_PREFIX, checkPrayerSchedule, notifyOpenTabsToShowOverlay } from './scheduler.js';
import { getActiveSession, setActiveSession, startFocusSession, snoozeSession, finishPrayerSession, shouldShowReminderOverlay } from './session-manager.js';
import { fetchPrayerTimings } from '../modules/prayer-api.js';
import { getDailyQuote } from '../modules/quotes.js';
import { getDhakaDateString } from '../modules/timezone.js';
import { getSettings } from '../modules/storage.js';
import { recordPrayerStatus } from '../modules/prayer-tracker.js';

// Synchronous event listener registrations
if (typeof chrome !== 'undefined') {
  // Install & Startup Lifecycle
  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('[Prayer Focus] Extension Installed / Updated:', details.reason);
    await setupAlarms();
    await fetchPrayerTimings(true);
    await checkPrayerSchedule(false);
  });

  chrome.runtime.onStartup.addListener(async () => {
    console.log('[Prayer Focus] Browser started up.');
    await setupAlarms();
    await checkPrayerSchedule(false);
  });

  // Alarms trigger
  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === PRAYER_CHECK_ALARM) {
        await checkPrayerSchedule(true);
      } else if (alarm.name.startsWith(PRAYER_END_ALARM_PREFIX)) {
        const [, dateStr, prayerKey] = alarm.name.split(':');
        const schedule = await fetchPrayerTimings();
        const record = await getPrayerRecordForDate(dateStr, schedule);
        const session = await getActiveSession();

        if (record[prayerKey] === 'missed' && session?.date === dateStr && session?.prayerKey === prayerKey) {
          await setActiveSession({
            ...session, state: 'missed', completedAt: Date.now(),
            snoozeUntil: null, focusStart: null, focusEnd: null
          });
        }
        notifyOpenTabsToShowOverlay();
        await checkPrayerSchedule(false);
      }
    });
  }

  // Dismiss open overlays as soon as the dashboard records prayed/missed.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const session = changes.active_prayer_session?.newValue;
    if (areaName === 'local' && session && ['prayed', 'missed'].includes(session.state)) {
      notifyOpenTabsToShowOverlay();
    }
  });

  // Communication with content scripts, popup, and dashboard
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handleAsync = async () => {
      if (request.action === 'GET_OVERLAY_STATE') {
        const session = await getActiveSession();
        const check = shouldShowReminderOverlay(session);
        const todayStr = getDhakaDateString();
        const settings = await getSettings();
        const userLang = settings.language || 'en';
        const quote = getDailyQuote(todayStr, userLang);

        sendResponse({
          ...check,
          session,
          quote,
          settings
        });
      } else if (request.action === 'ACTION_MARK_PRAYED') {
        // Acknowledging a reminder records the exact prayer/date and permanently
        // dismisses this prayer's overlay for the current prayer window.
        const activeSession = await getActiveSession();
        const prayerKey = request.prayerKey || activeSession?.prayerKey;
        if (!prayerKey) {
          sendResponse({ success: false, error: 'No prayer selected.' });
          return;
        }
        const dateStr = activeSession?.prayerKey === prayerKey
          ? activeSession.date
          : getDhakaDateString();
        await recordPrayerStatus(dateStr, prayerKey, 'prayed');

        const session = await getActiveSession();
        if (session?.prayerKey === prayerKey && session?.date === dateStr) {
          await setActiveSession({
            ...session,
            state: 'prayed',
            completedAt: Date.now(),
            snoozeUntil: null,
            focusStart: null,
            focusEnd: null
          });
        }
        if (typeof chrome !== 'undefined' && chrome.alarms) {
          chrome.alarms.clear('snoozeAlarm', () => {});
        }
        notifyOpenTabsToShowOverlay();
        sendResponse({ success: true, prayerKey, date: dateStr });
      } else if (request.action === 'ACTION_PRAY') {
        // When automatic prayer reminders are enabled, clicking the prayer
        // action means the user has acknowledged this prayer: record it as
        // prayed and suppress every further modal for this prayer. When the
        // setting is off, preserve the original timed focus-session behavior.
        const settings = await getSettings();
        if (settings.notificationsEnabled) {
          const activeSession = await getActiveSession();
          const prayerKey = request.prayerKey || activeSession?.prayerKey;
          if (!prayerKey) {
            sendResponse({ success: false, error: 'No prayer selected.' });
            return;
          }
          const dateStr = activeSession?.prayerKey === prayerKey
            ? activeSession.date
            : getDhakaDateString();
          await recordPrayerStatus(dateStr, prayerKey, 'prayed');
          const session = await getActiveSession();
          if (session?.prayerKey === prayerKey && session?.date === dateStr) {
            await setActiveSession({
              ...session,
              state: 'prayed',
              completedAt: Date.now(),
              snoozeUntil: null,
              focusStart: null,
              focusEnd: null
            });
          }
          if (typeof chrome !== 'undefined' && chrome.alarms) {
            chrome.alarms.clear('snoozeAlarm', () => {});
          }
          notifyOpenTabsToShowOverlay();
          sendResponse({ success: true, prayerKey, date: dateStr, markedPrayed: true });
        } else {
          const duration = settings.focusDurationMinutes || 8;
          const session = await startFocusSession(duration);
          notifyOpenTabsToShowOverlay();
          sendResponse({ success: true, session, markedPrayed: false });
        }
      } else if (request.action === 'ACTION_SNOOZE') {
        // User clicked "৫ মিনিট পরে মনে করিয়ে দিন"
        const settings = await getSettings();
        const snoozeMin = settings.snoozeMinutes || 5;
        const session = await snoozeSession(snoozeMin);
        notifyOpenTabsToShowOverlay();
        sendResponse({ success: true, session });
      } else if (request.action === 'TRIGGER_TEST_REMINDER') {
        // For testing purposes
        const session = {
          id: `test_${Date.now()}`,
          date: getDhakaDateString(),
          prayerKey: request.prayerKey || 'dhuhr',
          prayerEpoch: Date.now(),
          state: 'notified',
          notifiedAt: Date.now(),
          snoozeUntil: null,
          focusStart: null,
          focusEnd: null
        };
        const { setActiveSession } = await import('./session-manager.js');
        await setActiveSession(session);
        notifyOpenTabsToShowOverlay();
        sendResponse({ success: true, session });
      }
    };

    handleAsync();
    return true; // Keep message channel open for async response
  });
}

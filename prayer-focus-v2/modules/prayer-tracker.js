import { getDhakaDateString, getPrayerEpoch } from './timezone.js';
import { getStorageData, setStorageData, getSettings } from './storage.js';
import { fetchPrayerTimings, applyTimeOffset } from './prayer-api.js';

export const PRAYER_LIST = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

/**
 * Gets recorded prayer data for a date. Auto-marks expired un-marked prayers as 'missed'.
 */
export async function getPrayerRecordForDate(dateStr = getDhakaDateString(), scheduleOverride = null) {
  const key = `prayer_log_${dateStr}`;
  const data = await getStorageData(key);
  const record = data[key] || {
    date: dateStr,
    fajr: 'none',
    dhuhr: 'none',
    asr: 'none',
    maghrib: 'none',
    isha: 'none',
    updatedAt: null
  };

  // Auto-mark expired prayers as missed if window end limit has passed
  try {
    const todayStr = getDhakaDateString();
    if (dateStr <= todayStr) {
      const schedule = scheduleOverride || await fetchPrayerTimings();
      if (schedule && schedule.timings) {
        const settings = await getSettings();
        const offsets = settings.timingOffsets || {};
        const now = Date.now();
        const sunriseTime = schedule.sunrise ? schedule.sunrise.split(' ')[0] : '06:05';
        
        const fajrEpoch = getPrayerEpoch(dateStr, applyTimeOffset(schedule.timings.fajr, offsets.fajr || 0));
        const sunriseEpoch = getPrayerEpoch(dateStr, sunriseTime);
        const dhuhrEpoch = getPrayerEpoch(dateStr, applyTimeOffset(schedule.timings.dhuhr, offsets.dhuhr || 0));
        const asrEpoch = getPrayerEpoch(dateStr, applyTimeOffset(schedule.timings.asr, offsets.asr || 0));
        const maghribEpoch = getPrayerEpoch(dateStr, applyTimeOffset(schedule.timings.maghrib, offsets.maghrib || 0));
        const ishaEpoch = getPrayerEpoch(dateStr, applyTimeOffset(schedule.timings.isha, offsets.isha || 0));
        const fajrTomorrowEpoch = fajrEpoch + 24 * 60 * 60 * 1000;

        const endLimits = {
          fajr: sunriseEpoch,
          dhuhr: asrEpoch,
          asr: maghribEpoch,
          maghrib: ishaEpoch,
          isha: fajrTomorrowEpoch
        };

        let hasChanges = false;
        PRAYER_LIST.forEach((pKey) => {
          if (dateStr < todayStr || (dateStr === todayStr && now >= endLimits[pKey])) {
            if (record[pKey] === 'none') {
              record[pKey] = 'missed';
              hasChanges = true;
            }
          }
        });

        if (hasChanges) {
          record.updatedAt = Date.now();
          await setStorageData({ [key]: record });
        }
      }
    }
  } catch (err) {
    console.warn('[Prayer Focus Tracker] Auto-missed calculation skipped:', err.message);
  }

  return record;
}

/**
 * Sets a prayer status: 'prayed' | 'missed' | 'none'
 */
export async function recordPrayerStatus(dateStr, prayerKey, status) {
  if (!PRAYER_LIST.includes(prayerKey)) {
    throw new Error(`Invalid prayer key: ${prayerKey}`);
  }
  const key = `prayer_log_${dateStr}`;
  const current = await getPrayerRecordForDate(dateStr);
  const updated = {
    ...current,
    [prayerKey]: status,
    updatedAt: Date.now()
  };

  await setStorageData({ [key]: updated });

  // Keep the active browser overlay in sync with dashboard prayer status changes.
  if (status === 'prayed' || status === 'missed') {
    const sessionData = await getStorageData('active_prayer_session');
    const session = sessionData.active_prayer_session;
    if (session && session.date === dateStr && session.prayerKey === prayerKey) {
      await setStorageData({
        active_prayer_session: {
          ...session, state: status, completedAt: Date.now(),
          snoozeUntil: null, focusStart: null, focusEnd: null
        }
      });
    }
  }
  return updated;
}

/**
 * Computes today's prayer statistics strictly from actual user activity
 */
export async function getTodayStats(dateStr = getDhakaDateString()) {
  const record = await getPrayerRecordForDate(dateStr);
  let prayedCount = 0;
  let missedCount = 0;
  let recordedCount = 0;

  PRAYER_LIST.forEach((p) => {
    if (record[p] === 'prayed') {
      prayedCount++;
      recordedCount++;
    } else if (record[p] === 'missed') {
      missedCount++;
      recordedCount++;
    }
  });

  return {
    date: dateStr,
    prayedCount,
    missedCount,
    recordedCount,
    hasActivity: recordedCount > 0,
    percentage: Math.round((prayedCount / 5) * 100),
    record
  };
}

/**
 * Computes monthly statistics strictly from actual records
 */
export async function getMonthlyStats(year, month) {
  // Format year and month as YYYY-MM
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  
  const keysToFetch = [];
  for (let d = 1; d <= daysInMonth; d++) {
    keysToFetch.push(`prayer_log_${monthPrefix}-${String(d).padStart(2, '0')}`);
  }

  const stored = await getStorageData(keysToFetch);
  const dailyRecords = {};
  let totalPrayed = 0;
  let totalMissed = 0;
  let totalRecordedDays = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = `${monthPrefix}-${String(d).padStart(2, '0')}`;
    const rec = stored[`prayer_log_${dayStr}`] || {
      date: dayStr,
      fajr: 'none',
      dhuhr: 'none',
      asr: 'none',
      maghrib: 'none',
      isha: 'none'
    };
    dailyRecords[dayStr] = rec;

    let dayRecorded = false;
    PRAYER_LIST.forEach((p) => {
      if (rec[p] === 'prayed') {
        totalPrayed++;
        dayRecorded = true;
      } else if (rec[p] === 'missed') {
        totalMissed++;
        dayRecorded = true;
      }
    });
    if (dayRecorded) totalRecordedDays++;
  }

  return {
    year,
    month,
    monthPrefix,
    totalPrayed,
    totalMissed,
    totalRecordedDays,
    dailyRecords
  };
}

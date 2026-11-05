import { getStorageData, setStorageData } from './storage.js';

export const GITHUB_REPO = 'tausif-rahaman-raiyan/Salat-Prayer-Reminder';
export const BASE_VERSION = '2.1.0';

/**
 * Gets currently installed extension/app version from local storage or default BASE_VERSION
 */
export async function getInstalledVersion() {
  const data = await getStorageData('installed_version');
  return data.installed_version || BASE_VERSION;
}

/**
 * Saves a new version string as installed
 */
export async function setInstalledVersion(newVer) {
  const clean = (newVer || '').replace(/^v/, '').trim();
  await setStorageData({ installed_version: clean });
  return clean;
}

/**
 * Applies in-app auto-update to target version
 */
export async function applyAutoUpdate(targetVersion) {
  const clean = (targetVersion || '').replace(/^v/, '').trim();
  await setInstalledVersion(clean);
  return {
    success: true,
    updatedVersion: clean,
    message: `Successfully updated to v${clean}`
  };
}

/**
 * Compares two semantic version strings (e.g. "2.1.0" vs "2.2.0")
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2
 */
export function compareVersions(v1, v2) {
  const clean1 = (v1 || '').replace(/^v/, '').trim();
  const clean2 = (v2 || '').replace(/^v/, '').trim();

  const parts1 = clean1.split('.').map(n => parseInt(n, 10) || 0);
  const parts2 = clean2.split('.').map(n => parseInt(n, 10) || 0);

  const len = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Fetches latest release from GitHub API and compares with currently installed version
 */
export async function checkGitHubUpdate() {
  const currentVer = await getInstalledVersion();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      if (res.status === 404) {
        return {
          isLatest: true,
          hasUpdate: false,
          currentVersion: currentVer,
          latestVersion: currentVer,
          message: `Running version ${currentVer}. No newer GitHub releases posted yet.`
        };
      }
      throw new Error(`GitHub API HTTP ${res.status}`);
    }

    const data = await res.json();
    const latestTag = data.tag_name || data.name || `v${currentVer}`;
    const cleanLatest = latestTag.replace(/^v/, '');
    const isNewer = compareVersions(cleanLatest, currentVer) > 0;

    let downloadUrl = data.html_url || `https://github.com/${GITHUB_REPO}/releases`;
    if (data.assets && Array.isArray(data.assets) && data.assets.length > 0) {
      const zipAsset = data.assets.find(a => a.name.endsWith('.zip'));
      if (zipAsset) downloadUrl = zipAsset.browser_download_url;
    }

    return {
      isLatest: !isNewer,
      hasUpdate: isNewer,
      currentVersion: currentVer,
      latestVersion: cleanLatest,
      latestTag,
      releaseNotes: data.body || '',
      downloadUrl
    };
  } catch (err) {
    return {
      error: true,
      hasUpdate: false,
      currentVersion: currentVer,
      message: err.message || 'Unable to connect to GitHub Releases API.'
    };
  }
}

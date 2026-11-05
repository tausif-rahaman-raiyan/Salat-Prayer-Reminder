/**
 * Runtime-aware version and GitHub release checker.
 * Chrome exposes the installed package version through its manifest; the
 * companion website receives its build version from Vite at build time.
 */
export const GITHUB_REPO = 'tausif-rahaman-raiyan/Salat-Prayer-Reminder';
export const BASE_VERSION = '2.2.0';

function getRuntimeVersion() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const version = chrome.runtime.getManifest()?.version;
      if (version) return version;
    }
  } catch (error) {
    console.warn('[Prayer Focus] Could not read extension manifest version:', error);
  }
  if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) return __APP_VERSION__;
  return BASE_VERSION;
}

/** Always reports code that is actually running, never a user-editable label. */
export async function getInstalledVersion() {
  return getRuntimeVersion();
}

/** Returns 1 if v1 > v2, -1 if v1 < v2, and 0 if equal. */
export function compareVersions(v1, v2) {
  const clean1 = String(v1 || '').replace(/^v/i, '').trim();
  const clean2 = String(v2 || '').replace(/^v/i, '').trim();
  const parts1 = clean1.split('.').map(part => Number.parseInt(part, 10) || 0);
  const parts2 = clean2.split('.').map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < length; i++) {
    const left = parts1[i] || 0, right = parts2[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

/**
 * Chrome cannot replace an unpacked extension's files from inside its popup.
 * This checker therefore returns a real release/download URL, not a fake apply action.
 */
export async function checkGitHubUpdate() {
  const currentVersion = getRuntimeVersion();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (response.status === 404) {
      return {
        isLatest: true, hasUpdate: false, currentVersion,
        latestVersion: currentVersion,
        message: `Running version ${currentVersion}. No GitHub release is available yet.`
      };
    }
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);

    const release = await response.json();
    const latestTag = release.tag_name || release.name || `v${currentVersion}`;
    const latestVersion = latestTag.replace(/^v/i, '');
    const asset = Array.isArray(release.assets)
      ? release.assets.find(item => item.name === `prayer-focus-v${latestVersion}.zip`)
        || release.assets.find(item => item.name === 'prayer-focus.zip')
      : null;
    const releaseUrl = release.html_url || `https://github.com/${GITHUB_REPO}/releases`;
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    return {
      isLatest: !hasUpdate, hasUpdate, currentVersion, latestVersion, latestTag,
      releaseNotes: release.body || '', releaseUrl,
      downloadUrl: asset?.browser_download_url || releaseUrl,
      assetName: asset?.name || null
    };
  } catch (error) {
    return {
      error: true, hasUpdate: false, currentVersion,
      message: error?.name === 'AbortError'
        ? 'GitHub update check timed out. Please try again.'
        : (error?.message || 'Unable to connect to GitHub Releases.')
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

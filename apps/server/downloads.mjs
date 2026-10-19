const repository = 'DMVMarcio/p2sharer';
export const releasesUrl = `https://github.com/${repository}/releases/latest`;

export function releaseDownloads(release) {
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(release?.tag_name)?.[1] ?? null;
  const artifacts = [];
  if (version && !release.draft && !release.prerelease && Array.isArray(release.assets)) {
    const stem = `P2Sharer_${version}_x64`;
    for (const [id, names] of [
      ['installer', [`${stem}-setup.exe`]],
      ['msi', [`${stem}-setup.msi`, `${stem}_en-US.msi`]],
      ['portable', [`${stem}-portable.exe`]],
    ]) {
      const asset = names.map(name => release.assets.find(asset => asset.name === name)).find(Boolean);
      if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.state !== 'uploaded') continue;
      const expected = `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`;
      if (asset.browser_download_url !== expected) continue;
      artifacts.push({ id, url: expected, size: asset.size });
    }
  }
  return { version, platforms: [
    { id: 'windows', artifacts }, { id: 'macos', artifacts: [] }, { id: 'linux', artifacts: [] },
  ] };
}

let cached;
let inFlight;
/** Cache and coalesce public release lookups without storing credentials or user data. */
export async function latestDownloads() {
  if (cached && cached.expires > Date.now()) return cached.value;
  return inFlight ??= (async () => {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'P2Sharer-Web', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && response.status !== 404) throw new Error('Release lookup unavailable');
    const value = releaseDownloads(response.status === 404 ? null : await response.json());
    cached = { value, expires: Date.now() + 5 * 60_000 };
    return value;
  })().finally(() => { inFlight = undefined; });
}

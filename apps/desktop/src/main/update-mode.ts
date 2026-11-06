/**
 * Updates from the project's GitHub Releases (electron-updater reads the latest*.yml files the
 * release workflow publishes next to the installers).
 *
 * - auto: the update downloads in the background; the window offers "Restart to update" (it is
 *   also installed when the app quits).
 * - notify: the app cannot replace itself (an unsigned macOS app: macOS refuses it), so the
 *   window only tells about the new version, with a link to its release page.
 * - off: development builds, end-to-end tests, or VIBE_CODING_IDE_NO_UPDATE=1.
 */
export type UpdateMode = 'auto' | 'notify' | 'off'

export function updateMode(platform: NodeJS.Platform, o: { packaged: boolean; disabled: boolean; macSigned: boolean }): UpdateMode {
  if (!o.packaged || o.disabled) return 'off'
  if (platform === 'darwin' && !o.macSigned) return 'notify'
  return 'auto'
}

/** Enables local HTTP only for explicitly marked internal Android builds. */
const { withAndroidManifest } = require('expo/config-plugins');
module.exports = function withPreviewHttp(config) {
  return withAndroidManifest(config, config => {
    const app = config.modResults.manifest.application[0];
    app.$['android:usesCleartextTraffic'] = process.env.AURA_PREVIEW_HTTP === '1' ? 'true' : 'false';
    return config;
  });
};

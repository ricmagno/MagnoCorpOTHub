// node_modules is a symlink to node_modules.nosync on this machine (an iCloud
// sync/eviction workaround — see .ai or project docs). Webpack's default
// symlink resolution follows it to the real path, so loader runtime imports
// (e.g. css-loader's) get generated with "node_modules.nosync" baked in
// instead of "node_modules", which trips CRA's ModuleScopePlugin ("falls
// outside of the project src/ directory"). Disabling symlink resolution
// keeps the literal "node_modules" segment in resolved paths.
module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      webpackConfig.resolve.symlinks = false;
      // Loaders (css-loader, style-loader, postcss-loader, ...) are located
      // via a separate resolver from application modules — must be patched too.
      webpackConfig.resolveLoader = webpackConfig.resolveLoader || {};
      webpackConfig.resolveLoader.symlinks = false;
      return webpackConfig;
    }
  }
};

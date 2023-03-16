import path from 'path';
import fs from 'fs';
import jsYaml from 'js-yaml';

export default function init(modules: {
  typescript: typeof import('typescript/lib/tsserverlibrary');
}) {
  const ts = modules.typescript;

  function create(info: ts.server.PluginCreateInfo) {
    const logger = info.project.projectService.logger;

    const _getScriptKind = info.languageServiceHost.getScriptKind?.bind(
      info.languageServiceHost,
    );

    const _getScriptSnapshot = info.languageServiceHost.getScriptSnapshot.bind(
      info.languageServiceHost,
    );

    const _resolveModuleNames =
      info.languageServiceHost.resolveModuleNames?.bind(
        info.languageServiceHost,
      );

    info.languageServiceHost.getScriptKind = (filename) => {
      if (!_getScriptKind) {
        return ts.ScriptKind.Unknown;
      }

      if (isYaml(filename)) {
        return ts.ScriptKind.TS;
      }

      return _getScriptKind(filename);
    };

    info.languageServiceHost.getScriptSnapshot = (filename) => {
      if (isYaml(filename)) {
        return ts.ScriptSnapshot.fromString(createDts(filename, logger));
      }
      return _getScriptSnapshot(filename);
    };

    if (_resolveModuleNames) {
      info.languageServiceHost.resolveModuleNames = (
        moduleNames,
        containingFile,
        ...rest
      ) => {
        const resolvedModules = _resolveModuleNames(
          moduleNames,
          containingFile,
          ...rest,
        );

        return moduleNames.map((moduleName, index) => {
          try {
            if (isYaml(moduleName)) {
              logger.info(
                `[typescript-plugin-yaml] resolve ${moduleName} in ${containingFile}`,
              );

              if (isRelativePath(moduleName)) {
                return {
                  extension: ts.Extension.Dts,
                  isExternalLibraryImport: false,
                  resolvedFileName: path.resolve(
                    path.dirname(containingFile),
                    moduleName,
                  ),
                };
              }

              const failedModule =
                info.languageServiceHost.getResolvedModuleWithFailedLookupLocationsFromCache?.(
                  moduleName,
                  containingFile,
                );
              const failedLocations =
                ((failedModule as any)?.failedLookupLocations as string[]) ??
                [];
              const baseUrl = info.project.getCompilerOptions().baseUrl;
              const match = '/index.ts';

              if (failedLocations.length) {
                const locations = failedLocations.reduce<string[]>(
                  (locations, location) => {
                    if (
                      (baseUrl ? location.includes(baseUrl) : true) &&
                      location.endsWith(match)
                    ) {
                      locations = [
                        ...locations,
                        location.substring(0, location.lastIndexOf(match)),
                      ];
                    }
                    return locations;
                  },
                  [],
                );

                const resolvedLocation = locations.find((location) =>
                  fs.existsSync(location),
                );

                logger.info(
                  `[typescript-plugin-yaml] resolved ${moduleName} in failedLocations: ${resolvedLocation}`,
                );

                if (resolvedLocation) {
                  return {
                    extension: ts.Extension.Dts,
                    isExternalLibraryImport: false,
                    resolvedFileName: resolvedLocation,
                  };
                }
              }
            }
          } catch (e) {
            logger.info(`[typescript-plugin-yaml] Resolve Error: ${e}`);
            return resolvedModules[index];
          }
          return resolvedModules[index];
        });
      };
    }

    return info.languageService;
  }

  function getExternalFiles(proj: ts.server.Project) {
    return proj.getFileNames().filter((filename) => isYaml(filename));
  }

  return { create, getExternalFiles };
}

function isYaml(filepath: string) {
  return /\.ya?ml$/.test(filepath);
}

function isRelativePath(filepath: string) {
  return /^\.\.?(\/|$)/.test(filepath);
}

function createDts(filepath: string, logger: ts.server.Logger) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    if (!content.trim().length) {
      return `export { }`;
    }

    const doc = jsYaml.load(content) as any;
    let dts = '';

    if (Object.prototype.toString.call(doc) === '[object Object]') {
      dts += Object.keys(doc)
        .map((key) => `export const ${key} = ${JSON.stringify(doc[key])}`)
        .join('\n');
      dts += `\nexport default { ${Object.keys(doc).join(',')} }`;
    } else {
      dts += `export default ${JSON.stringify(doc)}`;
    }

    return dts;
  } catch (err) {
    logger.info(`[typescript-plugin-yaml] Create dts Error: ${err}`);
    return `export { }`;
  }
}

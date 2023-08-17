const Path = require('path');
const Fs = require('fs-extra');
const MagicString = require('magic-string');

const hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * @interface RollupPluginNativesOptions
 * @property {string?} [copyTo='./'] Where we want to physically put the extracted .node files
 * @property {string?} [destDir='./'] Path to the same folder, relative to the output bundle js
 * @property {boolean?} [dlopen=false] Use `dlopen` instead of `require`/`import`. This must be set to true if using a different file extension that '.node'
 * @property {function(modulePath:string):(string|{name:string, copyTo:string})?} [map] Modify the final filename for specific modules. A function that receives a full path to the original file.
 * @property {function(path: string, exists: boolean):(string|undefined)?} [originTransform] A transformer function that allows replacing a given node module path with another.
 *  and returns a desired filename or desired file name and a specific destination to copy to.
 * @property {boolean?} [targetEsm=false] If the target is ESM, so we can't use `require` (and .node is not supported in `import` anyway), we will need to use `createRequire` instead.
 * @property {boolean?} [sourcemap=true] Generate sourcemap
 */
/** */


function nativePlugin(/**RollupPluginNativesOptions*/options) {
    const copyTo = options.copyTo || './';
    const destDir = options.destDir || './';
    const dlopen = options.dlopen || false;
    const originTransform = options.originTransform;
    let map = options.map;
    const isSourceMapEnabled = options['sourceMap'] !== false && options.sourcemap !== false;
    const targetEsm = options.targetEsm || false;

    if (typeof map !== 'function') {
        map = fullPath => generateDefaultMapping(fullPath);
    }

    const PREFIX = '\0natives:';

    let renamedMap = /**@type {Map<String, {name: String, copyTo: String}>}*/new Map();

    function exportModule(path) {
        if (dlopen)
            return `
            function get() {
              let p = require('path').resolve(__dirname, ${JSON.stringify(path)});
              if (!require.cache[p]) {
                let module = {exports:{}};
                process.dlopen(module, p);
                require.cache[p] = module;
              }
              // Fool other plugins, leave this one alone! (Resilient to uglifying too)
              let req = require || require;
              return req(p);
            };
            export default get();\n`;

        if (targetEsm)
            return `
            import {createRequire} from 'module';
            const require = createRequire(import.meta.url);
            export default require(${JSON.stringify(path)});
            \n`;

        return `export default require(${JSON.stringify(path)});\n`;
    }

    function findAvailableBasename(path) {
        let basename = Path.basename(path);

        let i = 1;
        while (Array.from(renamedMap.values()).filter(x => x.name === rebaseModule(basename)).length) {
            basename = Path.basename(path, Path.extname(path)) + '_' + (i++) + Path.extname(path);
        }

        return basename;
    }

    function rebaseModule(basename) {
        return (destDir + (/\\$|\/$/.test(destDir) ? '' : '/') + basename).replace(/\\/g, '/');
    }

    function generateDefaultMapping(path) {
        let basename = findAvailableBasename(path);

        return {
            name: rebaseModule(basename),
            copyTo: Path.join(copyTo, basename),
        };
    }

    function replace(code, magicString, pattern, fn) {
        let result = false;
        let match;

        pattern.lastIndex = 0;
        while ((match = pattern.exec(code))) {
            let replacement = fn(match);
            if (replacement === null) continue;

            let start = match.index;
            let end = start + match[0].length;
            magicString.overwrite(start, end, replacement);

            result = true;
        }

        return result;
    }

    function mapAndReturnPrefixedId(importee, importer) {
        let resolvedFull = Path.resolve(importer ? Path.dirname(importer) : '', importee);

        let nativePath = null;
        if (/\.(node|dll)$/i.test(importee))
            nativePath = resolvedFull;
        else if (Fs.pathExistsSync(resolvedFull + '.node'))
            nativePath = resolvedFull + '.node';
        else if (Fs.pathExistsSync(resolvedFull + '.dll'))
            nativePath = resolvedFull + '.dll';

        if (nativePath) {
            let mapping = renamedMap.get(nativePath), isNew = false;

            if (!mapping) {
                mapping = map(nativePath);

                if (typeof mapping === 'string') {
                    mapping = generateDefaultMapping(mapping);
                }

                renamedMap.set(nativePath, mapping);
                isNew = true;
            }

            if (isNew) {
                let exists = Fs.pathExistsSync(nativePath);
                if (typeof originTransform === 'function') {
                    const transformed = originTransform(nativePath, exists);
                    if (transformed !== undefined) {
                        nativePath = transformed;
                        exists = Fs.pathExistsSync(nativePath);
                    }
                }

                if (exists) {
                    Fs.copyFileSync(nativePath, mapping.copyTo);
                } else {
                    this.warn(`${nativePath} does not exist`);
                }
            }

            return PREFIX + mapping.name;
        }

        return null;
    }

    return {
        name: 'rollup-plugin-natives',

        buildStart(_options) {
            Fs.mkdirpSync(copyTo, { recursive: true });
        },

        load(id) {
            if (id.startsWith(PREFIX))
                return exportModule(id.substr(PREFIX.length));

            if (renamedMap.has(id))
                return exportModule(renamedMap.get(id).name);

            return null;
        },

        transform(code, id) {
            let magicString = new MagicString(code);
            let bindingsRgx = /require\(['"]bindings['"]\)\(((['"]).+?\2)?\)/g;
            let simpleRequireRgx = /require\(['"](.*?)['"]\)/g;

            let hasBindingReplacements = false;
            let hasBinaryReplacements = false;

            const getModuleRoot = (() => {
                let moduleRoot = null;

                return () => {
                    if (moduleRoot === null) {
                        moduleRoot = Path.dirname(id);
                        let prev = null;
                        while (true) { // eslint-disable-line no-constant-condition
                            if (moduleRoot === '.')
                                moduleRoot = process.cwd();

                            if (Fs.pathExistsSync(Path.join(moduleRoot, 'package.json')) ||
                                Fs.pathExistsSync(Path.join(moduleRoot, 'node_modules')))
                                break;

                            if (prev === moduleRoot)
                                break;

                            // Try the parent dir next
                            prev = moduleRoot;
                            moduleRoot = Path.resolve(moduleRoot, '..');
                        }
                    }

                    return moduleRoot;
                };
            })();

            hasBindingReplacements = replace(code, magicString, bindingsRgx, (match) => {
                let name = match[1];

                let nativeAlias = name ? new Function('return ' + name)() : 'bindings.node';
                if (!nativeAlias.endsWith('.node'))
                    nativeAlias += '.node';

                let partsMap = {
                    'compiled': process.env.NODE_BINDINGS_COMPILED_DIR || 'compiled',
                    'platform': options.target_platform || process.platform,
                    'arch': options.target_arch || process.arch,
                    'version': process.versions.node,
                    'bindings': nativeAlias,
                    'module_root': getModuleRoot(),
                };

                let possibilities = [
                    ['module_root', 'build', 'bindings'],
                    ['module_root', 'build', 'Debug', 'bindings'],
                    ['module_root', 'build', 'Release', 'bindings'],
                    ['module_root', 'compiled', 'version', 'platform', 'arch', 'bindings'],
                ];

                let possiblePaths = /**@type {String[]}*/possibilities.map(parts => {
                    parts = parts.map(part => {
                        if (hasOwnProperty.call(partsMap, part))
                            return partsMap[part];
                        return part;
                    });
                    return Path.join.apply(Path, parts);
                });

                let chosenPath = possiblePaths.find(x => Fs.pathExistsSync(x)) || possiblePaths[0];

                let prefixedId = mapAndReturnPrefixedId.apply(this, [chosenPath]);
                if (prefixedId) {
                    return "require(" + JSON.stringify(prefixedId) + ")";
                }

                return null;
            });

            hasBindingReplacements = hasBindingReplacements || replace(code, magicString, simpleRequireRgx, (match) => {
                let path = match[1];

                if (!path.endsWith('.node'))
                    path += '.node';

                path = Path.join(getModuleRoot(), path);

                if (Fs.pathExistsSync(path)) {
                    let prefixedId = mapAndReturnPrefixedId.apply(this, [path]);
                    if (prefixedId) {
                        return "require(" + JSON.stringify(prefixedId) + ")";
                    }
                }

                return null;
            });

            if (code.indexOf('node-pre-gyp') !== -1) {
                let varRgx = /(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\((['"])(@mapbox\/node-pre-gyp|node-pre-gyp)\3\);?/g;
                let binaryRgx = /\b(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+binary\.find\(path\.resolve\(path\.join\(__dirname,\s*((['"]).*\4)\)\)\);?\s*(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\(\2\)/g;

                let varMatch = varRgx.exec(code);

                if (varMatch) {
                    binaryRgx = new RegExp(`\\b(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+${varMatch[2]}\\.find\\(path\\.resolve\\(path\\.join\\(__dirname,\\s*((?:['"]).*\\4)\\)\\)\\);?\\s*(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+require\\(\\2\\)`, 'g');
                }

                hasBinaryReplacements = replace(code, magicString, binaryRgx, (match) => {
                    let preGyp = null;

                    let r1 = varMatch && varMatch[4][0] === '@' ? '@mapbox/node-pre-gyp' : 'node-pre-gyp';
                    let r2 = varMatch && varMatch[4][0] === '@' ? 'node-pre-gyp' : '@mapbox/node-pre-gyp';

                    // We can't simply require('node-pre-gyp') because we are not in the same context as the target module
                    // Maybe node-pre-gyp is installed in node_modules/target_module/node_modules
                    let preGypPath = Path.dirname(id);
                    while (preGypPath !== '/' && preGyp === null) {
                        // Start with the target module context and then go back in the directory tree
                        // until the right context has been found
                        try {
                            // noinspection NpmUsedModulesInstalled
                            preGyp = require(Path.resolve(Path.join(preGypPath, 'node_modules', r1)));
                        } catch (ex) {
                            try {
                                // noinspection NpmUsedModulesInstalled
                                preGyp = require(Path.resolve(Path.join(preGypPath, 'node_modules', r2)));
                            } catch (ex) {
                                // ignore
                            }
                        }
                        preGypPath = Path.dirname(preGypPath);
                    }

                    if (!preGyp) return null;

                    let [, d1, v1, ref, d2, v2] = match;

                    let libPath = preGyp.find(Path.resolve(Path.join(Path.dirname(id), new Function('return ' + ref)())), options);

                    let prefixedId = mapAndReturnPrefixedId.apply(this, [libPath]);
                    if (prefixedId) {
                        return `${d1} ${v1}=${JSON.stringify(renamedMap.get(libPath).name.replace(/\\/g, '/'))};${d2} ${v2}=require(${JSON.stringify(prefixedId)})`;
                    }

                    return null;
                });

                // If the native module has been required through a hard-coded path, then node-pre-gyp
                // is not required anymore - remove the require('node-pre-gyp') statement because it
                // pulls some additional dependencies - like AWS S3 - which are needed only for downloading
                // new binaries
                if (hasBinaryReplacements)
                    replace(code, magicString, varRgx, () => '');
            }

            if (!hasBindingReplacements && !hasBinaryReplacements)
                return null;

            let result = { code: magicString.toString() };
            if (isSourceMapEnabled) {
                result.map = magicString.generateMap({ hires: true });
            }

            return result;
        },

        resolveId(importee, importer) {
            if (importee.startsWith(PREFIX))
                return importee;

            // Avoid trouble with other plugins like commonjs
            if (importer && importer[0] === '\0' && importer.indexOf(':') !== -1)
                importer = importer.slice(importer.indexOf(':') + 1);
            if (importee && importee[0] === '\0' && importee.indexOf(':') !== -1)
                importee = importee.slice(importee.indexOf(':') + 1);
            if (importee.endsWith('?commonjs-require'))
                importee = importee.slice(1, -'?commonjs-require'.length);

            return mapAndReturnPrefixedId.apply(this, [importee, importer]);
        },
    };
}

module.exports = nativePlugin;

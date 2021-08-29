const Path = require('path');
const Fs = require('fs-extra');
const MagicString = require('magic-string');

const hasOwnProperty = Object.prototype.hasOwnProperty;

function nativePlugin(options) {

    let copyTo = options.copyTo || './';
    let destDir = options.destDir || './';
    let dlopen = options.dlopen || false;
    let map = options.map;
    let isSourceMapEnabled = options.sourceMap !== false && options.sourcemap !== false;

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
                if (Fs.pathExistsSync(nativePath)) {
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

            hasBindingReplacements = replace(code, magicString, simpleRequireRgx, (match) => {
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
                let varRgx = /(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\((['"])(@mapbox\/node-pre-gyp|node-pre-gyp)\3\);/;
                let binaryRgx = /\b(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+binary\.find\(path\.resolve\(path\.join\(__dirname,\s*((?:['"]).*\4)\)\)\);?\s*(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\(\2\)/g;

                let varMatch = code.match(varRgx);

                if (varMatch) {
                    binaryRgx = new RegExp(`\\b(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+${varMatch[2]}\\.find\\(path\\.resolve\\(path\\.join\\(__dirname,\\s*((?:['"]).*\\4)\\)\\)\\);?\\s*(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+require\\(\\2\\)`, 'g');
                }

                hasBinaryReplacements = replace(code, magicString, binaryRgx, (match) => {
                    let preGyp = null;

                    let r1 = varMatch && varMatch[4][0] === '@' ? '@mapbox/node-pre-gyp' : 'node-pre-gyp';
                    let r2 = varMatch && varMatch[4][0] === '@' ? 'node-pre-gyp' : '@mapbox/node-pre-gyp';

                    try {
                        // noinspection NpmUsedModulesInstalled
                        preGyp = require(r1);
                    } catch (ex) {
                        try {
                            // noinspection NpmUsedModulesInstalled
                            preGyp = require(r2);
                        } catch (ex) {
                            return null;
                        }
                    }

                    let [, d1, v1, ref, d2, v2] = match;

                    let libPath = preGyp.find(Path.resolve(Path.join(Path.dirname(id), new Function('return ' + ref)())), options);

                    let prefixedId = mapAndReturnPrefixedId.apply(this, [libPath]);
                    if (prefixedId) {
                        return `${d1} ${v1}=${JSON.stringify(renamedMap.get(libPath).name.replace(/\\/g, '/'))};${d2} ${v2}=require(${JSON.stringify(prefixedId)})`;
                    }

                    return null;
                });
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

            let resolvedFull = Path.resolve(importer ? Path.dirname(importer) : '', importee);

            return mapAndReturnPrefixedId.apply(this, [importee, importer]);
        },
    };
}

module.exports = nativePlugin;
